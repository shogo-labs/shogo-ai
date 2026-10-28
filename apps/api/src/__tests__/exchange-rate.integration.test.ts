// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Exchange rates over real HTTP: the service talks to a local server standing
 * in for Stripe's FX Quotes API and the ECB daily reference feed.
 *
 * Production called the removed `GET /v1/exchange_rates` ("Unrecognized
 * request URL") and served a two-year-old hardcoded table for 24h at a time.
 * These tests pin the replacement: Stripe FX Quotes first, ECB for whatever
 * Stripe can't give, the hardcoded table only when both are down — and then
 * only for an hour.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { SUPPORTED_CURRENCIES } from '../config/currencies'

const TARGETS = Object.keys(SUPPORTED_CURRENCIES).filter((c) => c !== 'USD')

/** EUR-based, as the ECB publishes it. */
const ECB_PER_EUR: Record<string, number> = {
  USD: 1.125, JPY: 177.75, DKK: 7.4748, GBP: 0.84375, PLN: 4.5, SEK: 11.25, CHF: 0.9, NOK: 10.125,
  TRY: 56.25, AUD: 1.6875, BRL: 5.625, CAD: 1.575, HKD: 9, INR: 106.875, KRW: 1500, MXN: 20.25,
  NZD: 2.025, SGD: 1.4625, ZAR: 18,
}

function ecbXml(perEur: Record<string, number>): string {
  const cubes = Object.entries(perEur)
    .map(([c, r]) => `\t\t\t<Cube currency='${c}' rate='${r}'/>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
\t<Cube>
\t\t<Cube time='2026-10-16'>
${cubes}
\t\t</Cube>
\t</Cube>
</gesmes:Envelope>`
}

interface FxRequest {
  auth: string | null
  version: string | null
  form: URLSearchParams
}

let server: ReturnType<typeof Bun.serve>
const hits = { stripe: 0, ecb: 0, legacy: 0 }
const fxRequests: FxRequest[] = []
/** USD per unit, per lowercase currency; null => respond with an error. */
let stripeRates: Record<string, number> | null = null
let stripeError = { status: 400, message: 'FX Quotes is not enabled for this account' }
let ecbUp = true

let svc: typeof import('../services/exchange-rate.service')
const saved = {
  key: process.env.STRIPE_SECRET_KEY,
  base: process.env.STRIPE_API_BASE,
  ecb: process.env.ECB_RATES_URL,
}

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/v1/fx_quotes' && req.method === 'POST') {
        hits.stripe++
        const form = new URLSearchParams(await req.text())
        fxRequests.push({ auth: req.headers.get('authorization'), version: req.headers.get('stripe-version'), form })
        if (!stripeRates) {
          return Response.json({ error: { type: 'invalid_request_error', message: stripeError.message } }, { status: stripeError.status })
        }
        const rates: Record<string, unknown> = {}
        for (const from of form.getAll('from_currencies[]')) {
          const base = stripeRates[from]
          if (base === undefined) continue
          rates[from] = { exchange_rate: base * 0.98, rate_details: { base_rate: base, fx_fee_rate: 0.02 } }
        }
        return Response.json({ id: 'fxq_test', object: 'fx_quote', lock_duration: 'none', to_currency: form.get('to_currency'), rates })
      }
      if (url.pathname.startsWith('/v1/exchange_rates')) {
        hits.legacy++
        return Response.json({ error: { message: `Unrecognized request URL (GET: ${url.pathname})` } }, { status: 404 })
      }
      if (url.pathname === '/ecb/eurofxref-daily.xml') {
        hits.ecb++
        if (!ecbUp) return new Response('unavailable', { status: 503 })
        return new Response(ecbXml(ECB_PER_EUR), { headers: { 'content-type': 'text/xml' } })
      }
      return new Response('not found', { status: 404 })
    },
  })
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${server.port}`
  process.env.ECB_RATES_URL = `http://127.0.0.1:${server.port}/ecb/eurofxref-daily.xml`
  svc = await import('../services/exchange-rate.service')
})

afterAll(() => {
  server?.stop(true)
  for (const [k, env] of [['key', 'STRIPE_SECRET_KEY'], ['base', 'STRIPE_API_BASE'], ['ecb', 'ECB_RATES_URL']] as const) {
    if (saved[k] === undefined) delete process.env[env]
    else process.env[env] = saved[k]
  }
})

let warnSpy: ReturnType<typeof spyOn>
let errorSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  svc._resetExchangeRateCacheForTests()
  hits.stripe = hits.ecb = hits.legacy = 0
  fxRequests.length = 0
  ecbUp = true
  process.env.STRIPE_SECRET_KEY = 'sk_test_fx'
  // USD per unit for every target: the ECB cross-rate, nudged so a Stripe
  // value is distinguishable from an ECB one.
  stripeRates = Object.fromEntries(TARGETS.map((c) => [c.toLowerCase(), (ECB_PER_EUR.USD / (c === 'EUR' ? 1 : ECB_PER_EUR[c])) * 1.01]))
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
  errorSpy.mockRestore()
})

const ecbUsdTo = (c: string) => (c === 'EUR' ? 1 : ECB_PER_EUR[c]) / ECB_PER_EUR.USD

describe('exchange rates over HTTP', () => {
  test('asks Stripe FX Quotes for every supported currency and inverts the base rate', async () => {
    const rates = await svc.getExchangeRates()

    expect(fxRequests).toHaveLength(1)
    const req = fxRequests[0]
    expect(req.auth).toBe('Bearer sk_test_fx')
    expect(req.version).toMatch(/\.preview$/)
    expect(req.form.get('to_currency')).toBe('usd')
    expect(req.form.get('lock_duration')).toBe('none')
    expect(req.form.getAll('from_currencies[]').sort()).toEqual(TARGETS.map((c) => c.toLowerCase()).sort())

    expect(rates.USD).toBe(1)
    for (const c of TARGETS) {
      expect(rates[c]).toBeCloseTo(1 / stripeRates![c.toLowerCase()], 10)
    }
    expect(hits.ecb).toBe(0)
    expect(hits.legacy).toBe(0)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test('fills currencies Stripe did not quote from the ECB feed', async () => {
    delete stripeRates!.try
    delete stripeRates!.krw
    const rates = await svc.getExchangeRates()

    expect(rates.EUR).toBeCloseTo(1 / stripeRates!.eur, 10)
    expect(rates.TRY).toBeCloseTo(ecbUsdTo('TRY'), 10)
    expect(rates.KRW).toBeCloseTo(ecbUsdTo('KRW'), 10)
    expect(hits.ecb).toBe(1)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test('uses ECB for everything when FX Quotes is rejected, and caches that for 24h', async () => {
    stripeRates = null
    const rates = await svc.getExchangeRates()

    expect(hits.stripe).toBe(1)
    expect(hits.ecb).toBe(1)
    for (const c of TARGETS) expect(rates[c]).toBeCloseTo(ecbUsdTo(c), 10)
    expect(rates.TRY).toBeCloseTo(50, 6)
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('FX Quotes is not enabled')
    expect(errorSpy).not.toHaveBeenCalled()

    const realNow = Date.now()
    const now = spyOn(Date, 'now').mockReturnValue(realNow + 23 * 60 * 60 * 1000)
    try {
      expect(await svc.getExchangeRates()).toBe(rates)
      expect(hits.ecb).toBe(1)
    } finally {
      now.mockRestore()
    }
  })

  test('without a Stripe key goes straight to ECB', async () => {
    delete process.env.STRIPE_SECRET_KEY
    const rates = await svc.getExchangeRates()
    expect(hits.stripe).toBe(0)
    expect(hits.ecb).toBe(1)
    expect(rates.JPY).toBeCloseTo(158, 6)
  })

  test('with both sources down serves the hardcoded table for an hour, then recovers', async () => {
    stripeRates = null
    ecbUp = false
    const realNow = Date.now()
    const now = spyOn(Date, 'now').mockReturnValue(realNow)
    try {
      const fallback = await svc.getExchangeRates()
      expect(fallback.USD).toBe(1)
      for (const c of TARGETS) expect(fallback[c]).toBeGreaterThan(0)
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls[0].join(' ')).toContain('hardcoded fallback for the next hour')

      now.mockReturnValue(realNow + 59 * 60 * 1000)
      expect(await svc.getExchangeRates()).toBe(fallback)
      expect(hits.ecb).toBe(1)

      ecbUp = true
      now.mockReturnValue(realNow + 61 * 60 * 1000)
      const recovered = await svc.getExchangeRates()
      expect(hits.ecb).toBe(2)
      expect(recovered.TRY).toBeCloseTo(ecbUsdTo('TRY'), 10)
    } finally {
      now.mockRestore()
    }
  })

  test('concurrent callers share one upstream fetch', async () => {
    const all = await Promise.all(Array.from({ length: 10 }, () => svc.getExchangeRates()))
    expect(hits.stripe).toBe(1)
    for (const r of all) expect(r).toBe(all[0])
  })

  test('convertPrice applies the live rate', async () => {
    delete process.env.STRIPE_SECRET_KEY
    expect(await svc.convertPrice(100, 'eur')).toBeCloseTo(100 / 1.125, 8)
    expect(await svc.convertPrice(42.5, 'USD')).toBe(42.5)
    expect(await svc.convertPrice(100, 'XYZ')).toBe(100)
  })
})
