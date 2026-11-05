// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-339 — allowances follow the price.
 *
 * A Business seat keeps the allowance it was sold at ($9.90/wk, $3.96/5h,
 * $40/mo) until its next renewal moves it to the $16 price, at which point the
 * same plan resolves to $4.60/wk, $1.84/5h, $20/mo. Basic and Pro do not move.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  LEGACY_BUSINESS_ROLLING_WINDOW_LIMITS,
  LEGACY_BUSINESS_SEAT_INCLUDED_USD,
  ROLLING_WINDOW_LIMITS,
  SEAT_INCLUDED_USD,
  getMonthlyIncludedForPlanAndPrice,
  getPlanAllowance,
} from '../usage-plans'
import { LEGACY_PLAN_PRICES } from '../stripe-prices'

const originalNodeEnv = process.env.NODE_ENV
const legacyBusiness = LEGACY_PLAN_PRICES.staging.business
const legacyBasic = LEGACY_PLAN_PRICES.staging.basic

beforeEach(() => {
  process.env.NODE_ENV = 'test'
})

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})

describe('getPlanAllowance — legacy Business price', () => {
  it('keeps $9.90/wk, $3.96/5h and $40/mo per seat on the legacy $40 price', () => {
    const allowance = getPlanAllowance('business', legacyBusiness.monthly)
    expect(allowance.legacy).toBe(true)
    expect(allowance.windowLimits).toEqual({ fiveHourUsd: 3.96, weeklyUsd: 9.9 })
    expect(allowance.monthlyIncludedUsdPerSeat).toBe(40)
    expect(allowance.windowLimits).toEqual(LEGACY_BUSINESS_ROLLING_WINDOW_LIMITS)
    expect(allowance.monthlyIncludedUsdPerSeat).toBe(LEGACY_BUSINESS_SEAT_INCLUDED_USD)
  })

  it('treats the legacy $400 annual price the same way', () => {
    const allowance = getPlanAllowance('business', legacyBusiness.annual)
    expect(allowance.legacy).toBe(true)
    expect(allowance.windowLimits?.weeklyUsd).toBe(9.9)
  })

  it('counts a null price on business as legacy (pre-backfill rows are all $40)', () => {
    for (const price of [null, undefined]) {
      const allowance = getPlanAllowance('business', price)
      expect(allowance.legacy).toBe(true)
      expect(allowance.windowLimits?.weeklyUsd).toBe(9.9)
      expect(allowance.monthlyIncludedUsdPerSeat).toBe(40)
    }
  })

  it('legacy Business ids (business_1200) also keep the legacy allowance', () => {
    const allowance = getPlanAllowance('business_1200', null)
    expect(allowance.legacy).toBe(true)
  })
})

describe('getPlanAllowance — v2.5.0 Business price', () => {
  it('gives $4.60/wk, $1.84/5h and $20/mo per seat on a non-legacy price', () => {
    const allowance = getPlanAllowance('business', 'price_new_business_monthly')
    expect(allowance.legacy).toBe(false)
    expect(allowance.windowLimits).toEqual({ fiveHourUsd: 1.84, weeklyUsd: 4.6 })
    expect(allowance.monthlyIncludedUsdPerSeat).toBe(20)
    expect(allowance.windowLimits).toEqual(ROLLING_WINDOW_LIMITS.business!)
  })
})

describe('getPlanAllowance — unchanged tiers', () => {
  it('Basic gets $2.30/wk on its unchanged $8 price', () => {
    const allowance = getPlanAllowance('basic', legacyBasic.monthly)
    expect(allowance.legacy).toBe(false)
    expect(allowance.windowLimits).toEqual({ fiveHourUsd: 0.92, weeklyUsd: 2.3 })
    expect(allowance.monthlyIncludedUsdPerSeat).toBe(SEAT_INCLUDED_USD.basic)
  })

  it('Basic annual is not treated as a legacy allowance', () => {
    const allowance = getPlanAllowance('basic', legacyBasic.annual)
    expect(allowance.legacy).toBe(false)
    expect(allowance.windowLimits?.weeklyUsd).toBe(2.3)
  })

  it('Pro is unchanged and never legacy', () => {
    const allowance = getPlanAllowance('pro', LEGACY_PLAN_PRICES.staging.pro.monthly)
    expect(allowance.windowLimits).toEqual({ fiveHourUsd: 1.96, weeklyUsd: 4.9 })
    expect(allowance.monthlyIncludedUsdPerSeat).toBe(20)
    expect(allowance.legacy).toBe(false)
  })

  it('Enterprise stays uncapped', () => {
    expect(getPlanAllowance('enterprise', null).windowLimits).toBeNull()
  })
})

describe('getMonthlyIncludedForPlanAndPrice', () => {
  it('multiplies the legacy $40 allowance by seats', () => {
    expect(getMonthlyIncludedForPlanAndPrice('business', 3, legacyBusiness.monthly)).toBe(120)
  })

  it('multiplies the new $20 allowance by seats', () => {
    expect(getMonthlyIncludedForPlanAndPrice('business', 3, 'price_new_business_monthly')).toBe(60)
  })

  it('sums with grant free seats the same way allocateMonthlyIncluded does', () => {
    // 2 paid + 1 free grant seat = 3 seats
    expect(getMonthlyIncludedForPlanAndPrice('business', 3, legacyBusiness.monthly)).toBe(120)
  })

  it('Basic never multiplies by seats', () => {
    expect(getMonthlyIncludedForPlanAndPrice('basic', 10, legacyBasic.monthly)).toBe(SEAT_INCLUDED_USD.basic)
  })

  it('keeps the legacy tiered credit maths untouched', () => {
    expect(getMonthlyIncludedForPlanAndPrice('business_1200', 2, null)).toBe(120)
    expect(getMonthlyIncludedForPlanAndPrice('pro_200', 2, null)).toBe(20)
  })

  it('free is 0', () => {
    expect(getMonthlyIncludedForPlanAndPrice('free', 4, null)).toBe(0)
  })
})
