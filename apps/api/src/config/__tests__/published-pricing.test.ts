// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { PUBLISHED_PRICING, computePublishedCost, roundUsd } from '../published-pricing'
import {
  PUBLISHED_MAX_REPLICAS,
  PUBLISHED_SIZES,
  PUBLISHED_STAGING_ENVS,
  getPublishedPlanCaps,
} from '../usage-plans'

describe('published pricing', () => {
  it('charges pod-seconds by size tier', () => {
    // AC 12: one hour of a 2-pod M env == 2 × 3600 × podSecond[m]
    const cost = computePublishedCost({ podSeconds: { m: 2 * 3600 } })
    expect(cost.podUsd).toBeCloseTo(2 * 3600 * PUBLISHED_PRICING.podSecond.m, 10)
    expect(cost.dbUsd).toBe(0)
    expect(cost.egressUsd).toBe(0)
  })

  it('makes size L cost more per second than S', () => {
    const s = computePublishedCost({ podSeconds: { s: 3600 } }).podUsd
    const l = computePublishedCost({ podSeconds: { l: 3600 } }).podUsd
    expect(l).toBeGreaterThan(s)
  })

  it('scale-to-zero time costs nothing', () => {
    expect(computePublishedCost({ podSeconds: { m: 0 } }).totalUsd).toBe(0)
  })

  it('sums pod-seconds across sizes', () => {
    const cost = computePublishedCost({ podSeconds: { s: 60, m: 60 } })
    expect(cost.podUsd).toBeCloseTo(
      60 * PUBLISHED_PRICING.podSecond.s + 60 * PUBLISHED_PRICING.podSecond.m,
      10,
    )
  })

  it('bills DB storage per GB-month, prorated by monthFraction', () => {
    const full = computePublishedCost({ podSeconds: {}, dbStorageBytes: 1024 ** 3 })
    expect(full.dbUsd).toBeCloseTo(PUBLISHED_PRICING.dbGBMonth, 10)
    const slice = computePublishedCost(
      { podSeconds: {}, dbStorageBytes: 1024 ** 3, monthFraction: 1 / 30 },
      PUBLISHED_PRICING,
    )
    expect(slice.dbUsd).toBeCloseTo(PUBLISHED_PRICING.dbGBMonth / 30, 10)
  })

  it('bills egress per GB', () => {
    expect(computePublishedCost({ podSeconds: {}, egressBytes: 1024 ** 3 }).egressUsd).toBeCloseTo(
      PUBLISHED_PRICING.egressGB,
      10,
    )
  })

  it('rounds to 6dp like consumeUsage records', () => {
    expect(roundUsd(0.123456789)).toBe(0.123457)
  })
})

describe('published plan caps', () => {
  it('free/basic are capped at one replica and size s, no staging', () => {
    for (const plan of ['free', 'basic']) {
      const caps = getPublishedPlanCaps(plan)
      expect(caps.maxReplicas).toBe(1)
      expect(caps.sizes).toEqual(['s'])
      expect(caps.staging).toBe(false)
    }
  })

  it('pro can scale to 5 and gets staging; business to 20 and size l', () => {
    expect(getPublishedPlanCaps('pro')).toEqual({
      plan: 'pro',
      maxReplicas: 5,
      sizes: ['s', 'm'],
      staging: true,
    })
    expect(getPublishedPlanCaps('business').maxReplicas).toBe(20)
    expect(getPublishedPlanCaps('business').sizes).toEqual(['s', 'm', 'l'])
  })

  it('enterprise is unlimited', () => {
    expect(getPublishedPlanCaps('enterprise').maxReplicas).toBeNull()
    expect(getPublishedPlanCaps('enterprise').staging).toBe(true)
  })

  it('unknown plan ids fall back to free', () => {
    expect(getPublishedPlanCaps('nonsense').plan).toBe('free')
    expect(getPublishedPlanCaps(null).plan).toBe('free')
  })

  it('keeps the cap tables in sync across plans', () => {
    for (const plan of Object.keys(PUBLISHED_MAX_REPLICAS) as Array<keyof typeof PUBLISHED_MAX_REPLICAS>) {
      expect(PUBLISHED_SIZES[plan]).toBeDefined()
      expect(PUBLISHED_STAGING_ENVS[plan]).toBeDefined()
    }
  })
})
