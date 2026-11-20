// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-446 — the Solo Founder checkout session params.
 *
 * SHO-428 built these inline in `server.ts`, so nothing tested them. They now
 * come from `buildSoloFounderCheckoutParams`, and every promise AC1 makes is
 * asserted here: the two lines, the one discount, cards + 3DS, the metadata on
 * both the session and the subscription, the renewal disclosure, and no trial.
 *
 *   bun test apps/api/src/__tests__/solo-founder-checkout.test.ts
 */

import { describe, test, expect, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// The builder is pure; the module it lives in is not. Stub Prisma so importing
// the service never opens a connection.
mock.module('../lib/prisma', () => withPrismaExports({ prisma: {} as any }))

const { buildSoloFounderCheckoutParams, renewalDisclosure, SOLO_FOUNDER_OFFER } =
  await import('../services/solo-founder.service')

const NOW = new Date('2026-11-19T00:00:00Z')

function params(overrides: Record<string, unknown> = {}) {
  return buildSoloFounderCheckoutParams({
    priceId: 'price_business_annual',
    coursePriceId: 'price_course',
    discount: { coupon: 'solo-founder-first-year' },
    successUrl: 'https://app.shogo.ai/?checkout=success',
    cancelUrl: 'https://app.shogo.ai/?checkout=canceled',
    metadata: {
      workspaceId: 'ws-1',
      planId: 'business',
      billingInterval: 'annual',
      seats: '1',
      offer: SOLO_FOUNDER_OFFER,
    },
    userEmail: 'buyer@example.com',
    now: NOW,
    ...overrides,
  } as any)
}

describe('AC1 checkout session params', () => {
  test('Business annual qty 1 plus the one-time course, with no adjustable quantity', () => {
    const p = params()
    expect(p.mode).toBe('subscription')
    expect(p.line_items).toEqual([
      { price: 'price_business_annual', quantity: 1 },
      { price: 'price_course', quantity: 1 },
    ])
    for (const line of p.line_items ?? []) {
      expect(line).not.toHaveProperty('adjustable_quantity')
    }
  })

  test('the default coupon is the only discount, and promotion codes are never allowed', () => {
    const p = params()
    expect(p.discounts).toEqual([{ coupon: 'solo-founder-first-year' }])
    expect(p).not.toHaveProperty('allow_promotion_codes')
  })

  test('a resolved promotion code replaces the coupon, still as the only discount', () => {
    const p = params({ discount: { promotion_code: 'promo_123' } })
    expect(p.discounts).toEqual([{ promotion_code: 'promo_123' }])
    expect(p).not.toHaveProperty('allow_promotion_codes')
  })

  test('cards only, with 3DS requested on every payment', () => {
    const p = params()
    expect(p.payment_method_types).toEqual(['card'])
    expect(p.payment_method_options).toEqual({ card: { request_three_d_secure: 'any' } })
  })

  test('the offer metadata lands on the session and on the subscription', () => {
    const p = params()
    const expected = {
      workspaceId: 'ws-1',
      planId: 'business',
      billingInterval: 'annual',
      seats: '1',
      offer: 'solo_founder',
    }
    expect(p.metadata).toEqual(expected)
    expect(p.subscription_data?.metadata).toEqual(expected)
  })

  test('the renewal disclosure is the submit text', () => {
    const p = params()
    expect(p.custom_text?.submit?.message).toBe(renewalDisclosure(NOW))
    expect(p.custom_text?.submit?.message).toContain('Renews at $156/yr')
  })

  test('no trial, even when the client sends wantsTrial, planId and seats', () => {
    const p = params({ wantsTrial: true, planId: 'pro', seats: 9, trialPeriodDays: 14 })
    expect(p).not.toHaveProperty('trial_period_days')
    expect(p).not.toHaveProperty('trial_settings')
    expect(p.subscription_data).not.toHaveProperty('trial_period_days')
    expect(p.subscription_data).not.toHaveProperty('trial_settings')
    expect(p.subscription_data?.metadata?.seats).toBe('1')
    expect(p.subscription_data?.metadata?.planId).toBe('business')
  })

  test('optional customer fields are omitted when the route has none', () => {
    const p = params({ userEmail: null, referralId: null, customerCreation: null })
    expect(p).not.toHaveProperty('customer_email')
    expect(p).not.toHaveProperty('client_reference_id')
    expect(p).not.toHaveProperty('customer_creation')
  })

  test('affiliate attribution is carried through when present', () => {
    const p = params({ referralId: 'aff_42', customerCreation: 'always' })
    expect(p.client_reference_id).toBe('aff_42')
    expect(p.customer_creation).toBe('always')
  })
})
