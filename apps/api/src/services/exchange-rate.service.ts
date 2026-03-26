// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Exchange Rate Service
 *
 * Fetches exchange rates from Stripe's Exchange Rates API and caches them
 * for 24 hours (matching Stripe Adaptive Pricing's rate guarantee window).
 * Falls back to hardcoded approximate rates if Stripe is unavailable.
 */

import Stripe from 'stripe'
import { SUPPORTED_CURRENCIES } from '../config/currencies'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

interface RateCache {
  rates: Record<string, number>
  fetchedAt: number
}

let cache: RateCache | null = null

const FALLBACK_RATES: Record<string, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  JPY: 149.5,
  CAD: 1.36,
  AUD: 1.53,
  CHF: 0.88,
  SEK: 10.5,
  NOK: 10.7,
  DKK: 6.87,
  PLN: 4.0,
  BRL: 4.97,
  MXN: 17.15,
  INR: 83.1,
  KRW: 1320,
  SGD: 1.34,
  HKD: 7.82,
  NZD: 1.67,
  ZAR: 18.6,
  TRY: 30.2,
}

function getStripeClient(): Stripe | null {
  if (!process.env.STRIPE_SECRET_KEY) return null
  return new Stripe(process.env.STRIPE_SECRET_KEY)
}

async function fetchRatesFromStripe(): Promise<Record<string, number>> {
  const stripe = getStripeClient()
  if (!stripe) {
    console.warn('[ExchangeRate] Stripe not configured, using fallback rates')
    return { ...FALLBACK_RATES }
  }

  try {
    const exchangeRate = await stripe.exchangeRates.retrieve('usd')
    const rates: Record<string, number> = { USD: 1 }

    for (const code of Object.keys(SUPPORTED_CURRENCIES)) {
      if (code === 'USD') continue
      const lowerCode = code.toLowerCase()
      if (exchangeRate.rates[lowerCode]) {
        rates[code] = exchangeRate.rates[lowerCode]
      } else if (FALLBACK_RATES[code]) {
        rates[code] = FALLBACK_RATES[code]
      }
    }

    return rates
  } catch (err) {
    console.error('[ExchangeRate] Failed to fetch from Stripe, using fallback rates:', err)
    return { ...FALLBACK_RATES }
  }
}

export async function getExchangeRates(): Promise<Record<string, number>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.rates
  }

  const rates = await fetchRatesFromStripe()
  cache = { rates, fetchedAt: Date.now() }
  return rates
}

export async function convertPrice(amountUSD: number, targetCurrency: string): Promise<number> {
  const rates = await getExchangeRates()
  const rate = rates[targetCurrency.toUpperCase()] ?? 1
  return amountUSD * rate
}
