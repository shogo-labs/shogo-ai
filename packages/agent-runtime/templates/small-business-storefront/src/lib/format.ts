// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { storeContent } from '@/data/store-content'

/**
 * Format an integer minor-unit amount (cents/pence/paise) as a display price.
 * Uses Intl so currencies with different minor-unit conventions (e.g. JPY has
 * none) render correctly. Falls back to a symbol + fixed 2dp if Intl throws on
 * an unknown code.
 */
export function formatMoney(
  amountMinor: number,
  currency: string = storeContent.store.currency,
  symbol: string = storeContent.store.currencySymbol,
): string {
  const code = (currency || 'usd').toUpperCase()
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(
      amountMinor / 100,
    )
  } catch {
    return `${symbol}${(amountMinor / 100).toFixed(2)}`
  }
}
