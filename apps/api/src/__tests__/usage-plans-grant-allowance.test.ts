// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `getGrantAllowance` — the allowance a super-admin grant confers (SHO-343).
 *
 * A grant has no price, so it resolves like a null-price subscription (legacy
 * Business allowance for a Business grant, today's ladder otherwise), and its
 * `monthlyIncludedUsd` raises the per-seat weekly allowance when it buys more.
 *
 *   bun test apps/api/src/__tests__/usage-plans-grant-allowance.test.ts
 */

import { describe, expect, test } from 'bun:test'
import {
  LEGACY_BUSINESS_ROLLING_WINDOW_LIMITS,
  ROLLING_WINDOW_LIMITS,
  WEEKS_PER_MONTH,
  getGrantAllowance,
} from '../config/usage-plans'

describe('getGrantAllowance', () => {
  test('a Business grant keeps the legacy $40-seat allowance', () => {
    const allowance = getGrantAllowance('business', { freeSeats: 10 })
    expect(allowance.windowLimits).toEqual({ ...LEGACY_BUSINESS_ROLLING_WINDOW_LIMITS })
    expect(allowance.monthlyIncludedUsdPerSeat).toBe(40)
    expect(allowance.legacy).toBe(true)
  })

  test('a Basic grant resolves off today’s ladder', () => {
    const allowance = getGrantAllowance('basic', { freeSeats: 5 })
    expect(allowance.windowLimits).toEqual(ROLLING_WINDOW_LIMITS.basic)
    expect(allowance.legacy).toBe(false)
  })

  test('an enterprise grant is uncapped', () => {
    const allowance = getGrantAllowance('enterprise', { freeSeats: 1, monthlyIncludedUsd: 5000 })
    expect(allowance.windowLimits).toBeNull()
  })

  test('monthlyIncludedUsd raises the per-seat weekly allowance', () => {
    const allowance = getGrantAllowance('business', { freeSeats: 10, monthlyIncludedUsd: 2000 })
    const expectedWeekly = 2000 / 10 / WEEKS_PER_MONTH
    expect(allowance.windowLimits!.weeklyUsd).toBeCloseTo(expectedWeekly)
    // 5-hour limit scales by the plan's own 5h/weekly ratio.
    const ratio =
      LEGACY_BUSINESS_ROLLING_WINDOW_LIMITS.fiveHourUsd /
      LEGACY_BUSINESS_ROLLING_WINDOW_LIMITS.weeklyUsd
    expect(allowance.windowLimits!.fiveHourUsd).toBeCloseTo(expectedWeekly * ratio)
    expect(allowance.monthlyIncludedUsdPerSeat).toBeCloseTo(2000 / 10)
  })

  test('a monthlyIncludedUsd below the plan allowance does not lower it', () => {
    const allowance = getGrantAllowance('business', { freeSeats: 10, monthlyIncludedUsd: 100 })
    expect(allowance.windowLimits).toEqual({ ...LEGACY_BUSINESS_ROLLING_WINDOW_LIMITS })
  })

  test('freeSeats of 0 is treated as one seat for the monthly floor', () => {
    const allowance = getGrantAllowance('business', { freeSeats: 0, monthlyIncludedUsd: 2000 })
    expect(allowance.windowLimits!.weeklyUsd).toBeCloseTo(2000 / WEEKS_PER_MONTH)
  })
})
