// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-451 QA — the billing page's routes, end to end through the real server.
 *
 * The service unit tests prove the decisions; this suite proves the wiring the
 * card exists to add: that `GET /api/billing/summary` and the in-app plan
 * change are mounted, gated, and answer the shapes the mobile page reads. It
 * boots the real cloud `server.ts` on a real SQLite database and calls
 * `server.fetch(...)`, so a route that was never registered (or sits behind the
 * wrong guard) fails here rather than as a 404 in the app.
 *
 * The bug this closes: "Change Plan" on a paid workspace used to POST
 * `/api/billing/checkout`, which created a *second* Stripe subscription while
 * the first kept billing. Checkout must now refuse with 409
 * `already_subscribed` and point at the change-plan route.
 *
 * Covered:
 *  - AC1 an unauthenticated call is 401, a non-member is 403, a plain member
 *    is 403 on the money-spending routes but can read the summary;
 *  - AC2 the summary answers plan/seats/period/next-invoice/card for a paying
 *    workspace, and nulls (not a 404) for a free one;
 *  - AC3 checkout refuses a workspace that already subscribes, with the plan
 *    it is on, and never reaches Stripe;
 *  - AC4 preview then apply changes the *existing* subscription — one
 *    `subscriptions.update`, no `checkout.sessions.create`;
 *  - AC5 cancel and resume flip `cancel_at_period_end` and keep the period end.
 *
 * Run: bun test apps/api/src/__tests__/qa-sho451-billing-page.acceptance.test.ts
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.SHOGO_DATA_DIR = dir
process.env.WORKSPACES_DIR = `${dir}/workspaces`

// Build the SQLite Prisma client while the local flag is on, then clear it so
// `server.ts` takes the cloud branches (Stripe, billing).
const { prisma } = await import('../lib/prisma')
delete process.env.SHOGO_LOCAL_MODE

process.env.STRIPE_SECRET_KEY = 'sk_test_sho451'
process.env.BETTER_AUTH_SECRET = 'sho451-acceptance-secret-0123456789abcdef'
process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3999'
process.env.APP_URL = 'http://127.0.0.1:3999'

// ============================================================================
// Stripe stub — records every call so "no second subscription" is provable
// ============================================================================

type StripeCall = { method: string; args: any[] }
const stripeCalls: StripeCall[] = []

const stripeState: {
  subscription: any
  preview: any
  openInvoices: any[]
  customer: any
  price: any
  updateResult: any
} = {
  subscription: null,
  preview: null,
  openInvoices: [],
  customer: { invoice_settings: { default_payment_method: null } },
  price: { id: 'price_business_monthly', unit_amount: 1600 },
  updateResult: null,
}

function resetStripeState() {
  stripeCalls.length = 0
  stripeState.subscription = {
    id: 'sub_live',
    object: 'subscription',
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
          quantity: 2,
          price: { id: 'price_basic_monthly', unit_amount: 800, recurring: { usage_type: 'licensed' } },
        },
        {
          id: 'si_overage',
          quantity: 1,
          price: { id: 'price_overage', unit_amount: 0, recurring: { usage_type: 'metered' } },
        },
      ],
    },
  }
  stripeState.preview = {
    amount_due: 3200,
    currency: 'usd',
    next_payment_attempt: 1_774_592_000,
    lines: { data: [{ proration: true, amount: 1600 }] },
  }
  stripeState.openInvoices = []
  stripeState.customer = { invoice_settings: { default_payment_method: null } }
  stripeState.price = { id: 'price_business_monthly', unit_amount: 1600 }
  stripeState.updateResult = {
    id: 'sub_live',
    object: 'subscription',
    status: 'active',
    current_period_start: 1_772_000_000,
    current_period_end: 1_774_592_000,
    cancel_at_period_end: false,
  }
}

class StripeStub {
  constructor(public key: string) {}
  subscriptions = {
    retrieve: async (id: string, params?: any) => {
      stripeCalls.push({ method: 'subscriptions.retrieve', args: [id, params] })
      // Echo the id back: each fixture workspace has its own subscription.
      return { ...stripeState.subscription, id }
    },
    update: async (id: string, params: any) => {
      stripeCalls.push({ method: 'subscriptions.update', args: [id, params] })
      return { ...stripeState.updateResult, id, ...params }
    },
  }
  invoices = {
    createPreview: async (params: any) => {
      stripeCalls.push({ method: 'invoices.createPreview', args: [params] })
      return stripeState.preview
    },
    list: async (params: any) => {
      stripeCalls.push({ method: 'invoices.list', args: [params] })
      return { data: stripeState.openInvoices }
    },
  }
  customers = {
    retrieve: async (id: string) => {
      stripeCalls.push({ method: 'customers.retrieve', args: [id] })
      return stripeState.customer
    },
  }
  prices = {
    retrieve: async (id: string) => {
      stripeCalls.push({ method: 'prices.retrieve', args: [id] })
      return stripeState.price
    },
    list: async (params: any) => {
      stripeCalls.push({ method: 'prices.list', args: [params] })
      return { data: [{ id: 'price_business_monthly' }] }
    },
  }
  checkout = {
    sessions: {
      create: async (params: any) => {
        stripeCalls.push({ method: 'checkout.sessions.create', args: [params] })
        return { id: 'cs_second', url: 'https://checkout.stripe.com/c/pay/cs_second' }
      },
    },
  }
}

mock.module('stripe', () => ({ default: StripeStub }))

// Only Better Auth's session lookup is stubbed: the `x-test-user` header names
// the signed-in user, so `authMiddleware` resolves a real *session* principal
// and every membership check below runs against the real database. Tunnel auth
// would skip those checks by design (the cloud proxy already made them), which
// is exactly the gate this suite needs to exercise.
mock.module('../auth', () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user')
        if (!id) return null
        return { user: { id, email: `${id}@example.com`, name: id }, session: { id: `s-${id}` } }
      },
    },
    handler: () => new Response('not found', { status: 404 }),
  },
  parseCookieHeader: (header: string, name: string) => {
    if (!header) return null
    for (const part of header.split(';')) {
      const eq = part.indexOf('=')
      if (eq < 0) continue
      if (part.slice(0, eq).trim() !== name) continue
      return decodeURIComponent(part.slice(eq + 1).trim())
    }
    return null
  },
}))

const server = (await import('../server')).default as any
const db = prisma as any

// ============================================================================
// Fixtures
// ============================================================================

const BASE = 'http://127.0.0.1:3999'

/** A workspace with an owner, a plain member, and an outsider. */
async function makeWorkspace(over: { withSubscription?: boolean } = {}) {
  const suffix = crypto.randomUUID().slice(0, 8)
  const owner = await db.user.create({
    data: { name: `owner-${suffix}`, email: `owner-${suffix}@example.com` },
  })
  const member = await db.user.create({
    data: { name: `member-${suffix}`, email: `member-${suffix}@example.com` },
  })
  const outsider = await db.user.create({
    data: { name: `outsider-${suffix}`, email: `outsider-${suffix}@example.com` },
  })
  const workspace = await db.workspace.create({
    data: { name: `Billing ${suffix}`, slug: `billing-${suffix}`, kind: 'team' },
  })
  await db.member.create({
    data: { userId: owner.id, workspaceId: workspace.id, role: 'owner', projectId: null },
  })
  await db.member.create({
    data: { userId: member.id, workspaceId: workspace.id, role: 'member', projectId: null },
  })

  const stripeSubscriptionId = `sub_${suffix}`
  const stripeCustomerId = `cus_${suffix}`

  if (over.withSubscription !== false) {
    await db.subscription.create({
      data: {
        workspaceId: workspace.id,
        stripeSubscriptionId,
        stripeCustomerId,
        planId: 'basic',
        seats: 2,
        status: 'active',
        billingInterval: 'monthly',
        currentPeriodStart: new Date('2026-03-01T00:00:00Z'),
        currentPeriodEnd: new Date('2026-04-01T00:00:00Z'),
        cancelAtPeriodEnd: false,
      },
    })
  }

  return { owner, member, outsider, workspace, stripeSubscriptionId, stripeCustomerId }
}

/** A request carrying a signed-in session for `userId`. */
function asUser(userId: string, path: string, init: RequestInit = {}) {
  return new Request(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-test-user': userId,
      ...(init.headers ?? {}),
    },
  })
}

function post(userId: string, path: string, body: unknown) {
  return asUser(userId, path, { method: 'POST', body: JSON.stringify(body) })
}

const callsTo = (method: string) => stripeCalls.filter((c) => c.method === method)

beforeEach(() => {
  resetStripeState()
})

afterAll(async () => {
  await db.$disconnect?.()
})

// ============================================================================
// AC1 — the routes are mounted and gated
// ============================================================================

describe('SHO-451 the billing routes are mounted and gated', () => {
  test('an unauthenticated summary call is 401, not a 404', async () => {
    const { workspace } = await makeWorkspace()

    const res = await server.fetch(
      new Request(`${BASE}/api/billing/summary?workspaceId=${workspace.id}`),
    )

    // 404 would mean the route was never registered — the failure this guards.
    expect(res.status).toBe(401)
  })

  test('a non-member cannot read the summary', async () => {
    const { outsider, workspace } = await makeWorkspace()

    const res = await server.fetch(
      asUser(outsider.id, `/api/billing/summary?workspaceId=${workspace.id}`),
    )

    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('forbidden')
  })

  test('a plain member can read the summary but cannot change the plan', async () => {
    const { member, workspace } = await makeWorkspace()

    const read = await server.fetch(
      asUser(member.id, `/api/billing/summary?workspaceId=${workspace.id}`),
    )
    expect(read.status).toBe(200)

    const write = await server.fetch(
      post(member.id, '/api/billing/change-plan', {
        workspaceId: workspace.id,
        planId: 'business',
        billingInterval: 'monthly',
        seats: 2,
      }),
    )
    expect(write.status).toBe(403)
    expect((await write.json()).error.code).toBe('forbidden')
    // A refused change never touches Stripe.
    expect(callsTo('subscriptions.update')).toHaveLength(0)
  })

  test('a missing workspaceId is a 400, not a crash', async () => {
    const { owner } = await makeWorkspace()

    const res = await server.fetch(asUser(owner.id, '/api/billing/summary'))

    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_request')
  })
})

// ============================================================================
// AC2 — the summary answers what the page renders
// ============================================================================

describe('SHO-451 the summary answers the page', () => {
  test('a paying workspace gets plan, seats, period, next invoice and card', async () => {
    const { owner, workspace } = await makeWorkspace()

    const res = await server.fetch(
      asUser(owner.id, `/api/billing/summary?workspaceId=${workspace.id}`),
    )
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.planId).toBe('basic')
    expect(body.planSource).toBe('subscription')
    expect(body.status).toBe('active')
    expect(body.seats).toBe(2)
    expect(body.billingInterval).toBe('monthly')
    expect(body.currentPeriodEnd).toBe('2026-04-01T00:00:00.000Z')
    expect(body.cancelAtPeriodEnd).toBe(false)
    expect(body.nextInvoice).toEqual({
      amountUsd: 32,
      currency: 'USD',
      date: new Date(1_774_592_000 * 1000).toISOString(),
    })
    expect(body.paymentMethod).toEqual({
      brand: 'visa',
      last4: '4242',
      expMonth: 4,
      expYear: 2030,
    })
    expect(body.pastDue).toBeNull()
  })

  test('a free workspace gets nulls, not a 404', async () => {
    const { owner, workspace } = await makeWorkspace({ withSubscription: false })

    const res = await server.fetch(
      asUser(owner.id, `/api/billing/summary?workspaceId=${workspace.id}`),
    )
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.planId).toBe('free')
    expect(body.planSource).toBe('free')
    expect(body.status).toBeNull()
    expect(body.seats).toBe(1)
    expect(body.nextInvoice).toBeNull()
    expect(body.paymentMethod).toBeNull()
    expect(body.pastDue).toBeNull()
  })

  test('a past-due subscription reports the open invoice', async () => {
    const { owner, workspace } = await makeWorkspace()
    await db.subscription.updateMany({
      where: { workspaceId: workspace.id },
      data: { status: 'past_due' },
    })
    stripeState.openInvoices = [
      { amount_due: 3200, hosted_invoice_url: 'https://invoice.stripe.com/i/451' },
    ]

    const res = await server.fetch(
      asUser(owner.id, `/api/billing/summary?workspaceId=${workspace.id}`),
    )
    const body = await res.json()

    expect(body.status).toBe('past_due')
    expect(body.pastDue).toEqual({
      reason: 'subscription_past_due',
      amountUsd: 32,
      invoiceUrl: 'https://invoice.stripe.com/i/451',
    })
  })
})

// ============================================================================
// AC3 — checkout refuses a workspace that already subscribes
// ============================================================================

describe('SHO-451 checkout never creates a second subscription', () => {
  test('a paying workspace is sent to Change plan instead of a second Checkout', async () => {
    const { owner, workspace } = await makeWorkspace()

    const res = await server.fetch(
      post(owner.id, '/api/billing/checkout', {
        workspaceId: workspace.id,
        planId: 'business',
        billingInterval: 'monthly',
        seats: 2,
      }),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('already_subscribed')
    expect(body.error.planId).toBe('basic')
    expect(body.error.message).toContain('Change plan')
    // The whole point: no second Checkout session was ever created.
    expect(callsTo('checkout.sessions.create')).toHaveLength(0)
  })

  test('a free workspace still gets a Checkout session', async () => {
    const { owner, workspace } = await makeWorkspace({ withSubscription: false })

    const res = await server.fetch(
      post(owner.id, '/api/billing/checkout', {
        workspaceId: workspace.id,
        planId: 'business',
        billingInterval: 'monthly',
        seats: 2,
      }),
    )

    expect(res.status).toBe(200)
    expect(callsTo('checkout.sessions.create')).toHaveLength(1)
  })
})

// ============================================================================
// AC4 — preview then apply changes the existing subscription
// ============================================================================

describe('SHO-451 a plan change updates the subscription in place', () => {
  test('preview prices the change against the existing per-seat item', async () => {
    const { owner, workspace } = await makeWorkspace()

    const res = await server.fetch(
      post(owner.id, '/api/billing/change-plan/preview', {
        workspaceId: workspace.id,
        planId: 'business',
        billingInterval: 'monthly',
        seats: 2,
      }),
    )
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.planId).toBe('business')
    expect(body.seats).toBe(2)
    // 2 seats × $8 today, 2 seats × $16 after.
    expect(body.currentPriceUsd).toBe(16)
    expect(body.newPriceUsd).toBe(32)
    expect(body.prorationUsd).toBe(16)
    expect(body.prorationDate).toBeGreaterThan(0)

    const previewCall = callsTo('invoices.createPreview')[0].args[0]
    expect(previewCall.subscription_details.items).toEqual([
      { id: 'si_seat', price: 'price_business_monthly', quantity: 2 },
    ])
    // A preview charges nothing.
    expect(callsTo('subscriptions.update')).toHaveLength(0)
  })

  test('apply updates the one subscription and mirrors it into our row', async () => {
    const { owner, workspace, stripeSubscriptionId } = await makeWorkspace()

    const previewRes = await server.fetch(
      post(owner.id, '/api/billing/change-plan/preview', {
        workspaceId: workspace.id,
        planId: 'business',
        billingInterval: 'monthly',
        seats: 2,
      }),
    )
    const preview = await previewRes.json()

    const res = await server.fetch(
      post(owner.id, '/api/billing/change-plan', {
        workspaceId: workspace.id,
        planId: 'business',
        billingInterval: 'monthly',
        seats: 2,
        prorationDate: preview.prorationDate,
      }),
    )
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.planId).toBe('business')
    expect(body.seats).toBe(2)

    const updates = callsTo('subscriptions.update')
    expect(updates).toHaveLength(1)
    expect(updates[0].args[0]).toBe(stripeSubscriptionId)
    expect(updates[0].args[1]).toMatchObject({
      items: [{ id: 'si_seat', price: 'price_business_monthly', quantity: 2 }],
      proration_behavior: 'always_invoice',
      proration_date: preview.prorationDate,
    })
    // The regression: no second subscription, ever.
    expect(callsTo('checkout.sessions.create')).toHaveLength(0)

    const row = await db.subscription.findFirst({ where: { workspaceId: workspace.id } })
    expect(row.planId).toBe('business')
    expect(row.seats).toBe(2)
  })

  test('a workspace with no subscription is refused with 409, not a Checkout', async () => {
    const { owner, workspace } = await makeWorkspace({ withSubscription: false })

    const res = await server.fetch(
      post(owner.id, '/api/billing/change-plan', {
        workspaceId: workspace.id,
        planId: 'business',
        billingInterval: 'monthly',
        seats: 1,
      }),
    )

    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('no_subscription')
    expect(callsTo('checkout.sessions.create')).toHaveLength(0)
  })

  test('an unknown plan is a 400 with the plan named', async () => {
    const { owner, workspace } = await makeWorkspace()

    const res = await server.fetch(
      post(owner.id, '/api/billing/change-plan/preview', {
        workspaceId: workspace.id,
        planId: 'enterprise',
        billingInterval: 'monthly',
      }),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('invalid_plan')
    expect(body.error.message).toContain('enterprise')
  })
})

// ============================================================================
// AC5 — self-serve cancel and resume
// ============================================================================

describe('SHO-451 cancel and resume', () => {
  test('cancel schedules the end of the period and keeps access until then', async () => {
    const { owner, workspace } = await makeWorkspace()

    const res = await server.fetch(
      post(owner.id, '/api/billing/cancel', { workspaceId: workspace.id }),
    )
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.cancelAtPeriodEnd).toBe(true)
    expect(body.accessEndsAt).toBe(new Date(1_774_592_000 * 1000).toISOString())

    expect(callsTo('subscriptions.update')[0].args[1]).toEqual({ cancel_at_period_end: true })
    const row = await db.subscription.findFirst({ where: { workspaceId: workspace.id } })
    expect(row.cancelAtPeriodEnd).toBe(true)
    // Nothing is deleted: the plan and seats are untouched.
    expect(row.planId).toBe('basic')
    expect(row.seats).toBe(2)
  })

  test('resume undoes a scheduled cancellation', async () => {
    const { owner, workspace } = await makeWorkspace()
    await db.subscription.updateMany({
      where: { workspaceId: workspace.id },
      data: { cancelAtPeriodEnd: true },
    })

    const res = await server.fetch(
      post(owner.id, '/api/billing/resume', { workspaceId: workspace.id }),
    )
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.cancelAtPeriodEnd).toBe(false)
    expect(callsTo('subscriptions.update')[0].args[1]).toEqual({ cancel_at_period_end: false })

    const row = await db.subscription.findFirst({ where: { workspaceId: workspace.id } })
    expect(row.cancelAtPeriodEnd).toBe(false)
  })

  test('a plain member cannot cancel the workspace subscription', async () => {
    const { member, workspace } = await makeWorkspace()

    const res = await server.fetch(
      post(member.id, '/api/billing/cancel', { workspaceId: workspace.id }),
    )

    expect(res.status).toBe(403)
    expect(callsTo('subscriptions.update')).toHaveLength(0)
  })
})
