// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  COUNTRY_TO_CURRENCY,
  SUPPORTED_CURRENCIES,
  formatPrice,
  getCurrencyForCountry,
  type CurrencyInfo,
} from '../config/currencies'

describe('SUPPORTED_CURRENCIES', () => {
  test('contains the documented ~20 currencies', () => {
    const codes = Object.keys(SUPPORTED_CURRENCIES)
    expect(codes.length).toBe(20)
  })

  test('every entry is self-describing (code matches map key)', () => {
    for (const [key, info] of Object.entries(SUPPORTED_CURRENCIES)) {
      expect(info.code).toBe(key)
    }
  })

  test('every entry has all required fields with correct types', () => {
    for (const info of Object.values(SUPPORTED_CURRENCIES)) {
      expect(typeof info.code).toBe('string')
      expect(typeof info.symbol).toBe('string')
      expect(typeof info.name).toBe('string')
      expect(['prefix', 'suffix']).toContain(info.symbolPosition)
      expect([0, 2]).toContain(info.decimalPlaces)
    }
  })

  test('zero-decimal currencies match the ISO 4217 list (JPY, KRW)', () => {
    const zeroDecimal = Object.values(SUPPORTED_CURRENCIES)
      .filter((c) => c.decimalPlaces === 0)
      .map((c) => c.code)
      .sort()
    expect(zeroDecimal).toEqual(['JPY', 'KRW'])
  })

  test('USD is always present (it is the fallback currency)', () => {
    expect(SUPPORTED_CURRENCIES.USD).toBeDefined()
    expect(SUPPORTED_CURRENCIES.USD.code).toBe('USD')
  })
})

describe('COUNTRY_TO_CURRENCY', () => {
  test('all mapped currencies exist in SUPPORTED_CURRENCIES', () => {
    for (const [country, currency] of Object.entries(COUNTRY_TO_CURRENCY)) {
      expect(SUPPORTED_CURRENCIES[currency]).toBeDefined()
      // sanity: country code is ISO 3166-1 alpha-2 (two uppercase letters)
      expect(country).toMatch(/^[A-Z]{2}$/)
    }
  })

  test('major Eurozone members all map to EUR', () => {
    for (const country of ['DE', 'FR', 'IT', 'ES', 'NL', 'IE', 'PT', 'AT', 'BE', 'FI']) {
      expect(COUNTRY_TO_CURRENCY[country]).toBe('EUR')
    }
  })

  test('UK + crown dependencies all map to GBP', () => {
    for (const country of ['GB', 'IM', 'JE', 'GG']) {
      expect(COUNTRY_TO_CURRENCY[country]).toBe('GBP')
    }
  })

  test('US + US territories + dollarized economies map to USD', () => {
    for (const country of ['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'EC', 'SV', 'PA']) {
      expect(COUNTRY_TO_CURRENCY[country]).toBe('USD')
    }
  })

  test('single-country currencies map correctly', () => {
    expect(COUNTRY_TO_CURRENCY.JP).toBe('JPY')
    expect(COUNTRY_TO_CURRENCY.IN).toBe('INR')
    expect(COUNTRY_TO_CURRENCY.KR).toBe('KRW')
    expect(COUNTRY_TO_CURRENCY.BR).toBe('BRL')
    expect(COUNTRY_TO_CURRENCY.TR).toBe('TRY')
  })

  test('CHF is shared between Switzerland and Liechtenstein', () => {
    expect(COUNTRY_TO_CURRENCY.CH).toBe('CHF')
    expect(COUNTRY_TO_CURRENCY.LI).toBe('CHF')
  })
})

describe('getCurrencyForCountry', () => {
  test('returns the mapped CurrencyInfo for a known country', () => {
    expect(getCurrencyForCountry('DE')).toBe(SUPPORTED_CURRENCIES.EUR)
    expect(getCurrencyForCountry('JP')).toBe(SUPPORTED_CURRENCIES.JPY)
    expect(getCurrencyForCountry('IN')).toBe(SUPPORTED_CURRENCIES.INR)
  })

  test('is case-insensitive on the input country code', () => {
    expect(getCurrencyForCountry('gb')).toBe(SUPPORTED_CURRENCIES.GBP)
    expect(getCurrencyForCountry('De')).toBe(SUPPORTED_CURRENCIES.EUR)
    expect(getCurrencyForCountry('jP')).toBe(SUPPORTED_CURRENCIES.JPY)
  })

  test('falls back to USD for unknown country codes', () => {
    expect(getCurrencyForCountry('XX')).toBe(SUPPORTED_CURRENCIES.USD)
    expect(getCurrencyForCountry('ZZ')).toBe(SUPPORTED_CURRENCIES.USD)
    expect(getCurrencyForCountry('atlantis')).toBe(SUPPORTED_CURRENCIES.USD)
  })

  test('falls back to USD for empty / whitespace / weird input', () => {
    expect(getCurrencyForCountry('')).toBe(SUPPORTED_CURRENCIES.USD)
    expect(getCurrencyForCountry('  ')).toBe(SUPPORTED_CURRENCIES.USD)
    expect(getCurrencyForCountry('123')).toBe(SUPPORTED_CURRENCIES.USD)
  })

  test('falls back to USD when the input is null/undefined-ish (optional-chained .toUpperCase)', () => {
    // The source uses `countryCode?.toUpperCase()` — exercise the optional chain.
    expect(getCurrencyForCountry(undefined as unknown as string)).toBe(
      SUPPORTED_CURRENCIES.USD
    )
    expect(getCurrencyForCountry(null as unknown as string)).toBe(
      SUPPORTED_CURRENCIES.USD
    )
  })
})

describe('formatPrice', () => {
  const USD = SUPPORTED_CURRENCIES.USD
  const EUR = SUPPORTED_CURRENCIES.EUR
  const JPY = SUPPORTED_CURRENCIES.JPY
  const SEK = SUPPORTED_CURRENCIES.SEK

  test('formats USD with prefix symbol and 2 decimals', () => {
    expect(formatPrice(9.99, USD)).toBe('$9.99')
    expect(formatPrice(1, USD)).toBe('$1.00')
    expect(formatPrice(0, USD)).toBe('$0.00')
  })

  test('inserts thousands separators for large amounts', () => {
    expect(formatPrice(1234.56, USD)).toBe('$1,234.56')
    expect(formatPrice(1_000_000, USD)).toBe('$1,000,000.00')
  })

  test('formats JPY (zero-decimal) by rounding to whole units', () => {
    expect(formatPrice(1234.56, JPY)).toBe('¥1,235')
    expect(formatPrice(0.4, JPY)).toBe('¥0')
    expect(formatPrice(0.5, JPY)).toBe('¥1')
  })

  test('formats EUR with prefix symbol', () => {
    expect(formatPrice(12.5, EUR)).toBe('€12.50')
  })

  test('formats suffix currencies with a space before the symbol', () => {
    expect(formatPrice(100, SEK)).toBe('100.00 kr')
    expect(formatPrice(1234.5, SEK)).toBe('1,234.50 kr')
  })

  test('rounds 2-decimal currencies to the nearest cent', () => {
    // Implementation uses `Math.round(amount * 100) / 100`, which is subject
    // to IEEE-754 quirks (9.995 * 100 === 999.4999... so it rounds DOWN).
    // We pin the actual contract here, not naive half-up.
    expect(formatPrice(9.994, USD)).toBe('$9.99')
    expect(formatPrice(9.996, USD)).toBe('$10.00')
    expect(formatPrice(9.995, USD)).toBe('$9.99') // float-imprecision quirk
  })

  test('handles negative amounts (refunds / credits)', () => {
    expect(formatPrice(-5.5, USD)).toBe('$-5.50')
    expect(formatPrice(-100, JPY)).toBe('¥-100')
  })

  test('respects a custom CurrencyInfo at the type boundary', () => {
    const custom: CurrencyInfo = {
      code: 'XYZ',
      symbol: 'X',
      name: 'Test',
      symbolPosition: 'suffix',
      decimalPlaces: 0,
    }
    expect(formatPrice(42.7, custom)).toBe('43 X')
  })
})
