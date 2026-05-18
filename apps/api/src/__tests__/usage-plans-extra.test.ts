// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Extra tests for src/config/usage-plans.ts — exercises every branch
 * of `getMonthlyIncludedForPlan`:
 *
 *  - free / basic single-user (seats ignored).
 *  - pro / business / enterprise multi-seat multiplication.
 *  - seats argument clamping: 0, negative, fractional, undefined.
 *  - Legacy tier ids (`pro_200`, `business_1200`, `basic_50`) decoded
 *    as $0.10/credit.
 *  - Unknown plan ids return 0.
 *
 *   bun test apps/api/src/__tests__/usage-plans-extra.test.ts
 */

import { describe, expect, test } from 'bun:test'
import {
  DAILY_INCLUDED_USD,
  MONTHLY_DAILY_CAP_USD,
  SEAT_INCLUDED_USD,
  getMonthlyIncludedForPlan,
} from '../config/usage-plans'

describe('constants', () => {
  test('DAILY_INCLUDED_USD is $0.50', () => {
    expect(DAILY_INCLUDED_USD).toBe(0.5)
  })

  test('MONTHLY_DAILY_CAP_USD is $3.00', () => {
    expect(MONTHLY_DAILY_CAP_USD).toBe(3)
  })

  test('SEAT_INCLUDED_USD has all 5 plan tiers with expected values', () => {
    expect(SEAT_INCLUDED_USD.free).toBe(0)
    expect(SEAT_INCLUDED_USD.basic).toBe(5)
    expect(SEAT_INCLUDED_USD.pro).toBe(20)
    expect(SEAT_INCLUDED_USD.business).toBe(40)
    expect(SEAT_INCLUDED_USD.enterprise).toBe(2000)
  })
})

describe('getMonthlyIncludedForPlan — single-seat plans', () => {
  test('free with any seats returns 0 (single-user, seats ignored)', () => {
    expect(getMonthlyIncludedForPlan('free')).toBe(0)
    expect(getMonthlyIncludedForPlan('free', 1)).toBe(0)
    expect(getMonthlyIncludedForPlan('free', 50)).toBe(0)
  })

  test('basic with any seats returns $5 (single-user, seats ignored)', () => {
    expect(getMonthlyIncludedForPlan('basic')).toBe(5)
    expect(getMonthlyIncludedForPlan('basic', 1)).toBe(5)
    expect(getMonthlyIncludedForPlan('basic', 100)).toBe(5)
  })
})

describe('getMonthlyIncludedForPlan — multi-seat plans', () => {
  test('pro × 1 seat = $20', () => {
    expect(getMonthlyIncludedForPlan('pro')).toBe(20)
    expect(getMonthlyIncludedForPlan('pro', 1)).toBe(20)
  })

  test('pro × 5 seats = $100', () => {
    expect(getMonthlyIncludedForPlan('pro', 5)).toBe(100)
  })

  test('business × 3 seats = $120', () => {
    expect(getMonthlyIncludedForPlan('business', 3)).toBe(120)
  })

  test('enterprise × 10 seats = $20,000', () => {
    expect(getMonthlyIncludedForPlan('enterprise', 10)).toBe(20_000)
  })
})

describe('getMonthlyIncludedForPlan — seats-arg clamping', () => {
  test('seats=0 clamps to 1', () => {
    expect(getMonthlyIncludedForPlan('pro', 0)).toBe(20)
  })

  test('seats=-3 clamps to 1', () => {
    expect(getMonthlyIncludedForPlan('pro', -3)).toBe(20)
  })

  test('seats=2.7 floors to 2', () => {
    expect(getMonthlyIncludedForPlan('pro', 2.7)).toBe(40)
  })

  test('seats=NaN clamps to 1', () => {
    expect(getMonthlyIncludedForPlan('pro', NaN)).toBe(20)
  })

  test('seats omitted defaults to 1', () => {
    expect(getMonthlyIncludedForPlan('business')).toBe(40)
  })
})

describe('getMonthlyIncludedForPlan — legacy tier ids', () => {
  test('pro_200 → 200 × $0.10 = $20', () => {
    expect(getMonthlyIncludedForPlan('pro_200')).toBe(20)
  })

  test('business_1200 → 1200 × $0.10 = $120', () => {
    expect(getMonthlyIncludedForPlan('business_1200')).toBe(120)
  })

  test('basic_50 → 50 × $0.10 = $5', () => {
    expect(getMonthlyIncludedForPlan('basic_50')).toBe(5)
  })

  test('legacy id is INSENSITIVE to the seats argument (legacy plans were always 1-seat)', () => {
    expect(getMonthlyIncludedForPlan('pro_200', 5)).toBe(20)
    expect(getMonthlyIncludedForPlan('business_1200', 99)).toBe(120)
  })

  test('legacy with 0 credits → $0', () => {
    expect(getMonthlyIncludedForPlan('pro_0')).toBe(0)
  })

  test('legacy with large credit count → arithmetic is correct', () => {
    expect(getMonthlyIncludedForPlan('pro_9999')).toBeCloseTo(999.9, 1)
  })
})

describe('getMonthlyIncludedForPlan — unknown ids', () => {
  test('completely unknown id returns 0', () => {
    expect(getMonthlyIncludedForPlan('mystery')).toBe(0)
  })

  test('legacy-shape with WRONG family prefix → 0 (regex misses)', () => {
    expect(getMonthlyIncludedForPlan('enterprise_200')).toBe(0) // enterprise NOT in legacy regex
    expect(getMonthlyIncludedForPlan('team_200')).toBe(0)
  })

  test('legacy-shape with non-numeric credits → 0', () => {
    expect(getMonthlyIncludedForPlan('pro_abc')).toBe(0)
    expect(getMonthlyIncludedForPlan('pro_')).toBe(0)
  })

  test('empty string → 0', () => {
    expect(getMonthlyIncludedForPlan('')).toBe(0)
  })
})
