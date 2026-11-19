// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-446 QA — the 30-day guarantee, end to end through the real webhook.
 *
 * The dev's tests call `handleOfferChargeRefunded` directly, so they prove the
 * decision but not that a refund made in the Stripe dashboard ever reaches it.
 * This suite boots the real cloud `server.ts` on a real SQLite database and
 * POSTs a **genuinely signed** `charge.refunded` event at
 * `/api/webhooks/stripe`, so the wiring the card exists to add is what is under
 * test. Only the outbound Stripe API calls are stubbed; signature verification
 * is the real SDK.
 *
 * Covered:
 *  - AC1 a full refund of the offer's first invoice flips the enrollment to
 *    `refunded`, and a redelivery of the same event changes nothing;
 *  - AC2 a partial refund, a non-offer subscription, a renewal invoice and a
 *    `rejected_prepaid` row are all left alone;
 *  - only `charge.refunded` acts — `charge.dispute.created` does not;
 *  - a Stripe API failure inside the handler still answers 200, so Stripe does
 *    not retry the event forever.
 *
 * Run: bun test apps/api/src/__tests__/solo-founder-refund-webhook.e2e.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.SHOGO_DATA_DIR = dir
process.env.WORKSPACES_DIR = `${dir}/workspaces`

// Build the SQLite Prisma client while the local flag is on, then clear it so
// `server.ts` takes the cloud branches (Stripe, billing, affiliates).
const { prisma } = await import('../lib/prisma')
delete process.env.SHOGO_LOCAL_MODE

const WEBHOOK_SECRET = 'whsec_sho446_e2e'
process.env.STRIPE_SECRET_KEY = 'sk_test_sho446'
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
process.env.BETTER_AUTH_SECRET = 'sho446-e2e-secret-0123456789abcdef0123'
process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3999'
process.env.APP_URL = 'http://127.0.0.1:3999'

// The real SDK, captured before the module is replaced, so the webhook's
// signature check is genuine.
const RealStripe = (await import('stripe')).default as any
const realStripe = new RealStripe('sk_test_sho446')

/** What the stubbed Stripe API should answer for the next event. */
const stripeState: {
  invoice: { id: string; billing_reason: string; subscription: string | null }
  offer: boolean
  fail?: boolean
} = {
  invoice: { id: 'in_first', billing_reason: 'subscription_create', subscription: 'sub_offer' },
  offer: true,
}

class StripeStub {
  webhooks = realStripe.webhooks
  invoicePayments = {
    list: async () => {
      if (stripeState.fail) throw new Error('stripe is down')
      return {
        data: [{ id: 'inpay_1', invoice: stripeState.invoice.id }],
        has_more: false,
        object: 'list',
      }
    },
  }
  invoices = {
    retrieve: async (id: string) => ({
      id,
      object: 'invoice',
      billing_reason: stripeState.invoice.billing_reason,
      parent: stripeState.invoice.subscription
        ? { type: 'subscription_details', subscription_details: { subscription: stripeState.invoice.subscription } }
        : null,
    }),
  }
  subscriptions = {
    retrieve: async (id: string) => ({
      id,
      object: 'subscription',
      metadata: stripeState.offer ? { offer: 'solo_founder' } : {},
    }),
  }
}

const { mock } = await import('bun:test')
mock.module('stripe', () => ({ default: StripeStub }))

const server = (await import('../server')).default as any
const { SOLO_FOUNDER_COURSE_ID } = await import('../config/solo-founder-course')

const db = prisma as any

/**
 * Stripe's signature header: `t=<unix>,v1=<hex HMAC-SHA256 of "t.payload">`.
 * Computed here rather than with `webhooks.generateTestHeaderString`, which
 * takes the synchronous HMAC path Bun's SubtleCrypto provider refuses.
 */
function stripeSignature(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')
  return `t=${timestamp},v1=${v1}`
}

/** A signed webhook request, exactly as Stripe would send it. */
function signedEvent(event: Record<string, unknown>) {
  const payload = JSON.stringify(event)
  const signature = stripeSignature(payload, WEBHOOK_SECRET)
  return new Request('http://127.0.0.1:3999/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: payload,
  })
}

function refundEvent(charge: Record<string, unknown>, id = 'evt_refund') {
  return { id, object: 'event', type: 'charge.refunded', data: { object: { object: 'charge', ...charge } } }
}

const fullCharge = (overrides: Record<string, unknown> = {}) => ({
  id: 'ch_offer',
  amount: 9900,
  amount_refunded: 9900,
  refunded: true,
  payment_intent: 'pi_offer',
  ...overrides,
})

/** An enrollment on its own workspace, so each case starts clean. */
async function enrollmentFor(subscriptionId: string, status = 'active') {
  const suffix = crypto.randomUUID().slice(0, 8)
  const user = await db.user.create({ data: { name: `buyer-${suffix}`, email: `buyer-${suffix}@example.com` } })
  const ws = await db.workspace.create({ data: { name: `Buyer ${suffix}`, slug: `buyer-${suffix}`, kind: 'team' } })
  await db.member.create({ data: { userId: user.id, workspaceId: ws.id, role: 'owner' } })
  const row = await db.courseEnrollment.create({
    data: {
      courseId: SOLO_FOUNDER_COURSE_ID,
      userId: user.id,
      workspaceId: ws.id,
      source: 'stripe',
      stripeSubscriptionId: subscriptionId,
      status,
      purchasedAt: new Date(),
      installStatus: status === 'active' ? 'installed' : 'failed',
    },
  })
  return row
}

const statusOf = async (id: string) =>
  (await db.courseEnrollment.findUnique({ where: { id } })).status

afterAll(async () => {
  await db.$disconnect?.()
})

describe('SHO-446 the Stripe webhook closes the course on a full refund', () => {
  test('a signed charge.refunded flips the enrollment, and a redelivery changes nothing', async () => {
    const row = await enrollmentFor('sub_offer')
    stripeState.invoice = { id: 'in_first', billing_reason: 'subscription_create', subscription: 'sub_offer' }
    stripeState.offer = true
    stripeState.fail = false

    const first = await server.fetch(signedEvent(refundEvent(fullCharge())))
    expect(first.status).toBe(200)
    expect(await statusOf(row.id)).toBe('refunded')

    // Stripe redelivers the same event: the route still 200s, the row is unchanged.
    const again = await server.fetch(signedEvent(refundEvent(fullCharge(), 'evt_refund')))
    expect(again.status).toBe(200)
    expect(await statusOf(row.id)).toBe('refunded')
  })

  test('a partial refund leaves the enrollment active', async () => {
    const row = await enrollmentFor('sub_partial')
    stripeState.invoice = { id: 'in_first', billing_reason: 'subscription_create', subscription: 'sub_partial' }
    stripeState.offer = true
    stripeState.fail = false

    const res = await server.fetch(
      signedEvent(refundEvent(fullCharge({ amount: 9900, amount_refunded: 2000, refunded: false }))),
    )
    expect(res.status).toBe(200)
    expect(await statusOf(row.id)).toBe('active')
  })

  test('a refund on a subscription that is not the offer leaves the enrollment active', async () => {
    const row = await enrollmentFor('sub_other')
    stripeState.invoice = { id: 'in_first', billing_reason: 'subscription_create', subscription: 'sub_other' }
    stripeState.offer = false
    stripeState.fail = false

    const res = await server.fetch(signedEvent(refundEvent(fullCharge())))
    expect(res.status).toBe(200)
    expect(await statusOf(row.id)).toBe('active')
  })

  test('a refund of a renewal invoice leaves the enrollment active', async () => {
    const row = await enrollmentFor('sub_renewal')
    stripeState.invoice = { id: 'in_renewal', billing_reason: 'subscription_cycle', subscription: 'sub_renewal' }
    stripeState.offer = true
    stripeState.fail = false

    const res = await server.fetch(signedEvent(refundEvent(fullCharge())))
    expect(res.status).toBe(200)
    expect(await statusOf(row.id)).toBe('active')
  })

  test('a rejected_prepaid row is never overwritten with refunded', async () => {
    const row = await enrollmentFor('sub_prepaid', 'rejected_prepaid')
    stripeState.invoice = { id: 'in_first', billing_reason: 'subscription_create', subscription: 'sub_prepaid' }
    stripeState.offer = true
    stripeState.fail = false

    const res = await server.fetch(signedEvent(refundEvent(fullCharge())))
    expect(res.status).toBe(200)
    expect(await statusOf(row.id)).toBe('rejected_prepaid')
  })

  test('charge.dispute.created does not close the course', async () => {
    const row = await enrollmentFor('sub_dispute')
    stripeState.invoice = { id: 'in_first', billing_reason: 'subscription_create', subscription: 'sub_dispute' }
    stripeState.offer = true
    stripeState.fail = false

    const res = await server.fetch(
      signedEvent({
        id: 'evt_dispute',
        object: 'event',
        type: 'charge.dispute.created',
        data: { object: { id: 'dp_1', object: 'dispute', charge: 'ch_offer' } },
      }),
    )
    expect(res.status).toBe(200)
    expect(await statusOf(row.id)).toBe('active')
  })

  test('a Stripe API failure inside the handler still answers 200', async () => {
    const row = await enrollmentFor('sub_down')
    stripeState.invoice = { id: 'in_first', billing_reason: 'subscription_create', subscription: 'sub_down' }
    stripeState.offer = true
    stripeState.fail = true

    const res = await server.fetch(signedEvent(refundEvent(fullCharge())))
    expect(res.status).toBe(200)
    expect(await statusOf(row.id)).toBe('active')
    stripeState.fail = false
  })

  test('an unsigned event is refused before any handler runs', async () => {
    const row = await enrollmentFor('sub_unsigned')
    stripeState.invoice = { id: 'in_first', billing_reason: 'subscription_create', subscription: 'sub_unsigned' }
    stripeState.offer = true
    stripeState.fail = false

    const res = await server.fetch(
      new Request('http://127.0.0.1:3999/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
        body: JSON.stringify(refundEvent(fullCharge())),
      }),
    )
    expect(res.status).toBe(400)
    expect(await statusOf(row.id)).toBe('active')
  })
})
