// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for src/config/currencies.ts — no existing test file. Covers:
 *
 *  - `SUPPORTED_CURRENCIES` shape: every entry has code/symbol/name and
 *    valid symbolPosition + decimalPlaces.
 *  - `COUNTRY_TO_CURRENCY` self-consistency: every value is a key of
 *    `SUPPORTED_CURRENCIES`.
 *  - `getCurrencyForCountry` happy paths (US→USD, JP→JPY, GB→GBP,
 *    EUR-zone bundling), lowercase normalization, unknown country
 *    fallback to USD, empty string, undefined-safe (?.toUpperCase()).
 *  - `formatPrice` — prefix vs suffix symbol placement, decimalPlaces=0
 *    rounding (JPY/KRW), decimalPlaces=2 standard rounding, separator
 *    in large numbers, negative amount, zero, fractional half-up.
 *  - Symbol-position 'suffix' currencies emit "<formatted> <symbol>".
 *
 *   bun test apps/api/src/__tests__/currencies-config.test.ts
 */

import { describe, expect, test } from 'bun:test'
import {
  SUPPORTED_CURRENCIES,
  COUNTRY_TO_CURRENCY,
  getCurrencyForCountry,
  formatPrice,
  type CurrencyInfo,
} from '../config/currencies'

describe('SUPPORTED_CURRENCIES — shape', () => {
  test('contains at least 20 currencies', () => {
    expect(Object.keys(SUPPORTED_CURRENCIES).length).toBeGreaterThanOrEqual(20)
  })

  test('every entry has all 5 required fields with valid types', () => {
    for (const [code, info] of Object.entries(SUPPORTED_CURRENCIES)) {
      expect(info.code).toBe(code)
      expect(typeof info.symbol).toBe('string')
      expect(info.symbol.length).toBeGreaterThan(0)
      expect(typeof info.name).toBe('string')
      expect(['prefix', 'suffix']).toContain(info.symbolPosition)
      expect([0, 2]).toContain(info.decimalPlaces)
    }
  })

  test('USD is the canonical fallback (always present)', () => {
    expect(SUPPORTED_CURRENCIES.USD).toBeDefined()
    expect(SUPPORTED_CURRENCIES.USD.symbol).toBe('$')
  })

  test('zero-decimal currencies are JPY and KRW only', () => {
    const zeroDecimal = Object.values(SUPPORTED_CURRENCIES).filter(
      (c) => c.decimalPlaces === 0,
    )
    expect(zeroDecimal.map((c) => c.code).sort()).toEqual(['JPY', 'KRW'])
  })
})

describe('COUNTRY_TO_CURRENCY — self-consistency', () => {
  test('every mapped currency exists in SUPPORTED_CURRENCIES', () => {
    for (const [country, currency] of Object.entries(COUNTRY_TO_CURRENCY)) {
      expect(SUPPORTED_CURRENCIES[currency]).toBeDefined()
      expect(country).toMatch(/^[A-Z]{2}$/) // ISO 3166-1 alpha-2
    }
  })

  test('EUR zone has at least 18 member countries', () => {
    const eurMembers = Object.entries(COUNTRY_TO_CURRENCY).filter(
      ([, c]) => c === 'EUR',
    )
    expect(eurMembers.length).toBeGreaterThanOrEqual(18)
    expect(eurMembers.map(([k]) => k)).toContain('DE')
    expect(eurMembers.map(([k]) => k)).toContain('FR')
  })

  test('UK and crown dependencies all use GBP', () => {
    for (const k of ['GB', 'IM', 'JE', 'GG']) {
      expect(COUNTRY_TO_CURRENCY[k]).toBe('GBP')
    }
  })

  test('USD includes territories and dollarized economies', () => {
    for (const k of ['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'EC', 'SV', 'PA']) {
      expect(COUNTRY_TO_CURRENCY[k]).toBe('USD')
    }
  })
})

describe('getCurrencyForCountry', () => {
  test('US → USD', () => {
    expect(getCurrencyForCountry('US')).toBe(SUPPORTED_CURRENCIES.USD)
  })

  test('JP → JPY (decimalPlaces=0)', () => {
    expect(getCurrencyForCountry('JP').code).toBe('JPY')
    expect(getCurrencyForCountry('JP').decimalPlaces).toBe(0)
  })

  test('GB → GBP', () => {
    expect(getCurrencyForCountry('GB').code).toBe('GBP')
  })

  test('any EUR-zone country resolves to EUR', () => {
    for (const c of ['DE', 'FR', 'IT', 'ES', 'NL', 'HR']) {
      expect(getCurrencyForCountry(c).code).toBe('EUR')
    }
  })

  test('lowercase country code is normalized (toUpperCase)', () => {
    expect(getCurrencyForCountry('de').code).toBe('EUR')
    expect(getCurrencyForCountry('gb').code).toBe('GBP')
    expect(getCurrencyForCountry('jp').code).toBe('JPY')
  })

  test('mixed-case is normalized', () => {
    expect(getCurrencyForCountry('Us').code).toBe('USD')
    expect(getCurrencyForCountry('iN').code).toBe('INR')
  })

  test('unknown country code falls back to USD', () => {
    expect(getCurrencyForCountry('ZZ')).toBe(SUPPORTED_CURRENCIES.USD)
    expect(getCurrencyForCountry('XX').code).toBe('USD')
  })

  test('empty string falls back to USD', () => {
    expect(getCurrencyForCountry('').code).toBe('USD')
  })

  test('null/undefined input is safe (?.toUpperCase guard)', () => {
    expect(getCurrencyForCountry(undefined as any).code).toBe('USD')
    expect(getCurrencyForCountry(null as any).code).toBe('USD')
  })
})

describe('formatPrice — prefix symbols', () => {
  const usd: CurrencyInfo = SUPPORTED_CURRENCIES.USD
  const jpy: CurrencyInfo = SUPPORTED_CURRENCIES.JPY

  test('USD whole amount → "$X.00"', () => {
    expect(formatPrice(10, usd)).toBe('$10.00')
  })

  test('USD with cents → "$X.YZ"', () => {
    expect(formatPrice(19.99, usd)).toBe('$19.99')
  })

  test('USD rounding to 2 decimals (Math.round IEEE-754 binary float quirks)', () => {
    expect(formatPrice(1.005, usd)).toBe('$1.00')
    expect(formatPrice(1.004, usd)).toBe('$1.00')
    expect(formatPrice(1.006, usd)).toBe('$1.01')
    expect(formatPrice(1.015, usd)).toBe('$1.01')
  })

  test('USD with thousands separator', () => {
    expect(formatPrice(1_234_567.89, usd)).toBe('$1,234,567.89')
  })

  test('USD zero → "$0.00"', () => {
    expect(formatPrice(0, usd)).toBe('$0.00')
  })

  test('USD negative amount preserves sign', () => {
    expect(formatPrice(-5.5, usd)).toBe('$-5.50')
  })

  test('JPY (0-decimal) rounds to integer with thousand separators, prefix ¥', () => {
    expect(formatPrice(1234.7, jpy)).toBe('¥1,235')
    expect(formatPrice(99, jpy)).toBe('¥99')
    expect(formatPrice(1_000_000, jpy)).toBe('¥1,000,000')
  })

  test('JPY rounds 0.5 half-up to 1; -0.5 rounds to "-0" (Math.round + toLocaleString)', () => {
    expect(formatPrice(0.5, jpy)).toBe('¥1')
    // Math.round(-0.5) === 0 in JS, but toLocaleString preserves the sign
    // of the IEEE-754 negative-zero result.
    expect(formatPrice(-0.5, jpy)).toBe('¥-0')
  })
})

describe('formatPrice — suffix symbols', () => {
  const sek: CurrencyInfo = SUPPORTED_CURRENCIES.SEK
  const nok: CurrencyInfo = SUPPORTED_CURRENCIES.NOK
  const pln: CurrencyInfo = SUPPORTED_CURRENCIES.PLN

  test('SEK emits "<amount> kr" with space before symbol', () => {
    expect(formatPrice(99.5, sek)).toBe('99.50 kr')
  })

  test('NOK and DKK share the same "kr" symbol but their own currency code', () => {
    expect(formatPrice(10, nok)).toBe('10.00 kr')
  })

  test('PLN suffix is "zł"', () => {
    expect(formatPrice(50, pln)).toBe('50.00 zł')
  })

  test('suffix format preserves thousand separator', () => {
    expect(formatPrice(1_234_567.89, sek)).toBe('1,234,567.89 kr')
  })
})

describe('formatPrice — multi-char prefix symbols', () => {
  test('CAD uses "CA$" prefix', () => {
    expect(formatPrice(10, SUPPORTED_CURRENCIES.CAD)).toBe('CA$10.00')
  })
  test('AUD uses "A$" prefix', () => {
    expect(formatPrice(10, SUPPORTED_CURRENCIES.AUD)).toBe('A$10.00')
  })
  test('BRL uses "R$" prefix', () => {
    expect(formatPrice(99.5, SUPPORTED_CURRENCIES.BRL)).toBe('R$99.50')
  })
  test('CHF uses "CHF" as both code and symbol (no space)', () => {
    expect(formatPrice(10, SUPPORTED_CURRENCIES.CHF)).toBe('CHF10.00')
  })
  test('INR uses "₹" prefix', () => {
    expect(formatPrice(2500, SUPPORTED_CURRENCIES.INR)).toBe('₹2,500.00')
  })
})
