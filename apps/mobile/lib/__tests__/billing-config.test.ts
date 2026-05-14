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
  DAILY_INCLUDED_USD,
  SEAT_INCLUDED_USD,
  getIncludedUsdCapacityForDisplay,
  getIncludedUsdForPlan,
  formatUsd,
  formatCurrencyPrice,
  getPlanDisplayName,
} from '../billing-config'

describe('getIncludedUsdCapacityForDisplay', () => {
  test('uses wallet-locked monthly allocation when set, plus the daily allowance', () => {
    const total = getIncludedUsdCapacityForDisplay({
      planId: 'business',
      seats: 1,
      monthlyIncludedAllocationUsd: 40,
    })
    expect(total).toBeCloseTo(40 + DAILY_INCLUDED_USD, 6)
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
    // grounded. The plan baseline includes the always-on daily allowance.
    const total = getIncludedUsdCapacityForDisplay({
      planId: 'business',
      seats: 3,
    })
    expect(total).toBeCloseTo(SEAT_INCLUDED_USD.business * 3 + DAILY_INCLUDED_USD, 6)
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

  test('no plan, no allocation, no remaining → free baseline', () => {
    const total = getIncludedUsdCapacityForDisplay({
      planId: undefined,
      seats: 1,
    })
    expect(total).toBeCloseTo(getIncludedUsdForPlan(undefined, 1), 6)
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
    expect(total).toBeCloseTo(40 + DAILY_INCLUDED_USD, 6)
    expect(total).toBeLessThan(50)
  })
})

describe('getIncludedUsdForPlan', () => {
  test('undefined plan returns just the daily allowance', () => {
    expect(getIncludedUsdForPlan(undefined)).toBeCloseTo(DAILY_INCLUDED_USD, 6)
  })

  test('free / basic are single-user and ignore seats', () => {
    expect(getIncludedUsdForPlan('free', 5)).toBeCloseTo(0 + DAILY_INCLUDED_USD, 6)
    expect(getIncludedUsdForPlan('basic', 10)).toBeCloseTo(
      SEAT_INCLUDED_USD.basic + DAILY_INCLUDED_USD,
      6,
    )
  })

  test('pro/business/enterprise scale linearly with seats', () => {
    expect(getIncludedUsdForPlan('pro', 4)).toBeCloseTo(
      SEAT_INCLUDED_USD.pro * 4 + DAILY_INCLUDED_USD,
      6,
    )
    expect(getIncludedUsdForPlan('business', 3)).toBeCloseTo(
      SEAT_INCLUDED_USD.business * 3 + DAILY_INCLUDED_USD,
      6,
    )
  })

  test('zero/negative seats are clamped to 1', () => {
    expect(getIncludedUsdForPlan('pro', 0)).toBeCloseTo(
      SEAT_INCLUDED_USD.pro + DAILY_INCLUDED_USD,
      6,
    )
  })

  test('legacy tier ids (e.g. pro_200) interpret the numeric suffix at $0.10/credit', () => {
    expect(getIncludedUsdForPlan('pro_200')).toBeCloseTo(20 + DAILY_INCLUDED_USD, 6)
    expect(getIncludedUsdForPlan('business_1200')).toBeCloseTo(120 + DAILY_INCLUDED_USD, 6)
  })

  test('unknown plan id returns only the daily allowance', () => {
    expect(getIncludedUsdForPlan('made-up-tier')).toBeCloseTo(DAILY_INCLUDED_USD, 6)
  })

  test('mixed-case plan ids are normalized', () => {
    expect(getIncludedUsdForPlan('Pro', 2)).toBeCloseTo(
      SEAT_INCLUDED_USD.pro * 2 + DAILY_INCLUDED_USD,
      6,
    )
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
