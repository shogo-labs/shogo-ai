// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for billing-config helpers — primarily `getIncludedUsdCapacityForDisplay`,
 * which historically caused a `$40.50 / $1,600.50` display bug because callers
 * passed the remaining USD balance into a positional `seats` slot. The helper
 * now takes a named-argument object; these tests pin that contract and the
 * derivation rules (wallet allocation wins; baseline raised by remaining
 * balance when the wallet hasn't allocated yet).
 *
 * Run: bun test apps/mobile/lib/__tests__/billing-config.test.ts
 */

import { describe, test, expect } from 'bun:test'

import {
  FREE_DAILY_INCLUDED_USD,
  SEAT_INCLUDED_USD,
  getDailyIncludedForPlan,
  getIncludedUsdCapacityForDisplay,
  getIncludedUsdForPlan,
  formatUsd,
  formatCurrencyPrice,
  getPlanDisplayName,
} from '../billing-config'

describe('getIncludedUsdCapacityForDisplay', () => {
  test('uses wallet-locked monthly allocation when set; paid plans get no daily top-up', () => {
    const total = getIncludedUsdCapacityForDisplay({
      planId: 'business',
      seats: 1,
      monthlyIncludedAllocationUsd: 40,
    })
    expect(total).toBeCloseTo(40, 6)
  })

  test('falls back to plan baseline when no wallet allocation is set', () => {
    const total = getIncludedUsdCapacityForDisplay({
      planId: 'pro',
      seats: 1,
    })
    expect(total).toBeCloseTo(getIncludedUsdForPlan('pro', 1), 6)
  })

  test('multi-seat business baseline uses seats, not the remaining balance', () => {
    // The historic bug was passing `effectiveBalance.total` (e.g. 40.5) as the
    // seats argument, producing `40.5 * SEAT_INCLUDED_USD.business = $1,620`.
    // With named args, callers must supply seats explicitly and the math is
    // grounded.
    const total = getIncludedUsdCapacityForDisplay({
      planId: 'business',
      seats: 3,
    })
    expect(total).toBeCloseTo(SEAT_INCLUDED_USD.business * 3, 6)
  })

  test('raises baseline to match an unusually high remaining balance (legacy wallet)', () => {
    // If a workspace happens to carry a remaining balance higher than the
    // current plan baseline (e.g. promo grant), we widen the bar so the
    // ratio still makes visual sense.
    const total = getIncludedUsdCapacityForDisplay({
      planId: 'pro',
      seats: 1,
      remainingTotal: 75,
    })
    expect(total).toBeCloseTo(75, 6)
  })

  test('no plan, no allocation, no remaining → free baseline (includes the daily allowance)', () => {
    const total = getIncludedUsdCapacityForDisplay({
      planId: undefined,
      seats: 1,
    })
    expect(total).toBeCloseTo(getIncludedUsdForPlan(undefined, 1), 6)
    expect(total).toBeCloseTo(FREE_DAILY_INCLUDED_USD, 6)
  })

  test('does not let the legacy "$40.50 / $1,600.50" bug recur (regression)', () => {
    // Reproduce the exact buggy inputs: a Business workspace with one seat,
    // showing $40.50 remaining. With the named API, even a deliberate
    // mistake (passing remaining as seats) is type-fenced; here we sanity
    // check that the correct call yields a sensible total.
    const total = getIncludedUsdCapacityForDisplay({
      planId: 'business',
      seats: 1,
      remainingTotal: 40.5,
      monthlyIncludedAllocationUsd: 40,
    })
    expect(total).toBeCloseTo(40, 6)
    expect(total).toBeLessThan(50)
  })
})

describe('getDailyIncludedForPlan', () => {
  test('returns the free amount only for the free tier', () => {
    expect(getDailyIncludedForPlan('free')).toBe(FREE_DAILY_INCLUDED_USD)
    expect(getDailyIncludedForPlan('basic')).toBe(0)
    expect(getDailyIncludedForPlan('pro')).toBe(0)
    expect(getDailyIncludedForPlan('business')).toBe(0)
    expect(getDailyIncludedForPlan('enterprise')).toBe(0)
  })

  test('treats missing / unknown plans as free (safety net for un-resolved workspaces)', () => {
    expect(getDailyIncludedForPlan(undefined)).toBe(FREE_DAILY_INCLUDED_USD)
    expect(getDailyIncludedForPlan(null)).toBe(FREE_DAILY_INCLUDED_USD)
    expect(getDailyIncludedForPlan('')).toBe(FREE_DAILY_INCLUDED_USD)
    expect(getDailyIncludedForPlan('platinum')).toBe(FREE_DAILY_INCLUDED_USD)
  })

  test('normalizes decorated plan ids (e.g. pro_200, Business-Annual)', () => {
    expect(getDailyIncludedForPlan('Pro')).toBe(0)
    expect(getDailyIncludedForPlan('pro_200')).toBe(0)
    expect(getDailyIncludedForPlan('Business-Annual')).toBe(0)
    expect(getDailyIncludedForPlan('Free-Forever')).toBe(FREE_DAILY_INCLUDED_USD)
  })
})

describe('getIncludedUsdForPlan', () => {
  test('undefined plan returns just the (free-tier) daily allowance', () => {
    expect(getIncludedUsdForPlan(undefined)).toBeCloseTo(FREE_DAILY_INCLUDED_USD, 6)
  })

  test('free includes the daily allowance; basic does not (paid plan)', () => {
    expect(getIncludedUsdForPlan('free', 5)).toBeCloseTo(0 + FREE_DAILY_INCLUDED_USD, 6)
    expect(getIncludedUsdForPlan('basic', 10)).toBeCloseTo(SEAT_INCLUDED_USD.basic, 6)
  })

  test('pro/business/enterprise scale linearly with seats and get no daily top-up', () => {
    expect(getIncludedUsdForPlan('pro', 4)).toBeCloseTo(SEAT_INCLUDED_USD.pro * 4, 6)
    expect(getIncludedUsdForPlan('business', 3)).toBeCloseTo(SEAT_INCLUDED_USD.business * 3, 6)
  })

  test('zero/negative seats are clamped to 1', () => {
    expect(getIncludedUsdForPlan('pro', 0)).toBeCloseTo(SEAT_INCLUDED_USD.pro, 6)
  })

  test('legacy tier ids (e.g. pro_200) interpret the numeric suffix at $0.10/credit', () => {
    expect(getIncludedUsdForPlan('pro_200')).toBeCloseTo(20, 6)
    expect(getIncludedUsdForPlan('business_1200')).toBeCloseTo(120, 6)
  })

  test('unknown plan id returns only the daily allowance (treated as free)', () => {
    expect(getIncludedUsdForPlan('made-up-tier')).toBeCloseTo(FREE_DAILY_INCLUDED_USD, 6)
  })

  test('mixed-case plan ids are normalized', () => {
    expect(getIncludedUsdForPlan('Pro', 2)).toBeCloseTo(SEAT_INCLUDED_USD.pro * 2, 6)
  })
})

describe('formatUsd', () => {
  test('integers render without decimals', () => {
    expect(formatUsd(12)).toBe('$12')
  })

  test('fractional amounts render with two decimal places', () => {
    expect(formatUsd(12.34)).toBe('$12.34')
  })

  test('rounds half-even-ish (toLocaleString)', () => {
    expect(formatUsd(12.345)).toBe('$12.35')
  })

  test('thousands separator', () => {
    expect(formatUsd(1234)).toBe('$1,234')
  })
})

describe('getPlanDisplayName', () => {
  test('undefined → "Free"', () => {
    expect(getPlanDisplayName(undefined)).toBe('Free')
  })

  test('capitalizes the base plan id', () => {
    expect(getPlanDisplayName('pro')).toBe('Pro')
    expect(getPlanDisplayName('business')).toBe('Business')
  })

  test('strips legacy suffix before capitalizing', () => {
    expect(getPlanDisplayName('business_1200')).toBe('Business')
  })
})

describe('formatCurrencyPrice', () => {
  const USD = { code: 'USD', symbol: '$', name: 'US Dollar', symbolPosition: 'prefix' as const, decimalPlaces: 2 }
  const JPY = { code: 'JPY', symbol: '¥', name: 'Yen', symbolPosition: 'prefix' as const, decimalPlaces: 0 }
  const EUR = { code: 'EUR', symbol: '€', name: 'Euro', symbolPosition: 'suffix' as const, decimalPlaces: 2 }

  test('formats prefix-symbol with two decimals', () => {
    expect(formatCurrencyPrice(12.5, USD)).toBe('$12.50')
  })

  test('formats prefix-symbol with zero decimals (rounds)', () => {
    expect(formatCurrencyPrice(1234.7, JPY)).toBe('¥1,235')
  })

  test('formats suffix-symbol locale', () => {
    expect(formatCurrencyPrice(12.5, EUR)).toBe('12.50 €')
  })
})
