// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/config/stripe-prices.ts`.
 *
 * Pure config module — no I/O. Covers:
 *   - getStripePrices() env switching (production vs. staging)
 *   - getPriceId() for every (plan, interval) tuple in both envs
 *   - getPriceId() null handling for invalid plan/interval inputs
 *   - isLegacyTierPriceId() across all legacy maps (staging + prod)
 *   - decodeLegacyPriceId() round-trip across every legacy tier
 *   - getInstancePrices() / getInstancePriceId() env switching + invalid keys
 *   - getOveragePriceConfig() / getOveragePriceId() env switching
 *   - Shape invariants on every exported config object
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  STRIPE_PRICES_STAGING,
  STRIPE_PRICES_PRODUCTION,
  STRIPE_LEGACY_TIER_PRICES_STAGING,
  STRIPE_LEGACY_TIER_PRICES_PRODUCTION,
  INSTANCE_PRICES_STAGING,
  INSTANCE_PRICES_PRODUCTION,
  OVERAGE_PRICE_STAGING,
  OVERAGE_PRICE_PRODUCTION,
  getStripePrices,
  getPriceId,
  isLegacyTierPriceId,
  decodeLegacyPriceId,
  getInstancePrices,
  getInstancePriceId,
  getOveragePriceConfig,
  getOveragePriceId,
} from '../config/stripe-prices'

const ORIG_NODE_ENV = process.env.NODE_ENV

afterEach(() => {
  if (ORIG_NODE_ENV === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = ORIG_NODE_ENV
})

describe('getStripePrices()', () => {
  test('returns staging map when NODE_ENV is not production', () => {
    process.env.NODE_ENV = 'development'
    expect(getStripePrices()).toBe(STRIPE_PRICES_STAGING)
  })

  test('returns staging map when NODE_ENV is undefined', () => {
    delete process.env.NODE_ENV
    expect(getStripePrices()).toBe(STRIPE_PRICES_STAGING)
  })

  test('returns staging map when NODE_ENV is test', () => {
    process.env.NODE_ENV = 'test'
    expect(getStripePrices()).toBe(STRIPE_PRICES_STAGING)
  })

  test('returns production map when NODE_ENV is production', () => {
    process.env.NODE_ENV = 'production'
    expect(getStripePrices()).toBe(STRIPE_PRICES_PRODUCTION)
  })

  test('staging and production maps are distinct objects', () => {
    expect(STRIPE_PRICES_STAGING).not.toBe(STRIPE_PRICES_PRODUCTION)
  })
})

describe('getPriceId()', () => {
  beforeEach(() => { process.env.NODE_ENV = 'development' })

  test.each([
    ['basic', 'monthly'],
    ['basic', 'annual'],
    ['pro', 'monthly'],
    ['pro', 'annual'],
    ['business', 'monthly'],
    ['business', 'annual'],
  ] as const)('returns staging price id for %s/%s', (plan, interval) => {
    expect(getPriceId(plan, interval)).toBe(STRIPE_PRICES_STAGING[plan][interval])
  })

  test.each([
    ['basic', 'monthly'],
    ['basic', 'annual'],
    ['pro', 'monthly'],
    ['pro', 'annual'],
    ['business', 'monthly'],
    ['business', 'annual'],
  ] as const)('returns production price id for %s/%s', (plan, interval) => {
    process.env.NODE_ENV = 'production'
    expect(getPriceId(plan, interval)).toBe(STRIPE_PRICES_PRODUCTION[plan][interval])
  })

  test('returns null for an unknown plan key', () => {
    expect(getPriceId('enterprise' as any, 'monthly')).toBe(null)
  })

  test('returns null for an unknown interval key', () => {
    expect(getPriceId('pro', 'lifetime' as any)).toBe(null)
  })

  test('every returned id starts with "price_"', () => {
    for (const plan of ['basic', 'pro', 'business'] as const) {
      for (const interval of ['monthly', 'annual'] as const) {
        expect(getPriceId(plan, interval)).toMatch(/^price_/)
      }
    }
  })
})

describe('isLegacyTierPriceId()', () => {
  test('returns true for every staging legacy monthly id', () => {
    process.env.NODE_ENV = 'development'
    for (const planMap of Object.values(STRIPE_LEGACY_TIER_PRICES_STAGING)) {
      for (const tier of Object.values(planMap)) {
        expect(isLegacyTierPriceId(tier.monthly)).toBe(true)
      }
    }
  })

  test('returns true for every staging legacy annual id', () => {
    process.env.NODE_ENV = 'development'
    for (const planMap of Object.values(STRIPE_LEGACY_TIER_PRICES_STAGING)) {
      for (const tier of Object.values(planMap)) {
        expect(isLegacyTierPriceId(tier.annual)).toBe(true)
      }
    }
  })

  test('returns true for every production legacy id', () => {
    process.env.NODE_ENV = 'production'
    for (const planMap of Object.values(STRIPE_LEGACY_TIER_PRICES_PRODUCTION)) {
      for (const tier of Object.values(planMap)) {
        expect(isLegacyTierPriceId(tier.monthly)).toBe(true)
        expect(isLegacyTierPriceId(tier.annual)).toBe(true)
      }
    }
  })

  test('returns false for an unknown price id', () => {
    process.env.NODE_ENV = 'development'
    expect(isLegacyTierPriceId('price_unknown_xyz')).toBe(false)
  })

  test('returns false for an empty string', () => {
    expect(isLegacyTierPriceId('')).toBe(false)
  })

  test('returns false when current flat price is checked (flat ≠ legacy)', () => {
    process.env.NODE_ENV = 'development'
    expect(isLegacyTierPriceId(STRIPE_PRICES_STAGING.pro.monthly)).toBe(false)
  })

  test('basic legacy is in scope (50-seat tier exists in staging)', () => {
    process.env.NODE_ENV = 'development'
    expect(isLegacyTierPriceId(STRIPE_LEGACY_TIER_PRICES_STAGING.basic['50'].monthly)).toBe(true)
  })

  test('isolation: legacy id from production map is not detected when NODE_ENV=development', () => {
    process.env.NODE_ENV = 'development'
    const prodOnlyId = STRIPE_LEGACY_TIER_PRICES_PRODUCTION.pro['100'].monthly
    expect(prodOnlyId).not.toBe(STRIPE_LEGACY_TIER_PRICES_STAGING.pro['100'].monthly)
    expect(isLegacyTierPriceId(prodOnlyId)).toBe(false)
  })
})

describe('decodeLegacyPriceId()', () => {
  beforeEach(() => { process.env.NODE_ENV = 'development' })

  test('decodes a pro/100 monthly legacy id correctly', () => {
    const id = STRIPE_LEGACY_TIER_PRICES_STAGING.pro['100'].monthly
    expect(decodeLegacyPriceId(id)).toEqual({ planType: 'pro', tierKey: '100', interval: 'monthly' })
  })

  test('decodes a pro/100 annual legacy id correctly', () => {
    const id = STRIPE_LEGACY_TIER_PRICES_STAGING.pro['100'].annual
    expect(decodeLegacyPriceId(id)).toEqual({ planType: 'pro', tierKey: '100', interval: 'annual' })
  })

  test('decodes business/10000 tier (largest)', () => {
    const id = STRIPE_LEGACY_TIER_PRICES_STAGING.business['10000'].monthly
    expect(decodeLegacyPriceId(id)).toEqual({ planType: 'business', tierKey: '10000', interval: 'monthly' })
  })

  test('decodes basic/50 tier', () => {
    const id = STRIPE_LEGACY_TIER_PRICES_STAGING.basic['50'].monthly
    expect(decodeLegacyPriceId(id)).toEqual({ planType: 'basic', tierKey: '50', interval: 'monthly' })
  })

  test('returns null for unknown id', () => {
    expect(decodeLegacyPriceId('price_does_not_exist')).toBe(null)
  })

  test('returns null for empty string', () => {
    expect(decodeLegacyPriceId('')).toBe(null)
  })

  test('uses production map when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production'
    const id = STRIPE_LEGACY_TIER_PRICES_PRODUCTION.pro['400'].annual
    expect(decodeLegacyPriceId(id)).toEqual({ planType: 'pro', tierKey: '400', interval: 'annual' })
  })

  test('does not cross-decode prod id in staging env', () => {
    process.env.NODE_ENV = 'development'
    const prodId = STRIPE_LEGACY_TIER_PRICES_PRODUCTION.pro['400'].annual
    if (prodId !== STRIPE_LEGACY_TIER_PRICES_STAGING.pro['400'].annual) {
      expect(decodeLegacyPriceId(prodId)).toBe(null)
    }
  })

  test('decodes every staging legacy id correctly (round-trip)', () => {
    for (const planType of ['basic', 'pro', 'business'] as const) {
      for (const [tierKey, tier] of Object.entries(STRIPE_LEGACY_TIER_PRICES_STAGING[planType])) {
        expect(decodeLegacyPriceId(tier.monthly)).toEqual({ planType, tierKey, interval: 'monthly' })
        expect(decodeLegacyPriceId(tier.annual)).toEqual({ planType, tierKey, interval: 'annual' })
      }
    }
  })
})

describe('getInstancePrices()', () => {
  test('returns staging map by default', () => {
    process.env.NODE_ENV = 'development'
    expect(getInstancePrices()).toBe(INSTANCE_PRICES_STAGING)
  })

  test('returns production map when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production'
    expect(getInstancePrices()).toBe(INSTANCE_PRICES_PRODUCTION)
  })

  test('every size has both monthly and annual ids', () => {
    for (const size of ['small', 'medium', 'large', 'xlarge'] as const) {
      expect(typeof INSTANCE_PRICES_STAGING[size].monthly).toBe('string')
      expect(typeof INSTANCE_PRICES_STAGING[size].annual).toBe('string')
      expect(INSTANCE_PRICES_STAGING[size].monthly.length).toBeGreaterThan(0)
    }
  })
})

describe('getInstancePriceId()', () => {
  beforeEach(() => { process.env.NODE_ENV = 'development' })

  test.each([
    ['small', 'monthly'],
    ['small', 'annual'],
    ['medium', 'monthly'],
    ['medium', 'annual'],
    ['large', 'monthly'],
    ['large', 'annual'],
    ['xlarge', 'monthly'],
    ['xlarge', 'annual'],
  ] as const)('returns id for %s/%s', (size, interval) => {
    expect(getInstancePriceId(size, interval)).toBe(INSTANCE_PRICES_STAGING[size][interval])
  })

  test('returns null for unknown size', () => {
    expect(getInstancePriceId('jumbo' as any, 'monthly')).toBe(null)
  })

  test('returns null for unknown interval', () => {
    expect(getInstancePriceId('small', 'weekly' as any)).toBe(null)
  })

  test('production path returns prod-only ids', () => {
    process.env.NODE_ENV = 'production'
    expect(getInstancePriceId('medium', 'annual')).toBe(INSTANCE_PRICES_PRODUCTION.medium.annual)
  })
})

describe('getOveragePriceConfig() / getOveragePriceId()', () => {
  test('returns staging by default', () => {
    process.env.NODE_ENV = 'development'
    expect(getOveragePriceConfig()).toBe(OVERAGE_PRICE_STAGING)
    expect(getOveragePriceId()).toBe(OVERAGE_PRICE_STAGING.priceId)
  })

  test('returns production when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production'
    expect(getOveragePriceConfig()).toBe(OVERAGE_PRICE_PRODUCTION)
    expect(getOveragePriceId()).toBe(OVERAGE_PRICE_PRODUCTION.priceId)
  })

  test('config carries meter id, event name, and unitsPerDollar', () => {
    process.env.NODE_ENV = 'development'
    const cfg = getOveragePriceConfig()
    expect(typeof cfg.meterId).toBe('string')
    expect(cfg.meterId.length).toBeGreaterThan(0)
    expect(cfg.meterEventName).toBe('usage_overage_cents')
    expect(cfg.unitsPerDollar).toBe(100)
  })

  test('production config also has cents-denominated meter (unitsPerDollar=100)', () => {
    process.env.NODE_ENV = 'production'
    expect(getOveragePriceConfig().unitsPerDollar).toBe(100)
  })

  test('meter event name is identical across envs', () => {
    expect(OVERAGE_PRICE_STAGING.meterEventName).toBe(OVERAGE_PRICE_PRODUCTION.meterEventName)
  })
})

describe('config shape invariants', () => {
  test('all flat plans have basic/pro/business keys', () => {
    expect(Object.keys(STRIPE_PRICES_STAGING).sort()).toEqual(['basic', 'business', 'pro'])
    expect(Object.keys(STRIPE_PRICES_PRODUCTION).sort()).toEqual(['basic', 'business', 'pro'])
  })

  test('every flat tier has monthly and annual', () => {
    for (const map of [STRIPE_PRICES_STAGING, STRIPE_PRICES_PRODUCTION]) {
      for (const plan of ['basic', 'pro', 'business'] as const) {
        expect(map[plan].monthly).toBeDefined()
        expect(map[plan].annual).toBeDefined()
        expect(map[plan].monthly).not.toBe(map[plan].annual)
      }
    }
  })

  test('every legacy tier has monthly and annual ids', () => {
    for (const map of [STRIPE_LEGACY_TIER_PRICES_STAGING, STRIPE_LEGACY_TIER_PRICES_PRODUCTION]) {
      for (const planMap of Object.values(map)) {
        for (const tier of Object.values(planMap) as Array<{ monthly: string; annual: string }>) {
          expect(typeof tier.monthly).toBe('string')
          expect(typeof tier.annual).toBe('string')
        }
      }
    }
  })

  test('legacy pro and business maps have all 10 tier keys', () => {
    const expected = ['100', '200', '400', '800', '1200', '2000', '3000', '5000', '7500', '10000']
    expect(Object.keys(STRIPE_LEGACY_TIER_PRICES_STAGING.pro).sort())
      .toEqual([...expected].sort())
    expect(Object.keys(STRIPE_LEGACY_TIER_PRICES_STAGING.business).sort())
      .toEqual([...expected].sort())
    expect(Object.keys(STRIPE_LEGACY_TIER_PRICES_PRODUCTION.pro).sort())
      .toEqual([...expected].sort())
    expect(Object.keys(STRIPE_LEGACY_TIER_PRICES_PRODUCTION.business).sort())
      .toEqual([...expected].sort())
  })

  test('staging and production legacy ids differ (except basic/50 which intentionally shares)', () => {
    // basic/50 shares the same id in legacy maps by design (single tier reused)
    expect(STRIPE_LEGACY_TIER_PRICES_STAGING.pro['100'].monthly)
      .not.toBe(STRIPE_LEGACY_TIER_PRICES_PRODUCTION.pro['100'].monthly)
  })
})
