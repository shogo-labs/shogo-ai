// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import {
  COUNTRY_TO_CURRENCY,
  SUPPORTED_CURRENCIES,
  formatPrice,
  getCurrencyForCountry,
} from '../currencies'

describe('SUPPORTED_CURRENCIES', () => {
  it('contains USD as the canonical baseline', () => {
    expect(SUPPORTED_CURRENCIES.USD).toEqual({
      code: 'USD',
      symbol: '$',
      name: 'US Dollar',
      symbolPosition: 'prefix',
      decimalPlaces: 2,
    })
  })

  it('lists exactly 20 supported currencies', () => {
    expect(Object.keys(SUPPORTED_CURRENCIES)).toHaveLength(20)
  })

  it('every entry has code === key', () => {
    for (const [k, v] of Object.entries(SUPPORTED_CURRENCIES)) {
      expect(v.code).toBe(k)
    }
  })

  it('every entry has decimalPlaces of 0 or 2', () => {
    for (const v of Object.values(SUPPORTED_CURRENCIES)) {
      expect([0, 2]).toContain(v.decimalPlaces)
    }
  })

  it('only JPY and KRW use 0 decimal places', () => {
    const zeroDecimal = Object.values(SUPPORTED_CURRENCIES)
      .filter((c) => c.decimalPlaces === 0)
      .map((c) => c.code)
      .sort()
    expect(zeroDecimal).toEqual(['JPY', 'KRW'])
  })

  it('only Scandinavian + PLN currencies use suffix symbol position', () => {
    const suffix = Object.values(SUPPORTED_CURRENCIES)
      .filter((c) => c.symbolPosition === 'suffix')
      .map((c) => c.code)
      .sort()
    expect(suffix).toEqual(['DKK', 'NOK', 'PLN', 'SEK'])
  })
})

describe('COUNTRY_TO_CURRENCY', () => {
  it('maps all eurozone members to EUR', () => {
    const eurozone = ['AT', 'BE', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'NL', 'PT', 'ES']
    for (const c of eurozone) expect(COUNTRY_TO_CURRENCY[c]).toBe('EUR')
  })

  it('maps GB and Crown Dependencies (IM/JE/GG) to GBP', () => {
    for (const c of ['GB', 'IM', 'JE', 'GG']) {
      expect(COUNTRY_TO_CURRENCY[c]).toBe('GBP')
    }
  })

  it('maps US and US territories to USD', () => {
    for (const c of ['US', 'PR', 'GU', 'VI', 'AS', 'MP']) {
      expect(COUNTRY_TO_CURRENCY[c]).toBe('USD')
    }
  })

  it('maps USD-using non-US countries (EC, SV, PA) to USD', () => {
    for (const c of ['EC', 'SV', 'PA']) {
      expect(COUNTRY_TO_CURRENCY[c]).toBe('USD')
    }
  })

  it('maps CH and LI both to CHF', () => {
    expect(COUNTRY_TO_CURRENCY.CH).toBe('CHF')
    expect(COUNTRY_TO_CURRENCY.LI).toBe('CHF')
  })

  it('maps singletons (JP→JPY, CA→CAD, IN→INR, BR→BRL)', () => {
    expect(COUNTRY_TO_CURRENCY.JP).toBe('JPY')
    expect(COUNTRY_TO_CURRENCY.CA).toBe('CAD')
    expect(COUNTRY_TO_CURRENCY.IN).toBe('INR')
    expect(COUNTRY_TO_CURRENCY.BR).toBe('BRL')
  })
})

describe('getCurrencyForCountry', () => {
  it('returns the matching CurrencyInfo for a known country', () => {
    expect(getCurrencyForCountry('DE')).toBe(SUPPORTED_CURRENCIES.EUR)
    expect(getCurrencyForCountry('JP')).toBe(SUPPORTED_CURRENCIES.JPY)
  })

  it('uppercases lowercase ISO codes', () => {
    expect(getCurrencyForCountry('de').code).toBe('EUR')
    expect(getCurrencyForCountry('jp').code).toBe('JPY')
  })

  it('handles mixed-case codes', () => {
    expect(getCurrencyForCountry('Gb').code).toBe('GBP')
  })

  it('falls back to USD for unknown country codes', () => {
    expect(getCurrencyForCountry('ZZ')).toBe(SUPPORTED_CURRENCIES.USD)
    expect(getCurrencyForCountry('XX').code).toBe('USD')
  })

  it('falls back to USD for empty string', () => {
    expect(getCurrencyForCountry('').code).toBe('USD')
  })

  it('falls back to USD for null/undefined input (defensive)', () => {
    expect(getCurrencyForCountry(undefined as any).code).toBe('USD')
    expect(getCurrencyForCountry(null as any).code).toBe('USD')
  })
})

describe('formatPrice', () => {
  const USD = SUPPORTED_CURRENCIES.USD
  const EUR = SUPPORTED_CURRENCIES.EUR
  const JPY = SUPPORTED_CURRENCIES.JPY
  const KRW = SUPPORTED_CURRENCIES.KRW
  const SEK = SUPPORTED_CURRENCIES.SEK
  const DKK = SUPPORTED_CURRENCIES.DKK

  describe('prefix currencies with 2 decimal places', () => {
    it('formats whole amounts with .00', () => {
      expect(formatPrice(10, USD)).toBe('$10.00')
      expect(formatPrice(0, USD)).toBe('$0.00')
    })

    it('rounds to 2 decimals', () => {
      expect(formatPrice(10.005, USD)).toBe('$10.01')
      expect(formatPrice(10.004, USD)).toBe('$10.00')
    })

    it('inserts thousands separators', () => {
      expect(formatPrice(1234.56, USD)).toBe('$1,234.56')
      expect(formatPrice(1_234_567.89, USD)).toBe('$1,234,567.89')
    })

    it('handles non-USD prefix symbols', () => {
      expect(formatPrice(99.5, EUR)).toBe('€99.50')
    })

    it('handles multi-character prefixes (CA$, A$, MX$)', () => {
      expect(formatPrice(50, SUPPORTED_CURRENCIES.CAD)).toBe('CA$50.00')
      expect(formatPrice(50, SUPPORTED_CURRENCIES.AUD)).toBe('A$50.00')
      expect(formatPrice(50, SUPPORTED_CURRENCIES.MXN)).toBe('MX$50.00')
    })
  })

  describe('prefix currencies with 0 decimal places (JPY, KRW)', () => {
    it('rounds to whole numbers for JPY', () => {
      expect(formatPrice(149.7, JPY)).toBe('¥150')
      expect(formatPrice(149.4, JPY)).toBe('¥149')
    })

    it('inserts thousands separators for JPY', () => {
      expect(formatPrice(1500, JPY)).toBe('¥1,500')
      expect(formatPrice(1_234_567, JPY)).toBe('¥1,234,567')
    })

    it('formats KRW with prefix ₩ and no decimals', () => {
      expect(formatPrice(10000, KRW)).toBe('₩10,000')
    })
  })

  describe('suffix currencies', () => {
    it('places symbol after the number with a space (SEK)', () => {
      expect(formatPrice(99.5, SEK)).toBe('99.50 kr')
    })

    it('also applies thousands separators with suffix', () => {
      expect(formatPrice(1234.5, DKK)).toBe('1,234.50 kr')
    })

    it('handles non-ASCII suffix symbol (zł for PLN)', () => {
      expect(formatPrice(42, SUPPORTED_CURRENCIES.PLN)).toBe('42.00 zł')
    })
  })

  describe('edge values', () => {
    it('handles 0', () => {
      expect(formatPrice(0, USD)).toBe('$0.00')
      expect(formatPrice(0, JPY)).toBe('¥0')
    })

    it('handles negative amounts', () => {
      expect(formatPrice(-1.5, USD)).toBe('$-1.50')
    })

    it('handles very small fractions that round to 0', () => {
      expect(formatPrice(0.004, USD)).toBe('$0.00')
    })

    it('handles very large amounts without precision loss for safe integers', () => {
      expect(formatPrice(1_000_000_000, USD)).toBe('$1,000,000,000.00')
    })
  })
})
