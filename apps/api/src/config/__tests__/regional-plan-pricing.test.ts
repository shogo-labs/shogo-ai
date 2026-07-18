// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `buildRegionalPlans` — the `/api/billing/regional-pricing`
 * endpoint's plan-conversion helper.
 *
 * Regression coverage for a bug where the endpoint only defined `basic` (plus
 * a pile of dead legacy tier keys like `pro_200`) and had no `pro` /
 * `business` keys, so the Pro and Business plan cards silently fell back to
 * raw USD while Basic converted to local currency — producing mismatched
 * pricing across the three cards.
 */

import { describe, test, expect } from 'bun:test'
import { buildRegionalPlans, REGIONAL_PLAN_USD_BASE } from '../regional-plan-pricing'

describe('buildRegionalPlans', () => {
  test('returns free, basic, pro, and business keys', () => {
    const plans = buildRegionalPlans((usd) => usd)
    expect(Object.keys(plans).sort()).toEqual(['basic', 'business', 'free', 'pro'])
  })

  test('converts every plan — not just basic — using the supplied rate', () => {
    // KRW-like flat rate of 1320, rounded to whole units (KRW has 0 decimals).
    const rate = 1320
    const convert = (usd: number) => Math.round(usd * rate)
    const plans = buildRegionalPlans(convert)

    expect(plans.basic).toEqual({ monthly: 8 * rate, annual: 80 * rate })
    expect(plans.pro).toEqual({ monthly: 20 * rate, annual: 200 * rate })
    expect(plans.business).toEqual({ monthly: 40 * rate, annual: 400 * rate })
  })

  test('free plan is always zero regardless of conversion rate', () => {
    const plans = buildRegionalPlans((usd) => usd * 999)
    expect(plans.free).toEqual({ monthly: 0, annual: 0 })
  })

  test('USD base prices match the per-seat plan ladder ($8/$20/$40 monthly)', () => {
    expect(REGIONAL_PLAN_USD_BASE.basic.monthly).toBe(8)
    expect(REGIONAL_PLAN_USD_BASE.pro.monthly).toBe(20)
    expect(REGIONAL_PLAN_USD_BASE.business.monthly).toBe(40)
    expect(REGIONAL_PLAN_USD_BASE.basic.annual).toBe(80)
    expect(REGIONAL_PLAN_USD_BASE.pro.annual).toBe(200)
    expect(REGIONAL_PLAN_USD_BASE.business.annual).toBe(400)
  })

  test('applies the convert function independently to monthly and annual', () => {
    const seen: number[] = []
    const convert = (usd: number) => {
      seen.push(usd)
      return usd
    }
    buildRegionalPlans(convert)
    // 4 plans × (monthly, annual) = 8 calls.
    expect(seen.length).toBe(8)
  })
})
