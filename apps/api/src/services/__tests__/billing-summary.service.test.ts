// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-451 — billing summary + in-app plan change.
 *
 * The bug these tests exist to keep closed: "Change Plan" on a paid workspace
 * used to open a second Stripe Checkout. That created a second subscription,
 * `syncFromStripe` upserted by `workspaceId` so the new row replaced the old
 * one, and the original subscription kept billing the customer. Every plan
 * change must therefore go through `subscriptions.update` on the subscription
 * we already have — never `checkout.sessions.create`.
 */

import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime } from 'bun:test'
import { TRIAL_MAX_SEATS, TRIAL_SEAT_LIMIT_CODE } from '../../config/usage-plans'

// ============================================================================
// billing.service mock — the summary service only reads these six things
// ============================================================================

type SubRow = {
  workspaceId: string
  stripeSubscriptionId: string
  stripeCustomerId: string
  planId: string
  seats: number
  status: string
  billingInterval: string
  currentPeriodStart: Date
  currentPeriodEnd: Date
  cancelAtPeriodEnd: boolean
}

let subscription: SubRow | null = null
let effectivePlanId = 'free'
let wallet: any = null
let grants = { freeSeats: 0, monthlyIncludedUsd: 0, planId: null, rowCount: 0 }
let billingWorkspaceId = 'w1'
const syncCalls: any[] = []

mock.module('../billing.service', () => ({
  resolveBillingWorkspaceId: async (workspaceId: string) => {
    billingWorkspaceId = workspaceId
    return workspaceId
  },
  getSubscription: async () => subscription,
  getEffectivePlanId: async () => effectivePlanId,
  getUsageWallet: async () => wallet,
  getActiveGrantsForWorkspace: async () => grants,
  syncFromStripe: async (data: any) => {
    syncCalls.push(data)
    return data
  },
}))

// ============================================================================
// prisma mock — only `usageWallet.updateMany` is touched
// ============================================================================

const walletUpdates: any[] = []

mock.module('../../lib/prisma', () => ({
  prisma: {
    usageWallet: {
      updateMany: async (args: any) => {
        walletUpdates.push(args)
        return { count: 1 }
      },
    },
  },
}))

// ============================================================================
// stripe-prices + price lookup mocks
// ============================================================================

mock.module('../../config/stripe-prices', () => ({
  getOveragePriceConfig: () => ({ priceId: 'price_overage' }),
}))

let resolvedPriceId: string | null = 'price_business_monthly'
const priceLookupCalls: any[] = []

mock.module('../stripe-price-lookup.service', () => ({
  normalizeCheckoutPlanId: (requested: string) => (requested === 'pro' ? 'business' : requested),
  resolveCheckoutPriceId: async (_stripe: any, plan: string, interval: string) => {
    priceLookupCalls.push({ plan, interval })
    return resolvedPriceId
  },
}))

const summary = await import('../billing-summary.service')

// ============================================================================
// Fake Stripe
// ============================================================================

type StripeCall = { method: string; args: any[] }
let stripeCalls: StripeCall[] = []

let stripeSubscription: any
let stripePreview: any
let stripeOpenInvoices: any[]
let stripeCustomer: any
let stripePrice: any
let stripeUpdateResult: any
let stripeFailure: { method: string; error: Error } | null = null

function resetStripeFixtures() {
  stripeCalls = []
  stripeFailure = null
  stripeSubscription = {
    id: 'sub_1',
    status: 'active',
    current_period_start: 1_772_000_000,
    current_period_end: 1_774_592_000,
    cancel_at_period_end: false,
    default_payment_method: {
      card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 },
    },
    items: {
      data: [
        {
          id: 'si_seat',
          quantity: 3,
          price: {
            id: 'price_basic_monthly',
            unit_amount: 2900,
            recurring: { usage_type: 'licensed' },
          },
        },
        {
          id: 'si_overage',
          quantity: 1,
          price: {
            id: 'price_overage',
            unit_amount: 0,
            recurring: { usage_type: 'metered' },
          },
        },
      ],
    },
  }
  stripePreview = {
    amount_due: 8700,
    currency: 'usd',
    next_payment_attempt: 1_774_592_000,
    lines: { data: [] },
  }
  stripeOpenInvoices = []
  stripeCustomer = { invoice_settings: { default_payment_method: null } }
  stripePrice = { id: 'price_business_monthly', unit_amount: 9900 }
  stripeUpdateResult = {
    id: 'sub_1',
    status: 'active',
    current_period_start: 1_772_000_000,
    current_period_end: 1_774_592_000,
    cancel_at_period_end: false,
  }
}

function maybeFail(method: string) {
  if (stripeFailure?.method === method) throw stripeFailure.error
}

const fakeStripe: any = {
  subscriptions: {
    retrieve: async (id: string, params?: any) => {
      stripeCalls.push({ method: 'subscriptions.retrieve', args: [id, params] })
      maybeFail('subscriptions.retrieve')
      return stripeSubscription
    },
    update: async (id: string, params: any) => {
      stripeCalls.push({ method: 'subscriptions.update', args: [id, params] })
      maybeFail('subscriptions.update')
      return stripeUpdateResult
    },
  },
  invoices: {
    createPreview: async (params: any) => {
      stripeCalls.push({ method: 'invoices.createPreview', args: [params] })
      maybeFail('invoices.createPreview')
      return stripePreview
    },
    list: async (params: any) => {
      stripeCalls.push({ method: 'invoices.list', args: [params] })
      maybeFail('invoices.list')
      return { data: stripeOpenInvoices }
    },
  },
  customers: {
    retrieve: async (id: string) => {
      stripeCalls.push({ method: 'customers.retrieve', args: [id] })
      maybeFail('customers.retrieve')
      return stripeCustomer
    },
  },
  prices: {
    retrieve: async (id: string) => {
      stripeCalls.push({ method: 'prices.retrieve', args: [id] })
      maybeFail('prices.retrieve')
      return stripePrice
    },
  },
}

function callsTo(method: string) {
  return stripeCalls.filter((c) => c.method === method)
}

// ============================================================================
// Lifecycle
// ============================================================================

const origConsole = { log: console.log, warn: console.warn, error: console.error }

beforeEach(() => {
  subscription = {
    workspaceId: 'w1',
    stripeSubscriptionId: 'sub_1',
    stripeCustomerId: 'cus_1',
    planId: 'basic',
    seats: 3,
    status: 'active',
    billingInterval: 'monthly',
    currentPeriodStart: new Date('2026-03-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-04-01T00:00:00Z'),
    cancelAtPeriodEnd: false,
  }
  effectivePlanId = 'basic'
  wallet = null
  grants = { freeSeats: 0, monthlyIncludedUsd: 0, planId: null, rowCount: 0 }
  billingWorkspaceId = 'w1'
  syncCalls.length = 0
  walletUpdates.length = 0
  priceLookupCalls.length = 0
  resolvedPriceId = 'price_business_monthly'
  resetStripeFixtures()
  summary.__resetBillingSummaryCacheForTesting()
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
})

afterEach(() => {
  console.log = origConsole.log
  console.warn = origConsole.warn
  console.error = origConsole.error
  setSystemTime()
})

// ============================================================================
// getBillingSummary
// ============================================================================

describe('getBillingSummary', () => {
  it('reads plan, seats and period from our own row and enriches from Stripe', async () => {
    const result = await summary.getBillingSummary({ workspaceId: 'w1', stripe: fakeStripe })

    expect(result.planId).toBe('basic')
    expect(result.planSource).toBe('subscription')
    expect(result.status).toBe('active')
    expect(result.seats).toBe(3)
    expect(result.billingInterval).toBe('monthly')
    expect(result.currentPeriodEnd).toBe('2026-04-01T00:00:00.000Z')
    expect(result.cancelAtPeriodEnd).toBe(false)
    expect(result.trialEndsAt).toBeNull()
    expect(result.nextInvoice).toEqual({
      amountUsd: 87,
      currency: 'USD',
      date: new Date(1_774_592_000 * 1000).toISOString(),
    })
    expect(result.paymentMethod).toEqual({
      brand: 'visa',
      last4: '4242',
      expMonth: 4,
      expYear: 2030,
    })
    expect(result.pastDue).toBeNull()
  })

  it('returns a free workspace with nulls instead of a 404', async () => {
    subscription = null
    effectivePlanId = 'free'

    const result = await summary.getBillingSummary({ workspaceId: 'w1', stripe: fakeStripe })

    expect(result).toMatchObject({
      planId: 'free',
      planSource: 'free',
      status: null,
      seats: 1,
      billingInterval: null,
      currentPeriodEnd: null,
      nextInvoice: null,
      paymentMethod: null,
      pastDue: null,
    })
    // Nothing to enrich, so Stripe is never called.
    expect(stripeCalls).toHaveLength(0)
  })

  it('reports a grant-only workspace as planSource "grant"', async () => {
    subscription = null
    effectivePlanId = 'business'

    const result = await summary.getBillingSummary({ workspaceId: 'w1', stripe: fakeStripe })

    expect(result.planId).toBe('business')
    expect(result.planSource).toBe('grant')
    expect(result.status).toBe('active')
    expect(result.nextInvoice).toBeNull()
  })

  it('still answers without Stripe (local/desktop install)', async () => {
    const result = await summary.getBillingSummary({ workspaceId: 'w1', stripe: null })

    expect(result.planId).toBe('basic')
    expect(result.seats).toBe(3)
    expect(result.nextInvoice).toBeNull()
    expect(result.paymentMethod).toBeNull()
  })

  it('marks a trialing subscription and exposes the trial end', async () => {
    subscription!.status = 'trialing'

    const result = await summary.getBillingSummary({ workspaceId: 'w1', stripe: fakeStripe })

    expect(result.status).toBe('trialing')
    expect(result.trialEndsAt).toBe('2026-04-01T00:00:00.000Z')
  })

  it('surfaces an open invoice when the subscription is past due', async () => {
    subscription!.status = 'past_due'
    stripeOpenInvoices = [
      { amount_due: 8700, hosted_invoice_url: 'https://invoice.stripe.com/i/1' },
    ]

    const result = await summary.getBillingSummary({ workspaceId: 'w1', stripe: fakeStripe })

    expect(result.pastDue).toEqual({
      reason: 'subscription_past_due',
      amountUsd: 87,
      invoiceUrl: 'https://invoice.stripe.com/i/1',
    })
    expect(callsTo('invoices.list')[0].args[0]).toMatchObject({
      customer: 'cus_1',
      subscription: 'sub_1',
      status: 'open',
    })
  })

  it('surfaces an unpaid overage invoice even with no subscription', async () => {
    subscription = null
    effectivePlanId = 'free'
    wallet = {
      overageOutstandingInvoiceId: 'in_overage',
      overageOutstandingUsd: 12.5,
      overageOutstandingInvoiceUrl: 'https://invoice.stripe.com/i/2',
    }

    const result = await summary.getBillingSummary({ workspaceId: 'w1', stripe: fakeStripe })

    expect(result.pastDue).toEqual({
      reason: 'overage_unpaid',
      amountUsd: 12.5,
      invoiceUrl: 'https://invoice.stripe.com/i/2',
    })
  })

  it('falls back to the customer default card when the subscription has none', async () => {
    stripeSubscription.default_payment_method = null
    stripeCustomer = {
      invoice_settings: {
        default_payment_method: {
          card: { brand: 'mastercard', last4: '4444', exp_month: 12, exp_year: 2031 },
        },
      },
    }

    const result = await summary.getBillingSummary({ workspaceId: 'w1', stripe: fakeStripe })

    expect(result.paymentMethod).toEqual({
      brand: 'mastercard',
      last4: '4444',
      expMonth: 12,
      expYear: 2031,
    })
  })

  it('caches per workspace for a minute and drops the cache on invalidation', async () => {
    await summary.getBillingSummary({ workspaceId: 'w1', stripe: fakeStripe })
    const afterFirst = stripeCalls.length

    await summary.getBillingSummary({ workspaceId: 'w1', stripe: fakeStripe })
    expect(stripeCalls.length).toBe(afterFirst)

    summary.invalidateBillingSummaryCache('w1')
    await summary.getBillingSummary({ workspaceId: 'w1', stripe: fakeStripe })
    expect(stripeCalls.length).toBeGreaterThan(afterFirst)
  })

  it('turns a Stripe outage into a 502 BillingError, not an empty 200', async () => {
    stripeFailure = { method: 'invoices.createPreview', error: new Error('stripe is down') }

    const error = await summary
      .getBillingSummary({ workspaceId: 'w1', stripe: fakeStripe })
      .catch((e: any) => e)

    expect(error).toBeInstanceOf(summary.BillingError)
    expect(error.code).toBe('stripe_error')
    expect(error.status).toBe(502)
    expect(error.message).toBe('stripe is down')
  })
})

// ============================================================================
// previewPlanChange
// ============================================================================

describe('previewPlanChange', () => {
  it('prices the change against the existing subscription item', async () => {
    stripePreview = {
      amount_due: 21000,
      currency: 'usd',
      lines: {
        data: [
          { proration: true, amount: 21000 },
          { proration: false, amount: 0 },
        ],
      },
    }

    const preview = await summary.previewPlanChange({
      workspaceId: 'w1',
      stripe: fakeStripe,
      planId: 'business',
      billingInterval: 'monthly',
      seats: 3,
    })

    expect(preview.planId).toBe('business')
    expect(preview.seats).toBe(3)
    // 3 seats × $29 today, 3 seats × $99 after.
    expect(preview.currentPriceUsd).toBe(87)
    expect(preview.newPriceUsd).toBe(297)
    expect(preview.prorationUsd).toBe(210)
    expect(preview.nextInvoiceUsd).toBe(297)
    expect(preview.prorationDate).toBeGreaterThan(0)

    const previewCall = callsTo('invoices.createPreview')[0].args[0]
    expect(previewCall.subscription_details.items).toEqual([
      { id: 'si_seat', price: 'price_business_monthly', quantity: 3 },
    ])
    expect(previewCall.subscription_details.proration_date).toBe(preview.prorationDate)
    // The metered overage item is never the one that gets repriced.
    expect(previewCall.subscription_details.items[0].id).not.toBe('si_overage')
  })

  it('pins the proration date so apply charges what was shown', async () => {
    setSystemTime(new Date('2026-03-15T12:00:00Z'))

    const preview = await summary.previewPlanChange({
      workspaceId: 'w1',
      stripe: fakeStripe,
      planId: 'business',
      seats: 2,
    })

    expect(preview.prorationDate).toBe(Math.floor(Date.parse('2026-03-15T12:00:00Z') / 1000))
    expect(preview.effectiveAt).toBe('2026-03-15T12:00:00.000Z')
  })

  it('forces Basic to a single seat', async () => {
    const preview = await summary.previewPlanChange({
      workspaceId: 'w1',
      stripe: fakeStripe,
      planId: 'basic',
      seats: 9,
    })

    expect(preview.seats).toBe(1)
    expect(callsTo('invoices.createPreview')[0].args[0].subscription_details.items[0].quantity).toBe(1)
  })

  it('remaps the retired Pro plan to Business', async () => {
    const preview = await summary.previewPlanChange({
      workspaceId: 'w1',
      stripe: fakeStripe,
      planId: 'pro',
      seats: 2,
    })

    expect(preview.planId).toBe('business')
    expect(priceLookupCalls[0]).toEqual({ plan: 'business', interval: 'monthly' })
  })

  it('rejects an unknown plan with a 400', async () => {
    const error = await summary
      .previewPlanChange({ workspaceId: 'w1', stripe: fakeStripe, planId: 'enterprise' })
      .catch((e: any) => e)

    expect(error).toBeInstanceOf(summary.BillingError)
    expect(error.code).toBe('invalid_plan')
    expect(error.status).toBe(400)
  })

  it('refuses a trial seat count above the cap', async () => {
    subscription!.status = 'trialing'

    const error = await summary
      .previewPlanChange({
        workspaceId: 'w1',
        stripe: fakeStripe,
        planId: 'business',
        seats: TRIAL_MAX_SEATS + 1,
      })
      .catch((e: any) => e)

    expect(error.code).toBe(TRIAL_SEAT_LIMIT_CODE)
    expect(error.status).toBe(400)
  })

  it('refuses when the workspace has no subscription to change', async () => {
    subscription = null

    const error = await summary
      .previewPlanChange({ workspaceId: 'w1', stripe: fakeStripe, planId: 'business' })
      .catch((e: any) => e)

    expect(error.code).toBe('no_subscription')
    expect(error.status).toBe(409)
  })

  it('refuses when the subscription is canceled', async () => {
    subscription!.status = 'canceled'

    const error = await summary
      .previewPlanChange({ workspaceId: 'w1', stripe: fakeStripe, planId: 'business' })
      .catch((e: any) => e)

    expect(error.code).toBe('subscription_inactive')
    expect(error.status).toBe(409)
  })

  it('refuses when the target price is not provisioned in Stripe', async () => {
    resolvedPriceId = null

    const error = await summary
      .previewPlanChange({ workspaceId: 'w1', stripe: fakeStripe, planId: 'business' })
      .catch((e: any) => e)

    expect(error.code).toBe('price_not_provisioned')
    expect(error.status).toBe(503)
  })

  it('refuses when the subscription has no per-seat item', async () => {
    stripeSubscription.items.data = [stripeSubscription.items.data[1]]

    const error = await summary
      .previewPlanChange({ workspaceId: 'w1', stripe: fakeStripe, planId: 'business' })
      .catch((e: any) => e)

    expect(error.code).toBe('no_seat_item')
    expect(error.status).toBe(409)
  })
})

// ============================================================================
// applyPlanChange
// ============================================================================

describe('applyPlanChange', () => {
  it('updates the existing subscription instead of creating a second one', async () => {
    const result = await summary.applyPlanChange({
      workspaceId: 'w1',
      stripe: fakeStripe,
      planId: 'business',
      billingInterval: 'annual',
      seats: 4,
      prorationDate: 1_773_000_000,
    })

    expect(result).toMatchObject({
      ok: true,
      planId: 'business',
      billingInterval: 'annual',
      seats: 4,
      status: 'active',
    })

    const updates = callsTo('subscriptions.update')
    expect(updates).toHaveLength(1)
    expect(updates[0].args[0]).toBe('sub_1')
    expect(updates[0].args[1]).toEqual({
      items: [{ id: 'si_seat', price: 'price_business_monthly', quantity: 4 }],
      proration_behavior: 'always_invoice',
      proration_date: 1_773_000_000,
    })
    // The regression: no second subscription is ever created.
    expect(callsTo('checkout.sessions.create')).toHaveLength(0)
  })

  it('mirrors the change into our Subscription row', async () => {
    await summary.applyPlanChange({
      workspaceId: 'w1',
      stripe: fakeStripe,
      planId: 'business',
      billingInterval: 'annual',
      seats: 4,
    })

    expect(syncCalls).toHaveLength(1)
    expect(syncCalls[0]).toMatchObject({
      stripeSubscriptionId: 'sub_1',
      stripeCustomerId: 'cus_1',
      workspaceId: 'w1',
      planId: 'business',
      seats: 4,
      stripePriceId: 'price_business_monthly',
      billingInterval: 'annual',
    })
  })

  it('reallocates the included allowance in place, without resetting the period', async () => {
    grants = { freeSeats: 1, monthlyIncludedUsd: 5, planId: null, rowCount: 1 }

    await summary.applyPlanChange({
      workspaceId: 'w1',
      stripe: fakeStripe,
      planId: 'business',
      seats: 2,
    })

    expect(walletUpdates).toHaveLength(1)
    expect(walletUpdates[0].where).toEqual({ workspaceId: 'w1' })
    const data = walletUpdates[0].data
    expect(data.monthlyIncludedUsd).toBe(data.monthlyIncludedAllocationUsd)
    expect(data.monthlyIncludedUsd).toBeGreaterThan(0)
  })

  it('drops the cached summary so the page shows the new plan immediately', async () => {
    await summary.getBillingSummary({ workspaceId: 'w1', stripe: fakeStripe })
    const before = stripeCalls.length

    await summary.applyPlanChange({
      workspaceId: 'w1',
      stripe: fakeStripe,
      planId: 'business',
      seats: 2,
    })
    await summary.getBillingSummary({ workspaceId: 'w1', stripe: fakeStripe })

    expect(stripeCalls.length).toBeGreaterThan(before)
  })

  it('defaults the proration date to now when the client sends none', async () => {
    setSystemTime(new Date('2026-03-15T12:00:00Z'))

    await summary.applyPlanChange({
      workspaceId: 'w1',
      stripe: fakeStripe,
      planId: 'business',
      seats: 2,
    })

    expect(callsTo('subscriptions.update')[0].args[1].proration_date).toBe(
      Math.floor(Date.parse('2026-03-15T12:00:00Z') / 1000),
    )
  })
})

// ============================================================================
// setCancelAtPeriodEnd
// ============================================================================

describe('setCancelAtPeriodEnd', () => {
  it('schedules a cancellation and keeps access to the period end', async () => {
    stripeUpdateResult.cancel_at_period_end = true

    const result = await summary.setCancelAtPeriodEnd({
      workspaceId: 'w1',
      stripe: fakeStripe,
      cancel: true,
    })

    expect(result).toEqual({
      ok: true,
      cancelAtPeriodEnd: true,
      accessEndsAt: new Date(1_774_592_000 * 1000).toISOString(),
    })
    expect(callsTo('subscriptions.update')[0].args[1]).toEqual({ cancel_at_period_end: true })
    expect(syncCalls[0]).toMatchObject({ cancelAtPeriodEnd: true, planId: 'basic', seats: 3 })
  })

  it('resumes a scheduled cancellation', async () => {
    subscription!.cancelAtPeriodEnd = true

    const result = await summary.setCancelAtPeriodEnd({
      workspaceId: 'w1',
      stripe: fakeStripe,
      cancel: false,
    })

    expect(result.cancelAtPeriodEnd).toBe(false)
    expect(callsTo('subscriptions.update')[0].args[1]).toEqual({ cancel_at_period_end: false })
    expect(syncCalls[0]).toMatchObject({ cancelAtPeriodEnd: false })
  })

  it('refuses when there is no subscription', async () => {
    subscription = null

    const error = await summary
      .setCancelAtPeriodEnd({ workspaceId: 'w1', stripe: fakeStripe, cancel: true })
      .catch((e: any) => e)

    expect(error.code).toBe('no_subscription')
    expect(error.status).toBe(409)
  })

  it('refuses on an inactive subscription', async () => {
    subscription!.status = 'canceled'

    const error = await summary
      .setCancelAtPeriodEnd({ workspaceId: 'w1', stripe: fakeStripe, cancel: true })
      .catch((e: any) => e)

    expect(error.code).toBe('subscription_inactive')
    expect(error.status).toBe(409)
  })
})
