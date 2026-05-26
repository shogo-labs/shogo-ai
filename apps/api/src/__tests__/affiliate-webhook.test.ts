// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Affiliate webhook + reconciliation behavior.
 *
 * The actual webhook handler lives in server.ts and is too entangled
 * to mount in isolation; these tests cover the affiliate-specific
 * surface — `recordCommissionsForInvoice` and `handleClawback`
 * called the way the webhook calls them — plus the daily
 * `runAffiliateInvoiceReconciliation` cron that catches missed
 * webhooks.
 *
 * The webhook test for "signature failure → 400" is already covered
 * by `stripe-webhook.test.ts` for the generic handler; affiliate
 * commission logic only runs after the signature check passes, so
 * we don't re-test signature handling here.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// ---------------------------------------------------------------------------
// Prisma + lock mocks — identical shape to the affiliate.service test.
// ---------------------------------------------------------------------------

type Row = Record<string, any>
let affiliates: Map<string, Row>
let attributions: Map<string, Row>
let commissions: Row[]
let tiers: Row[]
let nextId = 0
function genId(p = 'id') { nextId++; return `${p}_${nextId}` }
function p2002() { const e: any = new Error('unique'); e.code = 'P2002'; return e }

const prismaStub = {
  $transaction: async (fn: any) => fn(prismaStub),
  affiliate: {
    findUnique: async ({ where }: any) => {
      if (where.id) return affiliates.get(where.id) ?? null
      if (where.userId) {
        for (const a of affiliates.values()) if (a.userId === where.userId) return a
        return null
      }
      return null
    },
    update: async ({ where, data }: any) => {
      const row = affiliates.get(where.id)!
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && ('increment' in (v as any) || 'decrement' in (v as any))) {
          const d = ('increment' in (v as any) ? (v as any).increment : -(v as any).decrement) as number
          row[k] = (row[k] ?? 0) + d
        } else (row as any)[k] = v
      }
      return row
    },
  },
  affiliateAttribution: {
    findFirst: async ({ where }: any) => {
      for (const a of attributions.values()) if (a.affiliateId === where.affiliateId) return a
      return null
    },
  },
  affiliateCommission: {
    create: async ({ data }: any) => {
      const dup = commissions.find((c) =>
        c.stripeInvoiceId === data.stripeInvoiceId &&
        c.affiliateId === data.affiliateId &&
        c.level === data.level,
      )
      if (dup && data.stripeInvoiceId != null) throw p2002()
      const row = { id: genId('com'), createdAt: new Date(), payoutId: null, ...data }
      commissions.push(row)
      return row
    },
    findMany: async ({ where }: any) =>
      commissions.filter((c) =>
        (!where.stripeChargeId || c.stripeChargeId === where.stripeChargeId) &&
        (!where.status?.in || where.status.in.includes(c.status)),
      ),
    update: async ({ where, data }: any) => {
      const c = commissions.find((c) => c.id === where.id)!
      Object.assign(c, data)
      return c
    },
  },
  affiliateCommissionTier: {
    findMany: async () => [...tiers].sort((a, b) => a.level - b.level),
  },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: prismaStub }))
mock.module('../lib/global-job-lock', () => ({
  withGlobalJobLock: async (_n: string, body: () => any) => ({ acquired: true, result: await body() }),
  KNOWN_JOB_IDS: {},
  jobNameToLockId: () => 0n,
}))

const svc = await import('../services/affiliate.service')
const recon = await import('../jobs/affiliate-invoice-reconciliation')

// ---------------------------------------------------------------------------
// Stripe fake
// ---------------------------------------------------------------------------

let stripeListPages: any[][]
let customerMetadata: Record<string, Record<string, string>>
let subMetadata: Record<string, Record<string, string>>

function makeStripe(): any {
  return {
    customers: {
      retrieve: async (id: string) => ({ id, deleted: false, metadata: customerMetadata[id] ?? {} }),
    },
    subscriptions: {
      retrieve: async (id: string) => ({ id, metadata: subMetadata[id] ?? {} }),
    },
    invoices: {
      list: async () => {
        const page = stripeListPages.shift() ?? []
        return { data: page, has_more: stripeListPages.length > 0 }
      },
    },
  }
}

function makeInvoice(opts: { id: string; customer?: string; subscription?: string; subtotal?: number; charge?: string; lines?: any[] }) {
  return {
    id: opts.id,
    customer: opts.customer ?? 'cus_default',
    subscription: opts.subscription ?? 'sub_default',
    subtotal: opts.subtotal ?? 10_000,
    total: opts.subtotal ?? 10_000,
    amount_paid: opts.subtotal ?? 10_000,
    charge: opts.charge ?? 'ch_default',
    lines: { data: opts.lines ?? [{ amount: opts.subtotal ?? 10_000, metadata: {} }] },
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  affiliates = new Map()
  attributions = new Map()
  commissions = []
  tiers = [
    { id: 't1', level: 1, rateBps: 2000, durationDays: 365, label: 'L1' },
  ]
  nextId = 0
  stripeListPages = []
  customerMetadata = {}
  subMetadata = {}
  process.env.SHOGO_AFFILIATES_NATIVE = 'true'
})

afterEach(() => {
  delete process.env.SHOGO_AFFILIATES_NATIVE
})

function seedAffiliateAndAttribution(opts: { affiliateId: string; userId: string; referredUserId: string; customerId: string }) {
  affiliates.set(opts.affiliateId, {
    id: opts.affiliateId, userId: opts.userId, code: 'a', depth: 1,
    status: 'active', pendingPayoutCents: 0, totalEarningsCents: 0, totalPaidOutCents: 0,
    parentAffiliateId: null,
  })
  attributions.set(opts.referredUserId, {
    id: 'attr_1', userId: opts.referredUserId, affiliateId: opts.affiliateId,
    attributedAt: new Date('2026-01-01'),
  })
  customerMetadata[opts.customerId] = { affiliateId: opts.affiliateId }
}

// ===========================================================================
// invoice.payment_succeeded — the webhook hot path
// ===========================================================================

describe('invoice.payment_succeeded → recordCommissionsForInvoice', () => {
  test('creates a commission for a customer tagged with an affiliateId', async () => {
    seedAffiliateAndAttribution({ affiliateId: 'aff_1', userId: 'u-aff', referredUserId: 'u-ref', customerId: 'cus_x' })
    const created = await svc.recordCommissionsForInvoice(
      makeInvoice({ id: 'in_1', customer: 'cus_x' }),
      makeStripe(),
      new Date('2026-05-01'),
    )
    expect(created).toBe(1)
    expect(commissions.length).toBe(1)
    expect(commissions[0].amountCents).toBe(2000)
  })

  test('webhook replay (same invoice) is a no-op — no duplicate rows', async () => {
    seedAffiliateAndAttribution({ affiliateId: 'aff_1', userId: 'u-aff', referredUserId: 'u-ref', customerId: 'cus_x' })
    const stripe = makeStripe()
    const invoice = makeInvoice({ id: 'in_1', customer: 'cus_x' })
    await svc.recordCommissionsForInvoice(invoice, stripe, new Date('2026-05-01'))
    const before = commissions.length
    await svc.recordCommissionsForInvoice(invoice, stripe, new Date('2026-05-01'))
    expect(commissions.length).toBe(before)
  })

  test('customer with no affiliateId metadata is a no-op', async () => {
    customerMetadata['cus_x'] = {}
    const created = await svc.recordCommissionsForInvoice(
      makeInvoice({ id: 'in_1', customer: 'cus_x' }),
      makeStripe(),
    )
    expect(created).toBe(0)
  })

  test('feature flag off short-circuits regardless of metadata', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'false'
    seedAffiliateAndAttribution({ affiliateId: 'aff_1', userId: 'u-aff', referredUserId: 'u-ref', customerId: 'cus_x' })
    const created = await svc.recordCommissionsForInvoice(
      makeInvoice({ id: 'in_1', customer: 'cus_x' }),
      makeStripe(),
    )
    expect(created).toBe(0)
  })
})

// ===========================================================================
// charge.refunded / charge.dispute.created → handleClawback
// ===========================================================================

describe('charge.refunded / charge.dispute.created → handleClawback', () => {
  test('flips pending/approved commissions for the refunded charge to refunded', async () => {
    seedAffiliateAndAttribution({ affiliateId: 'aff_1', userId: 'u-aff', referredUserId: 'u-ref', customerId: 'cus_x' })
    commissions.push(
      { id: 'c1', affiliateId: 'aff_1', stripeChargeId: 'ch_bad', status: 'pending', amountCents: 1000 },
      { id: 'c2', affiliateId: 'aff_1', stripeChargeId: 'ch_bad', status: 'approved', amountCents: 500 },
    )
    affiliates.get('aff_1')!.pendingPayoutCents = 1500
    const res = await svc.handleClawback('ch_bad', 'refund')
    expect(res.refunded).toBe(2)
    expect(commissions[0].status).toBe('refunded')
    expect(commissions[1].status).toBe('refunded')
    expect(affiliates.get('aff_1')!.pendingPayoutCents).toBe(0)
  })

  test('flips already-paid commissions to clawed_back', async () => {
    seedAffiliateAndAttribution({ affiliateId: 'aff_1', userId: 'u-aff', referredUserId: 'u-ref', customerId: 'cus_x' })
    commissions.push({ id: 'c1', affiliateId: 'aff_1', stripeChargeId: 'ch_d', status: 'paid', amountCents: 700 })
    const res = await svc.handleClawback('ch_d', 'dispute')
    expect(res.clawedBack).toBe(1)
    expect(commissions[0].status).toBe('clawed_back')
  })
})

// ===========================================================================
// reconciliation cron
// ===========================================================================

describe('runAffiliateInvoiceReconciliation', () => {
  test('walks the paid-invoice window and records missed commissions', async () => {
    seedAffiliateAndAttribution({ affiliateId: 'aff_1', userId: 'u-aff', referredUserId: 'u-ref', customerId: 'cus_x' })
    stripeListPages = [
      [makeInvoice({ id: 'in_1', customer: 'cus_x' }), makeInvoice({ id: 'in_2', customer: 'cus_x' })],
    ]
    const summary = await recon.runAffiliateInvoiceReconciliation({
      stripeFactory: () => makeStripe(),
    })
    expect(summary.invoicesScanned).toBe(2)
    expect(summary.commissionsCreated).toBe(2)
    expect(commissions.length).toBe(2)
  })

  test('is idempotent — re-runs against the same invoices write no new rows', async () => {
    seedAffiliateAndAttribution({ affiliateId: 'aff_1', userId: 'u-aff', referredUserId: 'u-ref', customerId: 'cus_x' })
    const inv = makeInvoice({ id: 'in_1', customer: 'cus_x' })
    stripeListPages = [[inv]]
    await recon.runAffiliateInvoiceReconciliation({ stripeFactory: () => makeStripe() })
    stripeListPages = [[inv]]
    const summary2 = await recon.runAffiliateInvoiceReconciliation({ stripeFactory: () => makeStripe() })
    expect(summary2.invoicesScanned).toBe(1)
    expect(summary2.commissionsCreated).toBe(0)
  })

  test('feature flag off → no-op even when invoices are pending', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'false'
    seedAffiliateAndAttribution({ affiliateId: 'aff_1', userId: 'u-aff', referredUserId: 'u-ref', customerId: 'cus_x' })
    stripeListPages = [[makeInvoice({ id: 'in_1', customer: 'cus_x' })]]
    const summary = await recon.runAffiliateInvoiceReconciliation({
      stripeFactory: () => makeStripe(),
    })
    expect(summary.invoicesScanned).toBe(0)
    expect(summary.commissionsCreated).toBe(0)
  })

  test('failed invoice does not abort the batch', async () => {
    seedAffiliateAndAttribution({ affiliateId: 'aff_1', userId: 'u-aff', referredUserId: 'u-ref', customerId: 'cus_good' })
    // The "bad" invoice points at a customer whose Stripe lookup throws,
    // so `recordCommissionsForInvoice` swallows the error and returns 0
    // for that one — but the cron should still walk to `in_good` and
    // record its commission.
    const bad = makeInvoice({ id: 'in_bad', customer: 'cus_bad' })
    const good = makeInvoice({ id: 'in_good', customer: 'cus_good' })
    stripeListPages = [[bad, good]]
    const stripe = makeStripe()
    const origRetrieve = stripe.customers.retrieve
    stripe.customers.retrieve = async (id: string) => {
      if (id === 'cus_bad') throw new Error('boom')
      return origRetrieve(id)
    }
    const summary = await recon.runAffiliateInvoiceReconciliation({
      stripeFactory: () => stripe,
    })
    expect(summary.invoicesScanned).toBe(2)
    // bad-customer invoice short-circuits in the service (logged + 0),
    // good-customer invoice writes 1 commission.
    expect(summary.commissionsCreated).toBe(1)
  })
})
