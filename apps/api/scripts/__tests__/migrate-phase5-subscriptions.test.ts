// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-339 — `migrate-phase5-subscriptions.ts`.
 *
 * Every assertion here is a row of the card's acceptance criteria:
 *   - dry-run makes zero writes
 *   - a trial is swapped now with no proration
 *   - a paid sub gets exactly one schedule whose phase 2 starts at the first
 *     period end ≥ 7 days after the notice
 *   - Pro → Business when flagged
 *   - a second run is a no-op
 *   - a sub with no DB row is reported, not touched
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  applyPhase5Row,
  nextEligiblePeriodEnd,
  planPhase5Row,
  type Phase5Candidate,
  type Phase5Stripe,
} from '../migrate-phase5-subscriptions'
import { LEGACY_PLAN_PRICES, STRIPE_PRICES_STAGING, OVERAGE_PRICE_STAGING } from '../../src/config/stripe-prices'

const originalNodeEnv = process.env.NODE_ENV

beforeEach(() => {
  process.env.NODE_ENV = 'test'
})

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})

const NOW = new Date('2026-11-05T00:00:00.000Z')
const NOTICE = new Date('2026-11-05T00:00:00.000Z')

const LEGACY_BUSINESS_MONTHLY = LEGACY_PLAN_PRICES.staging.business.monthly
const NEW_BUSINESS_MONTHLY = 'price_business_16_monthly'
const NEW_BUSINESS_ANNUAL = 'price_business_156_annual'
const NEW_BASIC_ANNUAL = 'price_basic_78_annual'

const PRICES = {
  basic: { monthly: LEGACY_PLAN_PRICES.staging.basic.monthly, annual: NEW_BASIC_ANNUAL },
  pro: { monthly: LEGACY_PLAN_PRICES.staging.pro.monthly, annual: LEGACY_PLAN_PRICES.staging.pro.annual },
  business: { monthly: NEW_BUSINESS_MONTHLY, annual: NEW_BUSINESS_ANNUAL },
}

const OPTS = {
  prices: PRICES,
  proToBusiness: true,
  minNoticeDays: 7,
  noticeSentAt: NOTICE,
  now: NOW,
}

function candidate(overrides: {
  status?: string
  priceId?: string
  quantity?: number
  currentPeriodEnd?: string
  metadata?: Record<string, string>
  dbPlanId?: string | null
  dbBillingInterval?: string | null
  workspaceId?: string | null
  existingScheduleId?: string | null
  extraItems?: Array<{ id: string; quantity: number; price: { id: string } }>
  /** Stripe 2025-03-31.basil+ shape: the period end lives on the item only. */
  periodEndOnItemOnly?: boolean
}): Phase5Candidate {
  const periodEnd = Math.floor(
    new Date(overrides.currentPeriodEnd ?? '2026-11-20T00:00:00.000Z').getTime() / 1000,
  )
  return {
    workspaceId: overrides.workspaceId === undefined ? 'ws-1' : overrides.workspaceId,
    dbPlanId: overrides.dbPlanId === undefined ? 'business' : overrides.dbPlanId,
    dbBillingInterval: overrides.dbBillingInterval ?? 'monthly',
    existingScheduleId: overrides.existingScheduleId ?? null,
    stripeSub: {
      id: 'sub_1',
      status: overrides.status ?? 'active',
      metadata: overrides.metadata ?? { workspaceId: 'ws-1', planId: 'business' },
      ...(overrides.periodEndOnItemOnly ? {} : { current_period_end: periodEnd }),
      items: {
        data: [
          {
            id: 'si_plan',
            quantity: overrides.quantity ?? 3,
            price: { id: overrides.priceId ?? LEGACY_BUSINESS_MONTHLY },
            ...(overrides.periodEndOnItemOnly ? { current_period_end: periodEnd } : {}),
          },
          ...(overrides.extraItems ?? []),
        ],
      },
    },
  }
}

function fakeStripe(options: {
  phaseDiscounts?: unknown[]
  phaseTaxRates?: unknown[]
  collectionMethod?: string
} = {}) {
  const calls: Array<{ method: string; id?: string; params?: any }> = []
  const phase: Record<string, unknown> = {
    start_date: 1_800_000_000,
    items: [{ id: 'si_plan', price: { id: LEGACY_BUSINESS_MONTHLY } }],
  }
  if (options.phaseDiscounts !== undefined) phase.discounts = options.phaseDiscounts
  if (options.phaseTaxRates !== undefined) phase.default_tax_rates = options.phaseTaxRates
  if (options.collectionMethod !== undefined) phase.collection_method = options.collectionMethod
  const stripe: Phase5Stripe = {
    subscriptions: {
      update: async (id, params) => {
        calls.push({ method: 'subscriptions.update', id, params })
        return {}
      },
    },
    subscriptionSchedules: {
      create: async (params) => {
        calls.push({ method: 'subscriptionSchedules.create', params })
        return { id: 'sub_sched_1', current_phase: { start_date: 1_800_000_000 }, phases: [phase] }
      },
      update: async (id, params) => {
        calls.push({ method: 'subscriptionSchedules.update', id, params })
        return {}
      },
    },
  }
  return { stripe, calls }
}

describe('nextEligiblePeriodEnd', () => {
  it('uses the first period end at least minNoticeDays after the notice', () => {
    const periodEnd = new Date('2026-11-20T00:00:00.000Z')
    expect(nextEligiblePeriodEnd(periodEnd, 'monthly', NOTICE, 7).toISOString()).toBe('2026-11-20T00:00:00.000Z')
  })

  it('skips a renewal that is inside the notice window', () => {
    // Noticed 2026-11-05, renewal 2026-11-08 (3 days) → moves to 2026-12-08.
    const periodEnd = new Date('2026-11-08T00:00:00.000Z')
    expect(nextEligiblePeriodEnd(periodEnd, 'monthly', NOTICE, 7).toISOString()).toBe('2026-12-08T00:00:00.000Z')
  })

  it('adds a year at a time for annual subscriptions', () => {
    // Renewal 1 day after the notice → the following annual cycle.
    const periodEnd = new Date('2026-11-06T00:00:00.000Z')
    expect(nextEligiblePeriodEnd(periodEnd, 'annual', NOTICE, 7).toISOString()).toBe('2027-11-06T00:00:00.000Z')
  })
})

describe('planPhase5Row', () => {
  it('swaps a trial now', () => {
    const row = planPhase5Row(candidate({ status: 'trialing' }), OPTS)
    expect(row.action).toBe('swap-now')
    expect(row.toPriceId).toBe(NEW_BUSINESS_MONTHLY)
    expect(row.seats).toBe(3)
  })

  it('schedules a paid legacy sub at its next eligible renewal', () => {
    const row = planPhase5Row(candidate({ currentPeriodEnd: '2026-11-08T00:00:00.000Z' }), OPTS)
    expect(row.action).toBe('schedule')
    expect(row.fromPriceId).toBe(LEGACY_BUSINESS_MONTHLY)
    expect(row.toPriceId).toBe(NEW_BUSINESS_MONTHLY)
    expect(row.switchDate?.toISOString()).toBe('2026-12-08T00:00:00.000Z')
  })

  it('schedules from the item period end when Stripe puts it on the item only', () => {
    // 2025-03-31.basil and later (the version this script pins) drop the
    // top-level `current_period_end`; reading only the top level planned zero
    // schedules against the live account.
    const row = planPhase5Row(
      candidate({ currentPeriodEnd: '2026-11-08T00:00:00.000Z', periodEndOnItemOnly: true }),
      OPTS,
    )
    expect(row.action).toBe('schedule')
    expect(row.switchDate?.toISOString()).toBe('2026-12-08T00:00:00.000Z')
  })

  it('moves Pro to Business at the annual price when flagged', () => {
    const row = planPhase5Row(
      candidate({
        dbPlanId: 'pro',
        dbBillingInterval: 'annual',
        priceId: LEGACY_PLAN_PRICES.staging.pro.annual,
        currentPeriodEnd: '2027-07-01T00:00:00.000Z',
        metadata: { workspaceId: 'ws-1', planId: 'pro' },
      }),
      OPTS,
    )
    expect(row.planId).toBe('business')
    expect(row.toPriceId).toBe(NEW_BUSINESS_ANNUAL)
  })

  it('leaves Pro alone when --no-pro-to-business', () => {
    const row = planPhase5Row(
      candidate({ dbPlanId: 'pro', priceId: LEGACY_PLAN_PRICES.staging.pro.monthly, metadata: {} }),
      { ...OPTS, proToBusiness: false },
    )
    expect(row.planId).toBe('pro')
    // Same price, but no metadata yet → the backfill still runs.
    expect(row.action).toBe('metadata-only')
  })

  it('only backfills metadata for Basic monthly (same price, same allowance)', () => {
    const row = planPhase5Row(
      candidate({
        dbPlanId: 'basic',
        priceId: LEGACY_PLAN_PRICES.staging.basic.monthly,
        metadata: {},
      }),
      OPTS,
    )
    expect(row.action).toBe('metadata-only')
  })

  it('moves Basic annual from $80 to $78 at renewal', () => {
    const row = planPhase5Row(
      candidate({
        dbPlanId: 'basic',
        dbBillingInterval: 'annual',
        priceId: LEGACY_PLAN_PRICES.staging.basic.annual,
        metadata: {},
      }),
      OPTS,
    )
    expect(row.action).toBe('schedule')
    expect(row.toPriceId).toBe(NEW_BASIC_ANNUAL)
  })

  it('skips a sub that already moved to the new price (second run is a no-op)', () => {
    const row = planPhase5Row(candidate({ priceId: NEW_BUSINESS_MONTHLY }), OPTS)
    expect(row.action).toBe('skip-already-on-target')
  })

  it('skips a sub that already has a schedule', () => {
    const row = planPhase5Row(candidate({ existingScheduleId: 'sub_sched_9' }), OPTS)
    expect(row.action).toBe('skip-has-schedule')
  })

  it('skips a sub already marked migrated', () => {
    const row = planPhase5Row(
      candidate({ metadata: { workspaceId: 'ws-1', planId: 'business', phase5MigratedAt: '2026-11-01T00:00:00Z' } }),
      OPTS,
    )
    expect(row.action).toBe('skip-already-migrated')
  })

  it('reports a Stripe sub with no DB row instead of touching it', () => {
    const row = planPhase5Row(candidate({ workspaceId: null }), OPTS)
    expect(row.action).toBe('skip-no-db-row')
    expect(row.reason).toContain('no DB Subscription row')
  })

  it('reads seats from the licensed item, never the overage item', () => {
    const row = planPhase5Row(
      candidate({
        quantity: 4,
        extraItems: [{ id: 'si_overage', quantity: 0, price: { id: OVERAGE_PRICE_STAGING.priceId } }],
      }),
      OPTS,
    )
    expect(row.seats).toBe(4)
  })
})

describe('applyPhase5Row', () => {
  it('makes zero writes for a skip', async () => {
    const { stripe, calls } = fakeStripe()
    await applyPhase5Row(stripe, candidate({ workspaceId: null }), planPhase5Row(candidate({ workspaceId: null }), OPTS), {
      now: NOW,
    })
    expect(calls).toHaveLength(0)
  })

  it('swaps a trial price with proration_behavior none and keeps the quantity', async () => {
    const { stripe, calls } = fakeStripe()
    const c = candidate({ status: 'trialing', quantity: 2 })
    await applyPhase5Row(stripe, c, planPhase5Row(c, OPTS), { now: NOW, noticeSentAt: NOTICE })

    expect(calls).toHaveLength(1)
    const params = calls[0].params
    expect(calls[0].method).toBe('subscriptions.update')
    expect(params.items).toEqual([{ id: 'si_plan', price: NEW_BUSINESS_MONTHLY, quantity: 2 }])
    expect(params.proration_behavior).toBe('none')
    expect(params.metadata.phase5MigratedAt).toBe(NOW.toISOString())
    expect(params.metadata.priceChangeNoticeAt).toBe(NOTICE.toISOString())
  })

  it('creates exactly one schedule whose phase 2 starts on the switch date', async () => {
    const { stripe, calls } = fakeStripe()
    const c = candidate({ currentPeriodEnd: '2026-11-08T00:00:00.000Z' })
    const row = planPhase5Row(c, OPTS)
    await applyPhase5Row(stripe, c, row, { now: NOW, noticeSentAt: NOTICE })

    const create = calls.filter((call) => call.method === 'subscriptionSchedules.create')
    expect(create).toHaveLength(1)
    expect(create[0].params).toEqual({ from_subscription: 'sub_1' })

    const updates = calls.filter((call) => call.method === 'subscriptionSchedules.update')
    expect(updates).toHaveLength(1)
    const phases = updates[0].params.phases
    expect(phases).toHaveLength(2)
    expect(phases[0].items[0]).toEqual({ price: LEGACY_BUSINESS_MONTHLY, quantity: 3 })
    expect(new Date(phases[0].end_date * 1000).toISOString()).toBe('2026-12-08T00:00:00.000Z')
    expect(phases[1].items[0]).toEqual({ price: NEW_BUSINESS_MONTHLY, quantity: 3 })
    expect(phases[1].proration_behavior).toBe('none')
    expect(phases[1].metadata.planId).toBe('business')
  })

  it('keeps every non-plan item, the coupon and the tax rates in both phases', async () => {
    // `phases[].items` replaces the subscription's items: listing only the plan
    // item would delete the metered overage item as soon as the schedule is
    // applied, and omitting `discounts` would drop a customer's coupon.
    const { stripe, calls } = fakeStripe({
      phaseDiscounts: [{ id: 'di_1', coupon: { id: 'coupon_50_off' } }],
      phaseTaxRates: [{ id: 'txr_gst' }],
      collectionMethod: 'send_invoice',
    })
    const c = candidate({
      currentPeriodEnd: '2026-11-08T00:00:00.000Z',
      extraItems: [
        { id: 'si_overage', quantity: 0, price: { id: OVERAGE_PRICE_STAGING.priceId } },
        { id: 'si_addon', quantity: 2, price: { id: 'price_addon_seat' } },
      ],
    })
    await applyPhase5Row(stripe, c, planPhase5Row(c, OPTS), { now: NOW, noticeSentAt: NOTICE })

    const update = calls.find((call) => call.method === 'subscriptionSchedules.update')!
    const phases = update.params.phases
    expect(phases).toHaveLength(2)

    for (const phase of phases) {
      expect(phase.items).toHaveLength(3)
      // Metered: carried with no quantity — Stripe rejects one on a usage item.
      expect(phase.items.find((item: any) => item.price === OVERAGE_PRICE_STAGING.priceId)).toEqual({
        price: OVERAGE_PRICE_STAGING.priceId,
      })
      // Licensed add-on: carried with its own quantity.
      expect(phase.items.find((item: any) => item.price === 'price_addon_seat')).toEqual({
        price: 'price_addon_seat',
        quantity: 2,
      })
      expect(phase.discounts).toEqual([{ coupon: 'coupon_50_off' }])
      expect(phase.default_tax_rates).toEqual(['txr_gst'])
      expect(phase.collection_method).toBe('send_invoice')
    }

    // Only the plan item's price differs between the phases.
    expect(phases[0].items[0]).toEqual({ price: LEGACY_BUSINESS_MONTHLY, quantity: 3 })
    expect(phases[1].items[0]).toEqual({ price: NEW_BUSINESS_MONTHLY, quantity: 3 })
  })

  it('invents no discount or tax rate when the subscription has neither', async () => {
    const { stripe, calls } = fakeStripe()
    const c = candidate({ currentPeriodEnd: '2026-11-08T00:00:00.000Z' })
    await applyPhase5Row(stripe, c, planPhase5Row(c, OPTS), { now: NOW, noticeSentAt: NOTICE })

    const phases = calls.find((call) => call.method === 'subscriptionSchedules.update')!.params.phases
    for (const phase of phases) {
      expect(phase.discounts).toBeUndefined()
      expect(phase.default_tax_rates).toBeUndefined()
      expect(phase.collection_method).toBeUndefined()
    }
  })

  it('writes metadata only for a Basic monthly sub', async () => {
    const { stripe, calls } = fakeStripe()
    const c = candidate({ dbPlanId: 'basic', priceId: LEGACY_PLAN_PRICES.staging.basic.monthly, metadata: {} })
    await applyPhase5Row(stripe, c, planPhase5Row(c, OPTS), { now: NOW })

    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('subscriptions.update')
    expect(calls[0].params.items).toBeUndefined()
    expect(calls[0].params.metadata.workspaceId).toBe('ws-1')
    expect(calls[0].params.metadata.planId).toBe('basic')
    // No metadata at all before, so the backfill is stamped and a re-run is a
    // no-op rather than the same write again.
    expect(calls[0].params.metadata.phase5MigratedAt).toBe(NOW.toISOString())
  })

  it('is a no-op on the second run', async () => {
    const first = candidate({ priceId: LEGACY_BUSINESS_MONTHLY })
    const row = planPhase5Row(first, OPTS)
    const swapped = candidate({
      priceId: NEW_BUSINESS_MONTHLY,
      metadata: { workspaceId: 'ws-1', planId: 'business', phase5MigratedAt: NOW.toISOString() },
    })
    const second = planPhase5Row(swapped, OPTS)
    expect(row.action).toBe('schedule')
    expect(second.action).toBe('skip-already-migrated')

    const { stripe, calls } = fakeStripe()
    await applyPhase5Row(stripe, swapped, second, { now: NOW })
    expect(calls).toHaveLength(0)
  })
})

describe('STRIPE_PRICES_STAGING', () => {
  it('is the v2.5.0 ladder once the env ids are deployed', () => {
    // The ids themselves come from `create-phase5-prices.ts` + env; here we
    // only pin that Basic monthly is untouched and Pro still resolves.
    expect(STRIPE_PRICES_STAGING.basic.monthly).toMatch(/^price_/)
    expect(STRIPE_PRICES_STAGING.pro.monthly).toMatch(/^price_/)
  })
})
