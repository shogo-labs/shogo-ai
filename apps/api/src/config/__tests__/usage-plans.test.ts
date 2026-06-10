// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, it } from 'bun:test'
import {
  FREE_DAILY_INCLUDED_USD,
  MONTHLY_DAILY_CAP_USD,
  FIVE_HOUR_MS,
  SEVEN_DAY_MS,
  WEEKS_PER_MONTH,
  TARGET_COMPUTE_COST_RATIO,
  PLAN_INCLUDED_USD,
  PLAN_VOICE_RATE_OVERRIDES,
  ROLLING_WINDOW_LIMITS,
  SEAT_INCLUDED_USD,
  VOICE_RAW_USD,
  comparePlanRank,
  getClaimedPodCapForPlan,
  getDailyIncludedForPlan,
  getMonthlyIncludedForPlan,
  getMonthlyIncludedEquivalent,
  getWindowLimitsForPlan,
  normalizePlanId,
} from '../usage-plans'
import { MARKUP_MULTIPLIER } from '../../lib/usage-cost'

/** List monthly subscription prices used for the don't-lose-money assertions. */
const LIST_MONTHLY_PRICE: Record<'basic' | 'pro' | 'business', number> = {
  basic: 8,
  pro: 20,
  business: 40,
}

describe('rolling usage windows', () => {
  it('FIVE_HOUR_MS and SEVEN_DAY_MS are correct durations', () => {
    expect(FIVE_HOUR_MS).toBe(5 * 60 * 60 * 1000)
    expect(SEVEN_DAY_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('ROLLING_WINDOW_LIMITS covers all tiers with enterprise uncapped', () => {
    expect(ROLLING_WINDOW_LIMITS.free).toEqual({ fiveHourUsd: 0.2, weeklyUsd: 0.5 })
    expect(ROLLING_WINDOW_LIMITS.basic).toEqual({ fiveHourUsd: 0.76, weeklyUsd: 1.9 })
    expect(ROLLING_WINDOW_LIMITS.pro).toEqual({ fiveHourUsd: 1.96, weeklyUsd: 4.9 })
    expect(ROLLING_WINDOW_LIMITS.business).toEqual({ fiveHourUsd: 3.96, weeklyUsd: 9.9 })
    expect(ROLLING_WINDOW_LIMITS.enterprise).toBeNull()
  })

  it('getWindowLimitsForPlan falls back to free for unknown/null plans', () => {
    expect(getWindowLimitsForPlan(null)).toEqual(ROLLING_WINDOW_LIMITS.free!)
    expect(getWindowLimitsForPlan('???')).toEqual(ROLLING_WINDOW_LIMITS.free!)
  })

  it('does not scale free/basic by seats', () => {
    expect(getWindowLimitsForPlan('free', 10)).toEqual(ROLLING_WINDOW_LIMITS.free!)
    expect(getWindowLimitsForPlan('basic', 10)).toEqual(ROLLING_WINDOW_LIMITS.basic!)
  })

  it('scales pro/business per seat', () => {
    const pro = ROLLING_WINDOW_LIMITS.pro!
    expect(getWindowLimitsForPlan('pro', 3)).toEqual({
      fiveHourUsd: pro.fiveHourUsd * 3,
      weeklyUsd: pro.weeklyUsd * 3,
    })
    const biz = ROLLING_WINDOW_LIMITS.business!
    expect(getWindowLimitsForPlan('business', 2)).toEqual({
      fiveHourUsd: biz.fiveHourUsd * 2,
      weeklyUsd: biz.weeklyUsd * 2,
    })
  })

  it('clamps seats to a minimum of 1', () => {
    expect(getWindowLimitsForPlan('pro', 0)).toEqual({ fiveHourUsd: 1.96, weeklyUsd: 4.9 })
  })

  it('returns null for enterprise regardless of seats', () => {
    expect(getWindowLimitsForPlan('enterprise', 50)).toBeNull()
  })

  it('5-hour window is 40% of the weekly budget for every capped tier', () => {
    for (const plan of ['free', 'basic', 'pro', 'business'] as const) {
      const w = ROLLING_WINDOW_LIMITS[plan]!
      expect(w.fiveHourUsd).toBeCloseTo(w.weeklyUsd * 0.4, 10)
    }
  })

  it('window limits keep the worst-case monthly compute COGS within target', () => {
    // Worst case: a user pins their windows continuously for a whole month.
    // monthly provider COGS = weeklyUsd × WEEKS_PER_MONTH / MARKUP.
    for (const plan of ['basic', 'pro', 'business'] as const) {
      const weekly = getWindowLimitsForPlan(plan, 1)!.weeklyUsd
      const monthlyCogsRaw = (weekly * WEEKS_PER_MONTH) / MARKUP_MULTIPLIER
      const ratio = monthlyCogsRaw / LIST_MONTHLY_PRICE[plan]
      expect(ratio).toBeLessThanOrEqual(TARGET_COMPUTE_COST_RATIO)
    }
  })

  it('per-seat windows preserve the COGS ratio at any seat count', () => {
    const seats = 7
    const weekly = getWindowLimitsForPlan('pro', seats)!.weeklyUsd
    const monthlyCogsRaw = (weekly * WEEKS_PER_MONTH) / MARKUP_MULTIPLIER
    const ratio = monthlyCogsRaw / (LIST_MONTHLY_PRICE.pro * seats)
    expect(ratio).toBeLessThanOrEqual(TARGET_COMPUTE_COST_RATIO)
  })
})

describe('getMonthlyIncludedEquivalent', () => {
  it('WEEKS_PER_MONTH ≈ 4.348', () => {
    expect(WEEKS_PER_MONTH).toBeCloseTo(4.3482, 3)
  })

  it('is weeklyUsd × WEEKS_PER_MONTH for capped plans', () => {
    expect(getMonthlyIncludedEquivalent('pro', 1)).toBeCloseTo(4.9 * WEEKS_PER_MONTH, 10)
    expect(getMonthlyIncludedEquivalent('basic')).toBeCloseTo(1.9 * WEEKS_PER_MONTH, 10)
  })

  it('scales pro/business per seat', () => {
    expect(getMonthlyIncludedEquivalent('pro', 4)).toBeCloseTo(
      getMonthlyIncludedEquivalent('pro', 1)! * 4,
      10,
    )
  })

  it('returns null for uncapped enterprise', () => {
    expect(getMonthlyIncludedEquivalent('enterprise')).toBeNull()
    expect(getMonthlyIncludedEquivalent('enterprise', 10)).toBeNull()
  })

  it('falls back to the free window for unknown plans', () => {
    expect(getMonthlyIncludedEquivalent('platinum')).toBeCloseTo(0.5 * WEEKS_PER_MONTH, 10)
  })
})

describe('constants', () => {
  it('FREE_DAILY_INCLUDED_USD is $1.00', () => {
    expect(FREE_DAILY_INCLUDED_USD).toBe(1.0)
  })

  it('MONTHLY_DAILY_CAP_USD is $5.00', () => {
    expect(MONTHLY_DAILY_CAP_USD).toBe(5.0)
  })

  it('SEAT_INCLUDED_USD covers all five plan tiers', () => {
    expect(SEAT_INCLUDED_USD).toEqual({
      free: 0,
      basic: 5,
      pro: 20,
      business: 40,
      enterprise: 2000,
    })
  })

  it('PLAN_INCLUDED_USD (deprecated) is exported with legacy business=20', () => {
    expect(PLAN_INCLUDED_USD.business).toBe(20)
    expect(PLAN_INCLUDED_USD.basic).toBe(5)
  })

  it('VOICE_RAW_USD has the four required telephony keys', () => {
    expect(VOICE_RAW_USD.minutesInbound).toBe(0.2)
    expect(VOICE_RAW_USD.minutesOutbound).toBe(0.24)
    expect(VOICE_RAW_USD.numberSetup).toBe(2.0)
    expect(VOICE_RAW_USD.numberMonthly).toBe(3.0)
  })

  it('PLAN_VOICE_RATE_OVERRIDES is empty by default', () => {
    expect(PLAN_VOICE_RATE_OVERRIDES).toEqual({})
  })

  it('plan ladder is monotonically non-decreasing free<basic<pro<business<enterprise', () => {
    expect(SEAT_INCLUDED_USD.free).toBeLessThan(SEAT_INCLUDED_USD.basic)
    expect(SEAT_INCLUDED_USD.basic).toBeLessThan(SEAT_INCLUDED_USD.pro)
    expect(SEAT_INCLUDED_USD.pro).toBeLessThan(SEAT_INCLUDED_USD.business)
    expect(SEAT_INCLUDED_USD.business).toBeLessThan(SEAT_INCLUDED_USD.enterprise)
  })
})

describe('getMonthlyIncludedForPlan — known plans', () => {
  it('returns 0 for free plan regardless of seats', () => {
    expect(getMonthlyIncludedForPlan('free')).toBe(0)
    expect(getMonthlyIncludedForPlan('free', 5)).toBe(0)
    expect(getMonthlyIncludedForPlan('free', 100)).toBe(0)
  })

  it('returns 5 for basic plan and ignores seats (single-user)', () => {
    expect(getMonthlyIncludedForPlan('basic')).toBe(5)
    expect(getMonthlyIncludedForPlan('basic', 1)).toBe(5)
    expect(getMonthlyIncludedForPlan('basic', 50)).toBe(5)
  })

  it('multiplies pro plan by seats', () => {
    expect(getMonthlyIncludedForPlan('pro')).toBe(20)
    expect(getMonthlyIncludedForPlan('pro', 1)).toBe(20)
    expect(getMonthlyIncludedForPlan('pro', 3)).toBe(60)
    expect(getMonthlyIncludedForPlan('pro', 10)).toBe(200)
  })

  it('multiplies business plan by seats', () => {
    expect(getMonthlyIncludedForPlan('business', 1)).toBe(40)
    expect(getMonthlyIncludedForPlan('business', 2)).toBe(80)
    expect(getMonthlyIncludedForPlan('business', 25)).toBe(1000)
  })

  it('multiplies enterprise plan by seats', () => {
    expect(getMonthlyIncludedForPlan('enterprise', 1)).toBe(2000)
    expect(getMonthlyIncludedForPlan('enterprise', 4)).toBe(8000)
  })
})

describe('getMonthlyIncludedForPlan — seat coercion', () => {
  it('treats 0 seats as 1', () => {
    expect(getMonthlyIncludedForPlan('pro', 0)).toBe(20)
  })

  it('treats negative seats as 1', () => {
    expect(getMonthlyIncludedForPlan('pro', -3)).toBe(20)
  })

  it('floors fractional seats', () => {
    expect(getMonthlyIncludedForPlan('pro', 3.9)).toBe(60)
    expect(getMonthlyIncludedForPlan('pro', 1.4)).toBe(20)
  })

  it('treats NaN seats as 1', () => {
    expect(getMonthlyIncludedForPlan('pro', NaN)).toBe(20)
  })

  it('defaults seats to 1 when omitted', () => {
    expect(getMonthlyIncludedForPlan('business')).toBe(40)
  })
})

describe('getMonthlyIncludedForPlan — legacy tier ids', () => {
  it('decodes pro_200 to $20 ($0.10/credit × 200)', () => {
    expect(getMonthlyIncludedForPlan('pro_200')).toBe(20)
  })

  it('decodes business_1200 to $120', () => {
    expect(getMonthlyIncludedForPlan('business_1200')).toBeCloseTo(120, 10)
  })

  it('decodes basic_50 to $5', () => {
    expect(getMonthlyIncludedForPlan('basic_50')).toBe(5)
  })

  it('ignores seats for legacy tier ids', () => {
    expect(getMonthlyIncludedForPlan('pro_200', 5)).toBe(20)
  })

  it('does not match similar-but-invalid legacy patterns', () => {
    expect(getMonthlyIncludedForPlan('enterprise_1000')).toBe(0)
    expect(getMonthlyIncludedForPlan('PRO_200')).toBe(0)
    expect(getMonthlyIncludedForPlan('pro_')).toBe(0)
    expect(getMonthlyIncludedForPlan('pro_abc')).toBe(0)
    expect(getMonthlyIncludedForPlan('pro_200_extra')).toBe(0)
  })
})

describe('getMonthlyIncludedForPlan — unknown plan ids', () => {
  it('returns 0 for empty string', () => {
    expect(getMonthlyIncludedForPlan('')).toBe(0)
  })

  it('returns 0 for unknown plan', () => {
    expect(getMonthlyIncludedForPlan('platinum')).toBe(0)
  })

  it('returns 0 for whitespace', () => {
    expect(getMonthlyIncludedForPlan('  pro  ')).toBe(0)
  })

  it('is case-sensitive on canonical plan ids', () => {
    expect(getMonthlyIncludedForPlan('PRO')).toBe(0)
    expect(getMonthlyIncludedForPlan('Pro')).toBe(0)
  })
})


describe('normalizePlanId', () => {
  it('returns null for null / undefined / empty', () => {
    expect(normalizePlanId(null)).toBeNull()
    expect(normalizePlanId(undefined)).toBeNull()
    expect(normalizePlanId('')).toBeNull()
  })

  it('maps canonical tier ids', () => {
    expect(normalizePlanId('free')).toBe('free')
    expect(normalizePlanId('basic')).toBe('basic')
    expect(normalizePlanId('pro')).toBe('pro')
    expect(normalizePlanId('business')).toBe('business')
    expect(normalizePlanId('enterprise')).toBe('enterprise')
  })

  it('is case-insensitive and trims whitespace', () => {
    expect(normalizePlanId('  FREE  ')).toBe('free')
    expect(normalizePlanId('Pro')).toBe('pro')
    expect(normalizePlanId('BUSINESS')).toBe('business')
  })

  it('prefix-matches decorated tier ids', () => {
    expect(normalizePlanId('Free-Forever')).toBe('free')
    expect(normalizePlanId('basic_monthly')).toBe('basic')
    expect(normalizePlanId('pro_200')).toBe('pro')
    expect(normalizePlanId('business-Annual')).toBe('business')
    expect(normalizePlanId('Enterprise-XL')).toBe('enterprise')
  })

  it('returns null for unknown tier ids', () => {
    expect(normalizePlanId('platinum')).toBeNull()
    expect(normalizePlanId('starter')).toBeNull()
    expect(normalizePlanId('unknown-plan')).toBeNull()
  })
})

describe('getDailyIncludedForPlan', () => {
  it('returns $1 for the free plan', () => {
    expect(getDailyIncludedForPlan('free')).toBe(1)
  })

  it('returns $0 for every paid plan', () => {
    expect(getDailyIncludedForPlan('basic')).toBe(0)
    expect(getDailyIncludedForPlan('pro')).toBe(0)
    expect(getDailyIncludedForPlan('business')).toBe(0)
    expect(getDailyIncludedForPlan('enterprise')).toBe(0)
  })

  it('normalizes decorated plan ids before resolving', () => {
    expect(getDailyIncludedForPlan('Free-Forever')).toBe(1)
    expect(getDailyIncludedForPlan('pro_200')).toBe(0)
    expect(getDailyIncludedForPlan('Business-Annual')).toBe(0)
  })

  it('falls back to the free amount for unknown / missing ids (safety net)', () => {
    expect(getDailyIncludedForPlan(null)).toBe(1)
    expect(getDailyIncludedForPlan(undefined)).toBe(1)
    expect(getDailyIncludedForPlan('')).toBe(1)
    expect(getDailyIncludedForPlan('platinum')).toBe(1)
  })
})

describe('comparePlanRank', () => {
  it('ranks canonical tiers in ascending order', () => {
    const tiers = ['business', 'free', 'pro', 'enterprise', 'basic']
    const sorted = [...tiers].sort(comparePlanRank)
    expect(sorted).toEqual(['free', 'basic', 'pro', 'business', 'enterprise'])
  })

  it('returns negative / zero / positive correctly', () => {
    expect(comparePlanRank('free', 'pro')).toBeLessThan(0)
    expect(comparePlanRank('pro', 'pro')).toBe(0)
    expect(comparePlanRank('enterprise', 'basic')).toBeGreaterThan(0)
  })

  it('treats unknown plans as free', () => {
    expect(comparePlanRank('platinum', 'free')).toBe(0)
    expect(comparePlanRank('unknown', 'pro')).toBeLessThan(0)
    expect(comparePlanRank(null, undefined)).toBe(0)
  })

  it('normalizes decorated ids before comparing', () => {
    expect(comparePlanRank('Pro-Annual', 'business_monthly')).toBeLessThan(0)
    expect(comparePlanRank('Enterprise-XL', 'pro_200')).toBeGreaterThan(0)
  })
})

describe('getClaimedPodCapForPlan', () => {
  const ORIGINAL_OVERRIDE = process.env.WARM_POOL_CLAIMED_CAP_BY_TIER

  afterEach(() => {
    if (ORIGINAL_OVERRIDE === undefined) delete process.env.WARM_POOL_CLAIMED_CAP_BY_TIER
    else process.env.WARM_POOL_CLAIMED_CAP_BY_TIER = ORIGINAL_OVERRIDE
  })

  it('scales linearly with tier rank (PLAN_RANK + 2)', () => {
    delete process.env.WARM_POOL_CLAIMED_CAP_BY_TIER
    expect(getClaimedPodCapForPlan('free')).toBe(2)
    expect(getClaimedPodCapForPlan('basic')).toBe(3)
    expect(getClaimedPodCapForPlan('pro')).toBe(4)
    expect(getClaimedPodCapForPlan('business')).toBe(5)
    expect(getClaimedPodCapForPlan('enterprise')).toBe(6)
  })

  it('normalizes decorated plan ids before resolving', () => {
    delete process.env.WARM_POOL_CLAIMED_CAP_BY_TIER
    expect(getClaimedPodCapForPlan('Pro-Annual')).toBe(4)
    expect(getClaimedPodCapForPlan('business_monthly')).toBe(5)
    expect(getClaimedPodCapForPlan('Enterprise-XL')).toBe(6)
  })

  it('falls back to the free cap for unknown / missing ids', () => {
    delete process.env.WARM_POOL_CLAIMED_CAP_BY_TIER
    expect(getClaimedPodCapForPlan(null)).toBe(2)
    expect(getClaimedPodCapForPlan(undefined)).toBe(2)
    expect(getClaimedPodCapForPlan('')).toBe(2)
    expect(getClaimedPodCapForPlan('platinum')).toBe(2)
  })

  it('applies per-tier env overrides over the linear default', () => {
    process.env.WARM_POOL_CLAIMED_CAP_BY_TIER = JSON.stringify({ free: 1, pro: 10 })
    expect(getClaimedPodCapForPlan('free')).toBe(1)
    expect(getClaimedPodCapForPlan('pro')).toBe(10)
    // tiers not present in the override keep the linear default
    expect(getClaimedPodCapForPlan('business')).toBe(5)
  })

  it('ignores malformed override JSON and uses the linear default', () => {
    process.env.WARM_POOL_CLAIMED_CAP_BY_TIER = '{not valid json'
    expect(getClaimedPodCapForPlan('free')).toBe(2)
    expect(getClaimedPodCapForPlan('pro')).toBe(4)
  })
})
