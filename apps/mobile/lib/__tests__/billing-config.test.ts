// SPDX-License-Identifier: AGPL-3.0-or-later
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
