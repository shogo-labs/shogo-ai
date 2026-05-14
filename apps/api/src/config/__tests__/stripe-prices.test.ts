// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  INSTANCE_PRICES_PRODUCTION,
  INSTANCE_PRICES_STAGING,
  OVERAGE_PRICE_PRODUCTION,
  OVERAGE_PRICE_STAGING,
  STRIPE_LEGACY_TIER_PRICES_PRODUCTION,
  STRIPE_LEGACY_TIER_PRICES_STAGING,
  STRIPE_PRICES_PRODUCTION,
  STRIPE_PRICES_STAGING,
  decodeLegacyPriceId,
  getInstancePriceId,
  getInstancePrices,
  getOveragePriceConfig,
  getOveragePriceId,
  getPriceId,
  getStripePrices,
  isLegacyTierPriceId,
} from '../stripe-prices'

const originalNodeEnv = process.env.NODE_ENV

beforeEach(() => {
  process.env.NODE_ENV = 'test'
})

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})

describe('STRIPE_PRICES_* constants', () => {
  it('staging has all three plans × two intervals filled in', () => {
    for (const plan of ['basic', 'pro', 'business'] as const) {
      expect(STRIPE_PRICES_STAGING[plan].monthly).toMatch(/^price_/)
      expect(STRIPE_PRICES_STAGING[plan].annual).toMatch(/^price_/)
    }
  })

  it('production has all three plans × two intervals filled in', () => {
    for (const plan of ['basic', 'pro', 'business'] as const) {
      expect(STRIPE_PRICES_PRODUCTION[plan].monthly).toMatch(/^price_/)
      expect(STRIPE_PRICES_PRODUCTION[plan].annual).toMatch(/^price_/)
    }
  })

  it('staging and production price IDs do not collide for the same plan/interval', () => {
    for (const plan of ['pro', 'business'] as const) {
      for (const interval of ['monthly', 'annual'] as const) {
        expect(STRIPE_PRICES_STAGING[plan][interval]).not.toBe(
          STRIPE_PRICES_PRODUCTION[plan][interval],
        )
      }
    }
  })
})

describe('getStripePrices / getPriceId', () => {
  it('returns staging by default (NODE_ENV != production)', () => {
    process.env.NODE_ENV = 'test'
    expect(getStripePrices()).toBe(STRIPE_PRICES_STAGING)
  })

  it('returns production when NODE_ENV === "production"', () => {
    process.env.NODE_ENV = 'production'
    expect(getStripePrices()).toBe(STRIPE_PRICES_PRODUCTION)
  })

  it('returns staging when NODE_ENV is unset', () => {
    delete process.env.NODE_ENV
    expect(getStripePrices()).toBe(STRIPE_PRICES_STAGING)
  })

  it('does not treat "Production" (mixed case) as production', () => {
    process.env.NODE_ENV = 'Production'
    expect(getStripePrices()).toBe(STRIPE_PRICES_STAGING)
  })

  it('getPriceId returns the matching staging id', () => {
    expect(getPriceId('basic', 'monthly')).toBe(STRIPE_PRICES_STAGING.basic.monthly)
    expect(getPriceId('pro', 'annual')).toBe(STRIPE_PRICES_STAGING.pro.annual)
    expect(getPriceId('business', 'monthly')).toBe(STRIPE_PRICES_STAGING.business.monthly)
  })

  it('getPriceId follows NODE_ENV to production', () => {
    process.env.NODE_ENV = 'production'
    expect(getPriceId('pro', 'monthly')).toBe(STRIPE_PRICES_PRODUCTION.pro.monthly)
  })

  it('getPriceId returns null for an unknown plan', () => {
    expect(getPriceId('platinum' as any, 'monthly')).toBeNull()
  })
})

describe('isLegacyTierPriceId', () => {
  it('returns true for a known staging legacy pro monthly id', () => {
    const id = STRIPE_LEGACY_TIER_PRICES_STAGING.pro['200'].monthly
    expect(isLegacyTierPriceId(id)).toBe(true)
  })

  it('returns true for a known staging legacy basic annual id', () => {
    const id = STRIPE_LEGACY_TIER_PRICES_STAGING.basic['50'].annual
    expect(isLegacyTierPriceId(id)).toBe(true)
  })

  it('returns true for a known staging legacy business id', () => {
    const id = STRIPE_LEGACY_TIER_PRICES_STAGING.business['1200'].annual
    expect(isLegacyTierPriceId(id)).toBe(true)
  })

  it('returns true for production legacy ids when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production'
    const id = STRIPE_LEGACY_TIER_PRICES_PRODUCTION.pro['200'].monthly
    expect(isLegacyTierPriceId(id)).toBe(true)
  })

  it('returns false when staging legacy ids are checked under production env', () => {
    process.env.NODE_ENV = 'production'
    const stagingId = STRIPE_LEGACY_TIER_PRICES_STAGING.pro['200'].monthly
    expect(isLegacyTierPriceId(stagingId)).toBe(false)
  })

  it('returns false for current flat-price ids (not legacy)', () => {
    expect(isLegacyTierPriceId(STRIPE_PRICES_STAGING.business.monthly)).toBe(false)
  })

  it('returns false for unknown ids', () => {
    expect(isLegacyTierPriceId('price_garbage')).toBe(false)
    expect(isLegacyTierPriceId('')).toBe(false)
  })
})

describe('decodeLegacyPriceId', () => {
  it('decodes a staging legacy pro monthly id', () => {
    const id = STRIPE_LEGACY_TIER_PRICES_STAGING.pro['200'].monthly
    expect(decodeLegacyPriceId(id)).toEqual({
      planType: 'pro',
      tierKey: '200',
      interval: 'monthly',
    })
  })

  it('decodes a staging legacy basic annual id', () => {
    const id = STRIPE_LEGACY_TIER_PRICES_STAGING.basic['50'].annual
    expect(decodeLegacyPriceId(id)).toEqual({
      planType: 'basic',
      tierKey: '50',
      interval: 'annual',
    })
  })

  it('decodes a staging legacy business monthly id', () => {
    const id = STRIPE_LEGACY_TIER_PRICES_STAGING.business['10000'].monthly
    expect(decodeLegacyPriceId(id)).toEqual({
      planType: 'business',
      tierKey: '10000',
      interval: 'monthly',
    })
  })

  it('decodes production legacy ids when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production'
    const id = STRIPE_LEGACY_TIER_PRICES_PRODUCTION.pro['400'].annual
    expect(decodeLegacyPriceId(id)).toEqual({
      planType: 'pro',
      tierKey: '400',
      interval: 'annual',
    })
  })

  it('returns null for unknown ids', () => {
    expect(decodeLegacyPriceId('price_nope')).toBeNull()
    expect(decodeLegacyPriceId('')).toBeNull()
  })

  it('returns null for current flat-price ids', () => {
    expect(decodeLegacyPriceId(STRIPE_PRICES_STAGING.pro.monthly)).toBeNull()
  })
})

describe('Instance prices', () => {
  it('getInstancePrices returns staging by default', () => {
    expect(getInstancePrices()).toBe(INSTANCE_PRICES_STAGING)
  })

  it('getInstancePrices returns production when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production'
    expect(getInstancePrices()).toBe(INSTANCE_PRICES_PRODUCTION)
  })

  it('getInstancePriceId returns the matching id for every size + interval', () => {
    for (const size of ['small', 'medium', 'large', 'xlarge'] as const) {
      for (const interval of ['monthly', 'annual'] as const) {
        expect(getInstancePriceId(size, interval)).toBe(INSTANCE_PRICES_STAGING[size][interval])
      }
    }
  })

  it('getInstancePriceId returns null for unknown size', () => {
    expect(getInstancePriceId('giant' as any, 'monthly')).toBeNull()
  })

  it('staging and production instance prices use the same shape (4 sizes × 2 intervals)', () => {
    for (const cfg of [INSTANCE_PRICES_STAGING, INSTANCE_PRICES_PRODUCTION]) {
      expect(Object.keys(cfg).sort()).toEqual(['large', 'medium', 'small', 'xlarge'])
      for (const size of ['small', 'medium', 'large', 'xlarge'] as const) {
        expect(cfg[size].monthly).toBeTruthy()
        expect(cfg[size].annual).toBeTruthy()
      }
    }
  })
})

describe('Overage prices', () => {
  it('getOveragePriceConfig returns staging by default', () => {
    expect(getOveragePriceConfig()).toBe(OVERAGE_PRICE_STAGING)
  })

  it('getOveragePriceConfig returns production when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production'
    expect(getOveragePriceConfig()).toBe(OVERAGE_PRICE_PRODUCTION)
  })

  it('getOveragePriceId returns the staging priceId', () => {
    expect(getOveragePriceId()).toBe(OVERAGE_PRICE_STAGING.priceId)
  })

  it('getOveragePriceId returns the production priceId under NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production'
    expect(getOveragePriceId()).toBe(OVERAGE_PRICE_PRODUCTION.priceId)
  })

  it('unitsPerDollar is 100 in both environments (cents)', () => {
    expect(OVERAGE_PRICE_STAGING.unitsPerDollar).toBe(100)
    expect(OVERAGE_PRICE_PRODUCTION.unitsPerDollar).toBe(100)
  })

  it('meterEventName is consistent across envs', () => {
    expect(OVERAGE_PRICE_STAGING.meterEventName).toBe('usage_overage_cents')
    expect(OVERAGE_PRICE_PRODUCTION.meterEventName).toBe('usage_overage_cents')
  })

  it('meterId differs between staging and production', () => {
    expect(OVERAGE_PRICE_STAGING.meterId).not.toBe(OVERAGE_PRICE_PRODUCTION.meterId)
  })
})
