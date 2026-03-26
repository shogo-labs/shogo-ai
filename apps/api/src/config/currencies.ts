// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Currency Configuration
 *
 * Maps countries to their local currencies and provides display metadata
 * for ~20 supported currencies. Used by the exchange rate service and
 * regional pricing endpoint.
 */

export interface CurrencyInfo {
  code: string
  symbol: string
  name: string
  symbolPosition: 'prefix' | 'suffix'
  decimalPlaces: number
}

export const SUPPORTED_CURRENCIES: Record<string, CurrencyInfo> = {
  USD: { code: 'USD', symbol: '$', name: 'US Dollar', symbolPosition: 'prefix', decimalPlaces: 2 },
  EUR: { code: 'EUR', symbol: '€', name: 'Euro', symbolPosition: 'prefix', decimalPlaces: 2 },
  GBP: { code: 'GBP', symbol: '£', name: 'British Pound', symbolPosition: 'prefix', decimalPlaces: 2 },
  JPY: { code: 'JPY', symbol: '¥', name: 'Japanese Yen', symbolPosition: 'prefix', decimalPlaces: 0 },
  CAD: { code: 'CAD', symbol: 'CA$', name: 'Canadian Dollar', symbolPosition: 'prefix', decimalPlaces: 2 },
  AUD: { code: 'AUD', symbol: 'A$', name: 'Australian Dollar', symbolPosition: 'prefix', decimalPlaces: 2 },
  CHF: { code: 'CHF', symbol: 'CHF', name: 'Swiss Franc', symbolPosition: 'prefix', decimalPlaces: 2 },
  SEK: { code: 'SEK', symbol: 'kr', name: 'Swedish Krona', symbolPosition: 'suffix', decimalPlaces: 2 },
  NOK: { code: 'NOK', symbol: 'kr', name: 'Norwegian Krone', symbolPosition: 'suffix', decimalPlaces: 2 },
  DKK: { code: 'DKK', symbol: 'kr', name: 'Danish Krone', symbolPosition: 'suffix', decimalPlaces: 2 },
  PLN: { code: 'PLN', symbol: 'zł', name: 'Polish Zloty', symbolPosition: 'suffix', decimalPlaces: 2 },
  BRL: { code: 'BRL', symbol: 'R$', name: 'Brazilian Real', symbolPosition: 'prefix', decimalPlaces: 2 },
  MXN: { code: 'MXN', symbol: 'MX$', name: 'Mexican Peso', symbolPosition: 'prefix', decimalPlaces: 2 },
  INR: { code: 'INR', symbol: '₹', name: 'Indian Rupee', symbolPosition: 'prefix', decimalPlaces: 2 },
  KRW: { code: 'KRW', symbol: '₩', name: 'South Korean Won', symbolPosition: 'prefix', decimalPlaces: 0 },
  SGD: { code: 'SGD', symbol: 'S$', name: 'Singapore Dollar', symbolPosition: 'prefix', decimalPlaces: 2 },
  HKD: { code: 'HKD', symbol: 'HK$', name: 'Hong Kong Dollar', symbolPosition: 'prefix', decimalPlaces: 2 },
  NZD: { code: 'NZD', symbol: 'NZ$', name: 'New Zealand Dollar', symbolPosition: 'prefix', decimalPlaces: 2 },
  ZAR: { code: 'ZAR', symbol: 'R', name: 'South African Rand', symbolPosition: 'prefix', decimalPlaces: 2 },
  TRY: { code: 'TRY', symbol: '₺', name: 'Turkish Lira', symbolPosition: 'prefix', decimalPlaces: 2 },
}

/**
 * ISO 3166-1 alpha-2 country codes mapped to their primary currency.
 * Countries not listed here fall back to USD.
 */
export const COUNTRY_TO_CURRENCY: Record<string, string> = {
  // EUR zone
  AT: 'EUR', BE: 'EUR', CY: 'EUR', EE: 'EUR', FI: 'EUR', FR: 'EUR',
  DE: 'EUR', GR: 'EUR', IE: 'EUR', IT: 'EUR', LV: 'EUR', LT: 'EUR',
  LU: 'EUR', MT: 'EUR', NL: 'EUR', PT: 'EUR', SK: 'EUR', SI: 'EUR',
  ES: 'EUR', HR: 'EUR', AD: 'EUR', MC: 'EUR', SM: 'EUR', VA: 'EUR',
  ME: 'EUR', XK: 'EUR',

  // GBP
  GB: 'GBP', IM: 'GBP', JE: 'GBP', GG: 'GBP',

  // JPY
  JP: 'JPY',

  // CAD
  CA: 'CAD',

  // AUD
  AU: 'AUD',

  // CHF
  CH: 'CHF', LI: 'CHF',

  // SEK
  SE: 'SEK',

  // NOK
  NO: 'NOK',

  // DKK
  DK: 'DKK',

  // PLN
  PL: 'PLN',

  // BRL
  BR: 'BRL',

  // MXN
  MX: 'MXN',

  // INR
  IN: 'INR',

  // KRW
  KR: 'KRW',

  // SGD
  SG: 'SGD',

  // HKD
  HK: 'HKD',

  // NZD
  NZ: 'NZD',

  // ZAR
  ZA: 'ZAR',

  // TRY
  TR: 'TRY',

  // USD (explicit)
  US: 'USD', PR: 'USD', GU: 'USD', VI: 'USD', AS: 'USD', MP: 'USD',
  EC: 'USD', SV: 'USD', PA: 'USD',
}

export function getCurrencyForCountry(countryCode: string): CurrencyInfo {
  const code = COUNTRY_TO_CURRENCY[countryCode?.toUpperCase()] ?? 'USD'
  return SUPPORTED_CURRENCIES[code] ?? SUPPORTED_CURRENCIES['USD']
}

export function formatPrice(amount: number, currency: CurrencyInfo): string {
  const rounded = currency.decimalPlaces === 0
    ? Math.round(amount)
    : Math.round(amount * 100) / 100

  const formatted = currency.decimalPlaces === 0
    ? rounded.toLocaleString('en-US')
    : rounded.toLocaleString('en-US', {
        minimumFractionDigits: currency.decimalPlaces,
        maximumFractionDigits: currency.decimalPlaces,
      })

  return currency.symbolPosition === 'prefix'
    ? `${currency.symbol}${formatted}`
    : `${formatted} ${currency.symbol}`
}
