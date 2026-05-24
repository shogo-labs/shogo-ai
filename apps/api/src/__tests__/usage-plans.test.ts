// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  FREE_DAILY_INCLUDED_USD,
  MONTHLY_DAILY_CAP_USD,
  PLAN_INCLUDED_USD,
  PLAN_VOICE_RATE_OVERRIDES,
  SEAT_INCLUDED_USD,
  VOICE_RAW_USD,
  getDailyIncludedForPlan,
  getMonthlyIncludedForPlan,
} from '../config/usage-plans'

describe('module constants', () => {
  test('FREE_DAILY_INCLUDED_USD is $1.00 (documented free-tier daily allowance)', () => {
    expect(FREE_DAILY_INCLUDED_USD).toBe(1.0)
  })

  test('MONTHLY_DAILY_CAP_USD is $5.00 (free-tier monthly cap)', () => {
    expect(MONTHLY_DAILY_CAP_USD).toBe(5.0)
  })

  test('getDailyIncludedForPlan returns $1 only for the free tier', () => {
    expect(getDailyIncludedForPlan('free')).toBe(1)
    expect(getDailyIncludedForPlan('basic')).toBe(0)
    expect(getDailyIncludedForPlan('pro')).toBe(0)
    expect(getDailyIncludedForPlan('business')).toBe(0)
    expect(getDailyIncludedForPlan('enterprise')).toBe(0)
  })

  test('SEAT_INCLUDED_USD has the documented ladder', () => {
    expect(SEAT_INCLUDED_USD.free).toBe(0)
    expect(SEAT_INCLUDED_USD.basic).toBe(5)
    expect(SEAT_INCLUDED_USD.pro).toBe(20)
    expect(SEAT_INCLUDED_USD.business).toBe(40)
    expect(SEAT_INCLUDED_USD.enterprise).toBe(2000)
  })

  test('SEAT_INCLUDED_USD ladder is strictly monotonic (free < basic < pro < business < enterprise)', () => {
    const order: Array<keyof typeof SEAT_INCLUDED_USD> = [
      'free',
      'basic',
      'pro',
      'business',
      'enterprise',
    ]
    for (let i = 1; i < order.length; i++) {
      expect(SEAT_INCLUDED_USD[order[i]]).toBeGreaterThan(SEAT_INCLUDED_USD[order[i - 1]])
    }
  })

  test('PLAN_INCLUDED_USD (deprecated) is preserved for backwards compat', () => {
    // The deprecated map differs from SEAT_INCLUDED_USD on `business` ($20 vs $40).
    // This test pins that difference so future "cleanups" don't silently
    // change grandfathered behavior.
    expect(PLAN_INCLUDED_USD.business).toBe(20)
    expect(SEAT_INCLUDED_USD.business).toBe(40)
    expect(PLAN_INCLUDED_USD.free).toBe(0)
    expect(PLAN_INCLUDED_USD.basic).toBe(5)
    expect(PLAN_INCLUDED_USD.pro).toBe(20)
    expect(PLAN_INCLUDED_USD.enterprise).toBe(2000)
  })

  test('VOICE_RAW_USD has the documented per-minute and number rates', () => {
    expect(VOICE_RAW_USD.minutesInbound).toBe(0.2)
    expect(VOICE_RAW_USD.minutesOutbound).toBe(0.24)
    expect(VOICE_RAW_USD.numberSetup).toBe(2.0)
    expect(VOICE_RAW_USD.numberMonthly).toBe(3.0)
  })

  test('outbound voice minutes are more expensive than inbound', () => {
    expect(VOICE_RAW_USD.minutesOutbound).toBeGreaterThan(VOICE_RAW_USD.minutesInbound)
  })

  test('PLAN_VOICE_RATE_OVERRIDES is empty by default (flat rates for everyone)', () => {
    expect(Object.keys(PLAN_VOICE_RATE_OVERRIDES)).toHaveLength(0)
  })
})

describe('getMonthlyIncludedForPlan — supported plan ids', () => {
  test('free returns 0 regardless of seats', () => {
    expect(getMonthlyIncludedForPlan('free')).toBe(0)
    expect(getMonthlyIncludedForPlan('free', 5)).toBe(0)
    expect(getMonthlyIncludedForPlan('free', 100)).toBe(0)
  })

  test('basic is single-user and ignores seat count', () => {
    expect(getMonthlyIncludedForPlan('basic')).toBe(5)
    expect(getMonthlyIncludedForPlan('basic', 1)).toBe(5)
    expect(getMonthlyIncludedForPlan('basic', 10)).toBe(5)
    expect(getMonthlyIncludedForPlan('basic', 100)).toBe(5)
  })

  test('pro scales linearly with seats', () => {
    expect(getMonthlyIncludedForPlan('pro')).toBe(20)
    expect(getMonthlyIncludedForPlan('pro', 1)).toBe(20)
    expect(getMonthlyIncludedForPlan('pro', 3)).toBe(60)
    expect(getMonthlyIncludedForPlan('pro', 10)).toBe(200)
  })

  test('business scales linearly with seats', () => {
    expect(getMonthlyIncludedForPlan('business')).toBe(40)
    expect(getMonthlyIncludedForPlan('business', 2)).toBe(80)
    expect(getMonthlyIncludedForPlan('business', 25)).toBe(1000)
  })

  test('enterprise scales linearly with seats', () => {
    expect(getMonthlyIncludedForPlan('enterprise')).toBe(2000)
    expect(getMonthlyIncludedForPlan('enterprise', 10)).toBe(20_000)
  })
})

describe('getMonthlyIncludedForPlan — seat-count safety', () => {
  test('coerces seats=0 up to 1', () => {
    expect(getMonthlyIncludedForPlan('pro', 0)).toBe(20)
  })

  test('coerces negative seat counts up to 1', () => {
    expect(getMonthlyIncludedForPlan('pro', -5)).toBe(20)
    expect(getMonthlyIncludedForPlan('business', -100)).toBe(40)
  })

  test('floors fractional seat counts (no fractional billing)', () => {
    expect(getMonthlyIncludedForPlan('pro', 2.9)).toBe(40)
    expect(getMonthlyIncludedForPlan('pro', 3.0001)).toBe(60)
    expect(getMonthlyIncludedForPlan('business', 1.999)).toBe(40)
  })

  test('NaN seats collapse to 1', () => {
    // `seats || 1` short-circuits on NaN (NaN is falsy).
    expect(getMonthlyIncludedForPlan('pro', NaN)).toBe(20)
  })

  test('undefined seats default to 1', () => {
    expect(getMonthlyIncludedForPlan('pro', undefined as unknown as number)).toBe(20)
  })
})

describe('getMonthlyIncludedForPlan — legacy credit-tier ids', () => {
  test('pro_200 → $20 ($0.10/credit × 200)', () => {
    expect(getMonthlyIncludedForPlan('pro_200')).toBe(20)
  })

  test('business_1200 → $120 ($0.10/credit × 1200)', () => {
    expect(getMonthlyIncludedForPlan('business_1200')).toBe(120)
  })

  test('basic_50 → $5', () => {
    expect(getMonthlyIncludedForPlan('basic_50')).toBe(5)
  })

  test('legacy ids ignore the seats argument (credit count is absolute)', () => {
    expect(getMonthlyIncludedForPlan('pro_200', 5)).toBe(20)
    expect(getMonthlyIncludedForPlan('business_1200', 10)).toBe(120)
  })

  test('legacy regex only matches basic|pro|business — not enterprise or free', () => {
    expect(getMonthlyIncludedForPlan('enterprise_1000')).toBe(0)
    expect(getMonthlyIncludedForPlan('free_100')).toBe(0)
  })

  test('legacy regex rejects malformed variants', () => {
    expect(getMonthlyIncludedForPlan('pro_')).toBe(0)
    expect(getMonthlyIncludedForPlan('pro_200_extra')).toBe(0)
    expect(getMonthlyIncludedForPlan('Pro_200')).toBe(0) // case-sensitive
    expect(getMonthlyIncludedForPlan('pro-200')).toBe(0) // dash, not underscore
    expect(getMonthlyIncludedForPlan('pro_abc')).toBe(0) // non-numeric credits
  })

  test('legacy regex preserves the supported-plan fast path (no double-dipping)', () => {
    // "pro" matches the SEAT_INCLUDED_USD map BEFORE the regex check runs.
    // This guards against a refactor that runs the regex first and returns 0.
    expect(getMonthlyIncludedForPlan('pro')).toBe(20)
    expect(getMonthlyIncludedForPlan('business')).toBe(40)
  })
})

describe('getMonthlyIncludedForPlan — unknown plan ids', () => {
  test('returns 0 for completely unknown plans', () => {
    expect(getMonthlyIncludedForPlan('platinum')).toBe(0)
    expect(getMonthlyIncludedForPlan('legacy_v2')).toBe(0)
  })

  test('returns 0 for empty string', () => {
    expect(getMonthlyIncludedForPlan('')).toBe(0)
  })
})
