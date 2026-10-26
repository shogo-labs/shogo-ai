// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Exchange Rate Service
 *
 * USD -> local currency rates for regional price display, from (in order):
 *
 *  1. Stripe's FX Quotes API (`POST /v1/fx_quotes`, lock_duration=none) — the
 *     rates Stripe actually converts at. Called over REST because the SDK has
 *     no binding; it needs a `.preview` API version.
 *  2. The ECB daily reference rates, for anything Stripe didn't return (or
 *     when Stripe isn't configured / the FX Quotes preview isn't enabled).
 *  3. A hardcoded table, last resort.
 *
 * Live rates are cached for 24 hours (Stripe Adaptive Pricing's rate
 * guarantee window). A result that needed the hardcoded table is cached for
 * only an hour so a transient outage doesn't pin stale prices for a day.
 *
 * Stripe removed `GET /v1/exchange_rates` (the SDK's `exchangeRates.retrieve`)
 * — production got "Unrecognized request URL" and silently served the
 * hardcoded table, by then two years stale, on every pod.
 */

import { SUPPORTED_CURRENCIES } from '../config/currencies'

const LIVE_TTL_MS = 24 * 60 * 60 * 1000
const FALLBACK_TTL_MS = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 5_000
const STRIPE_FX_QUOTES_VERSION = '2026-01-28.preview'

type RateSource = 'stripe' | 'ecb' | 'fallback'

interface RateCache {
  rates: Record<string, number>
  fetchedAt: number
  ttlMs: number
}

let cache: RateCache | null = null
let inflight: Promise<Record<string, number>> | null = null

/** ECB reference rates of 2026-10-16, rebased to USD. */
const FALLBACK_RATES: Record<string, number> = {
  USD: 1,
  EUR: 0.8887,
  GBP: 0.7499,
  JPY: 158,
  CAD: 1.416,
  AUD: 1.437,
  CHF: 0.824,
  SEK: 9.904,
  NOK: 9.441,
  DKK: 6.642,
  PLN: 3.883,
  BRL: 5.083,
  MXN: 18.38,
  INR: 94.96,
  KRW: 1332,
  SGD: 1.279,
  HKD: 7.848,
  NZD: 1.766,
  ZAR: 16.43,
  TRY: 49.53,
}

function stripeApiBase(): string {
  return process.env.STRIPE_API_BASE ?? 'https://api.stripe.com'
}

function ecbRatesUrl(): string {
  return process.env.ECB_RATES_URL ?? 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'
}

function targetCodes(): string[] {
  return Object.keys(SUPPORTED_CURRENCIES).filter((c) => c !== 'USD')
}

/**
 * One quote converting every target currency INTO usd; `base_rate` is USD per
 * unit of the currency (excluding Stripe's FX fee), so USD -> X is 1/base_rate.
 */
async function fetchStripeFxRates(secretKey: string, codes: string[]): Promise<Record<string, number>> {
  const body = new URLSearchParams({ to_currency: 'usd', lock_duration: 'none' })
  for (const code of codes) body.append('from_currencies[]', code.toLowerCase())
  const res = await fetch(`${stripeApiBase()}/v1/fx_quotes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Stripe-Version': STRIPE_FX_QUOTES_VERSION,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const json = (await res.json().catch(() => null)) as any
  if (!res.ok) {
    throw new Error(`Stripe FX Quotes ${res.status}: ${json?.error?.message ?? res.statusText}`)
  }
  const rates: Record<string, number> = {}
  for (const code of codes) {
    const quote = json?.rates?.[code.toLowerCase()]
    const usdPerUnit = quote?.rate_details?.base_rate ?? quote?.exchange_rate
    if (typeof usdPerUnit === 'number' && usdPerUnit > 0) rates[code] = 1 / usdPerUnit
  }
  return rates
}

/** The ECB daily feed is EUR-based; rebase to USD. */
async function fetchEcbRates(codes: string[]): Promise<Record<string, number>> {
  const res = await fetch(ecbRatesUrl(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`ECB reference rates ${res.status}`)
  const xml = await res.text()
  const perEur: Record<string, number> = { EUR: 1 }
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) {
    perEur[m[1]] = Number(m[2])
  }
  const usd = perEur.USD
  if (!usd) throw new Error('ECB reference rates have no USD rate')
  const rates: Record<string, number> = {}
  for (const code of codes) {
    if (perEur[code] > 0) rates[code] = perEur[code] / usd
  }
  return rates
}

async function fetchRates(): Promise<RateCache> {
  const codes = targetCodes()
  const rates: Record<string, number> = { USD: 1 }
  const sources = new Set<RateSource>()
  const missing = () => codes.filter((c) => rates[c] === undefined)

  const secretKey = process.env.STRIPE_SECRET_KEY
  if (secretKey) {
    try {
      Object.assign(rates, await fetchStripeFxRates(secretKey, codes))
      sources.add('stripe')
    } catch (err) {
      console.warn('[ExchangeRate] Stripe FX Quotes unavailable, trying ECB reference rates:', (err as Error)?.message ?? err)
    }
  }

  if (missing().length > 0) {
    try {
      Object.assign(rates, await fetchEcbRates(missing()))
      sources.add('ecb')
    } catch (err) {
      console.warn('[ExchangeRate] ECB reference rates unavailable:', (err as Error)?.message ?? err)
    }
  }

  const stillMissing = missing()
  for (const code of stillMissing) {
    if (FALLBACK_RATES[code] !== undefined) rates[code] = FALLBACK_RATES[code]
  }
  if (stillMissing.length > 0) {
    sources.add('fallback')
    console.error(
      `[ExchangeRate] no live rate for ${stillMissing.join(', ')}; using hardcoded fallback for the next hour`,
    )
  }

  return {
    rates,
    fetchedAt: Date.now(),
    ttlMs: sources.has('fallback') ? FALLBACK_TTL_MS : LIVE_TTL_MS,
  }
}

export async function getExchangeRates(): Promise<Record<string, number>> {
  if (cache && Date.now() - cache.fetchedAt < cache.ttlMs) {
    return cache.rates
  }
  if (!inflight) {
    inflight = fetchRates()
      .then((fresh) => {
        cache = fresh
        return fresh.rates
      })
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

export async function convertPrice(amountUSD: number, targetCurrency: string): Promise<number> {
  const rates = await getExchangeRates()
  const rate = rates[targetCurrency.toUpperCase()] ?? 1
  return amountUSD * rate
}

export function _resetExchangeRateCacheForTests(): void {
  cache = null
  inflight = null
}
