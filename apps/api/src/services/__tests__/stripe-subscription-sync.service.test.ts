// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-339 — the webhook must not depend on Stripe metadata.
 *
 * A `customer.subscription.updated` with no metadata whatsoever, whose price
 * flipped legacy $40 → $16, has to resolve the workspace through the DB row and
 * the plan through the price, so the DB plan, seats, `stripePriceId` and
 * included USD all follow the renewal.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { LEGACY_PLAN_PRICES, OVERAGE_PRICE_STAGING } from '../../config/stripe-prices'
import {
  planItemSeats,
  resolveSubscriptionContext,
  selectPlanItem,
  type StripeSubscriptionLike,
} from '../stripe-subscription-sync.service'
import { getMonthlyIncludedForPlanAndPrice, getPlanAllowance } from '../../config/usage-plans'

const originalNodeEnv = process.env.NODE_ENV

beforeEach(() => {
  process.env.NODE_ENV = 'test'
})

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})

const legacyBusinessMonthly = LEGACY_PLAN_PRICES.staging.business.monthly
const NEW_BUSINESS_MONTHLY = 'price_new_business_monthly_v2'

function subscription(overrides: Partial<StripeSubscriptionLike> & Record<string, unknown> = {}) {
  return {
    id: 'sub_123',
    status: 'active',
    metadata: {},
    items: {
      data: [{ id: 'si_plan', quantity: 3, price: { id: legacyBusinessMonthly } }],
    },
    ...overrides,
  } as StripeSubscriptionLike
}

describe('selectPlanItem', () => {
  it('never returns the metered overage item as the plan item', () => {
    const sub = subscription({
      items: {
        data: [
          { id: 'si_overage', quantity: 1, price: { id: OVERAGE_PRICE_STAGING.priceId } },
          { id: 'si_plan', quantity: 2, price: { id: legacyBusinessMonthly } },
        ],
      },
    })
    const item = selectPlanItem(sub as any)
    expect(item?.id).toBe('si_plan')
    expect(planItemSeats(sub as any)).toBe(2)
  })

  it('returns null when every item is the overage item', () => {
    const sub = subscription({
      items: { data: [{ id: 'si_overage', quantity: 1, price: { id: OVERAGE_PRICE_STAGING.priceId } }] },
    })
    expect(selectPlanItem(sub as any)).toBeNull()
  })
})

describe('resolveSubscriptionContext — the price is the source of truth', () => {
  it('resolves the workspace from the DB row when metadata is missing', async () => {
    const resolved = await resolveSubscriptionContext(subscription({ metadata: {} }) as any, async (id) =>
      id === 'sub_123' ? { workspaceId: 'ws-1', planId: 'business' } : null,
    )
    expect(resolved).toEqual({
      workspaceId: 'ws-1',
      planId: 'business',
      priceId: legacyBusinessMonthly,
      seats: 3,
    })
  })

  it('prefers the price over a stale metadata planId', async () => {
    const resolved = await resolveSubscriptionContext(
      subscription({ metadata: { workspaceId: 'ws-1', planId: 'pro' } }) as any,
      async () => null,
    )
    expect(resolved?.planId).toBe('business')
  })

  it('follows a scheduled flip legacy → new price to the same workspace', async () => {
    const before = await resolveSubscriptionContext(subscription({ metadata: {} }) as any, async () => ({
      workspaceId: 'ws-1',
      planId: 'business',
    }))
    const after = await resolveSubscriptionContext(
      subscription({
        metadata: {},
        items: { data: [{ id: 'si_plan', quantity: 3, price: { id: NEW_BUSINESS_MONTHLY } }] },
      }) as any,
      async () => ({ workspaceId: 'ws-1', planId: 'business' }),
    )

    expect(before?.priceId).toBe(legacyBusinessMonthly)
    expect(after?.priceId).toBe(NEW_BUSINESS_MONTHLY)
    expect(after?.workspaceId).toBe('ws-1')

    // …and the allowance that comes with each price.
    expect(getPlanAllowance(after!.planId, after!.priceId).windowLimits?.weeklyUsd).toBe(4.6)
    expect(getPlanAllowance(before!.planId, before!.priceId).windowLimits?.weeklyUsd).toBe(9.9)
  })

  it('computes the included USD the webhook writes, per price', () => {
    expect(getMonthlyIncludedForPlanAndPrice('business', 3, legacyBusinessMonthly)).toBe(120)
    expect(getMonthlyIncludedForPlanAndPrice('business', 3, NEW_BUSINESS_MONTHLY)).toBe(60)
  })

  it('falls back to metadata when the price is not one of ours', async () => {
    const resolved = await resolveSubscriptionContext(
      subscription({
        metadata: { workspaceId: 'ws-9', planId: 'business' },
        items: { data: [{ id: 'si_plan', quantity: 2, price: { id: 'price_instance_addon' } }] },
      }) as any,
      async () => null,
    )
    expect(resolved?.workspaceId).toBe('ws-9')
    expect(resolved?.planId).toBe('business')
    expect(resolved?.priceId).toBe('price_instance_addon')
  })

  it('ignores an instance/capacity subscription', async () => {
    const resolved = await resolveSubscriptionContext(
      subscription({ metadata: { workspaceId: 'ws-1', planId: 'instance' }, items: { data: [] } }) as any,
      async () => null,
    )
    expect(resolved).toBeNull()
  })

  it('returns null when neither metadata nor a DB row names a workspace', async () => {
    const resolved = await resolveSubscriptionContext(subscription({ metadata: {} }) as any, async () => null)
    expect(resolved).toBeNull()
  })
})
