// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000

let retrieveImpl: () => Promise<{ rates: Record<string, number> }> = async () => ({
  rates: { eur: 0.5, gbp: 0.6, jpy: 100, foo: 999 },
})

mock.module('stripe', () => {
  class FakeStripe {
    exchangeRates = {
      retrieve: (_currency: string) => retrieveImpl(),
    }
    constructor(_key: string) {}
  }
  return { default: FakeStripe }
})

// Dynamic import so the Stripe mock is in place before the SUT loads.
const { convertPrice, getExchangeRates } = await import('../exchange-rate.service')

const originalStripeKey = process.env.STRIPE_SECRET_KEY
let warnSpy: ReturnType<typeof spyOn>
let errorSpy: ReturnType<typeof spyOn>
let nowSpy: ReturnType<typeof spyOn>

// Each test sets Date.now() to a brand-new base that is far past whatever
// the previous test cached, forcing the in-module cache to be considered
// stale and re-fetched. The base counter monotonically increases.
let tick = 1_000_000_000_000

beforeEach(() => {
  tick += CACHE_TTL_MS * 10
  nowSpy = spyOn(Date, 'now').mockReturnValue(tick)
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  retrieveImpl = async () => ({ rates: { eur: 0.5, gbp: 0.6, jpy: 100, foo: 999 } })
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
})

afterEach(() => {
  nowSpy.mockRestore()
  warnSpy.mockRestore()
  errorSpy.mockRestore()
})

afterAll(() => {
  if (originalStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY
  else process.env.STRIPE_SECRET_KEY = originalStripeKey
})

describe('getExchangeRates', () => {
  it('USD is always 1', async () => {
    const rates = await getExchangeRates()
    expect(rates.USD).toBe(1)
  })

  it('maps Stripe lowercase rate codes to uppercase SUPPORTED_CURRENCIES codes', async () => {
    const rates = await getExchangeRates()
    expect(rates.EUR).toBe(0.5)
    expect(rates.GBP).toBe(0.6)
    expect(rates.JPY).toBe(100)
  })

  it('falls back to hardcoded rate when Stripe omits a supported currency', async () => {
    retrieveImpl = async () => ({ rates: { eur: 0.5 } })
    const rates = await getExchangeRates()
    expect(rates.EUR).toBe(0.5)
    // INR is in FALLBACK_RATES but not in our fake Stripe payload.
    expect(rates.INR).toBe(83.1)
  })

  it('does not include Stripe codes that are outside SUPPORTED_CURRENCIES', async () => {
    retrieveImpl = async () => ({ rates: { foo: 999, eur: 0.5 } })
    const rates = await getExchangeRates()
    expect(rates.FOO).toBeUndefined()
    expect((rates as any).foo).toBeUndefined()
  })

  it('caches rates and skips Stripe within the 24h TTL', async () => {
    let calls = 0
    retrieveImpl = async () => {
      calls += 1
      return { rates: { eur: 0.5 } }
    }
    await getExchangeRates()
    expect(calls).toBe(1)
    // Advance time but stay within TTL — cache must still be warm.
    nowSpy.mockReturnValue(tick + CACHE_TTL_MS - 1)
    await getExchangeRates()
    expect(calls).toBe(1)
  })

  it('refetches after the 24h TTL elapses', async () => {
    let calls = 0
    retrieveImpl = async () => {
      calls += 1
      return { rates: { eur: 0.5 } }
    }
    await getExchangeRates()
    nowSpy.mockReturnValue(tick + CACHE_TTL_MS + 1)
    await getExchangeRates()
    expect(calls).toBe(2)
  })

  it('returns hardcoded FALLBACK_RATES when STRIPE_SECRET_KEY is missing', async () => {
    delete process.env.STRIPE_SECRET_KEY
    const rates = await getExchangeRates()
    expect(rates.USD).toBe(1)
    expect(rates.EUR).toBe(0.92)
    expect(rates.JPY).toBe(149.5)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('returns hardcoded FALLBACK_RATES when Stripe call throws', async () => {
    retrieveImpl = async () => {
      throw new Error('stripe down')
    }
    const rates = await getExchangeRates()
    expect(rates.USD).toBe(1)
    expect(rates.EUR).toBe(0.92)
    expect(errorSpy).toHaveBeenCalled()
  })
})

describe('convertPrice', () => {
  it('multiplies amount by the matching currency rate', async () => {
    retrieveImpl = async () => ({ rates: { eur: 0.5 } })
    expect(await convertPrice(100, 'EUR')).toBe(50)
  })

  it('is case-insensitive on the target currency code', async () => {
    retrieveImpl = async () => ({ rates: { eur: 0.5 } })
    expect(await convertPrice(100, 'eur')).toBe(50)
  })

  it('returns the input amount unchanged for USD', async () => {
    expect(await convertPrice(123.45, 'USD')).toBe(123.45)
  })

  it('returns the input amount when the target currency is unknown (rate=1)', async () => {
    retrieveImpl = async () => ({ rates: { eur: 0.5 } })
    expect(await convertPrice(42, 'XYZ')).toBe(42)
  })
})
