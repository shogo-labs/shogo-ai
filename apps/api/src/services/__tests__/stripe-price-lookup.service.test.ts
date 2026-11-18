// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-397 — a new checkout can never be created for the retired Pro plan.
 *
 * The checkout routes normalize the requested plan before resolving a price,
 * so an old web/desktop/Android build that still posts `planId: 'pro'` lands
 * on the Business price. These tests pin that contract: the normalized plan is
 * `business`, and the price resolution that follows never asks Stripe for a
 * Pro price.
 *
 *   bun test apps/api/src/services/__tests__/stripe-price-lookup.service.test.ts
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetPriceLookupCacheForTesting,
  normalizeCheckoutPlanId,
  priceLookupKeyFor,
  resolveCheckoutPriceId,
  resolveInstanceCheckoutPriceId,
  type StripePriceLookupClient,
} from '../stripe-price-lookup.service'
import { INSTANCE_PRICES_STAGING, type PlanType } from '../../config/stripe-prices'

/** A Stripe client that answers every lookup key with a deterministic id. */
function fakeStripe(): StripePriceLookupClient & { lookups: string[] } {
  const lookups: string[] = []
  return {
    lookups,
    prices: {
      async list({ lookup_keys }) {
        lookups.push(...lookup_keys)
        return { data: lookup_keys.map((key) => ({ id: `price_for_${key}` })) }
      },
    },
  }
}

beforeEach(() => {
  __resetPriceLookupCacheForTesting()
  // Force the lookup-key path so the fake Stripe client is the source of the
  // price id, regardless of what the test environment has configured.
  delete process.env.STRIPE_PRICE_BUSINESS_MONTHLY_V2
  delete process.env.STRIPE_PRICE_BUSINESS_ANNUAL_V2
})

describe('normalizeCheckoutPlanId', () => {
  test('remaps the retired Pro plan to Business', () => {
    expect(normalizeCheckoutPlanId('pro')).toBe('business')
  })

  test('leaves the plans we still sell untouched', () => {
    expect(normalizeCheckoutPlanId('basic')).toBe('basic')
    expect(normalizeCheckoutPlanId('business')).toBe('business')
  })
})

describe('a pro checkout resolves the Business price', () => {
  test('the lookup key is the Business one, never the Pro one', () => {
    const plan = normalizeCheckoutPlanId('pro') as PlanType
    expect(priceLookupKeyFor(plan, 'monthly')).toBe('business_seat_monthly_v2')
    expect(priceLookupKeyFor(plan, 'annual')).toBe('business_seat_annual_v2')
    expect(priceLookupKeyFor(plan, 'monthly')).not.toBe(priceLookupKeyFor('pro', 'monthly'))
  })

  test('resolveCheckoutPriceId is never called with pro for a pro request', async () => {
    const stripe = fakeStripe()
    const plan = normalizeCheckoutPlanId('pro') as PlanType

    const priceId = await resolveCheckoutPriceId(stripe, plan, 'monthly')

    expect(priceId).toBe('price_for_business_seat_monthly_v2')
    expect(stripe.lookups).not.toContain('shogo_pro_monthly_v2')
    expect(stripe.lookups).toContain('business_seat_monthly_v2')
  })
})

describe('instance-size checkout prices', () => {
  test('a configured size resolves to its static id without a Stripe call', async () => {
    const stripe = fakeStripe()
    const priceId = await resolveInstanceCheckoutPriceId(stripe, 'large', 'monthly')
    expect(priceId).toMatch(/^price_/)
    expect(stripe.lookups).toEqual([])
  })

  test('a Stripe failure resolves to null instead of throwing a 500', async () => {
    const stripe: StripePriceLookupClient = {
      prices: {
        async list() {
          throw new Error('stripe down')
        },
      },
    }
    const saved = INSTANCE_PRICES_STAGING.large.monthly
    INSTANCE_PRICES_STAGING.large.monthly = ''
    try {
      expect(await resolveInstanceCheckoutPriceId(stripe, 'large', 'monthly')).toBeNull()
    } finally {
      INSTANCE_PRICES_STAGING.large.monthly = saved
    }
  })
})
