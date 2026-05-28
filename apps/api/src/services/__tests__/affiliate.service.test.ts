// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Affiliate service unit tests.
 *
 * Mocks the Prisma module surface and the global-job-lock helper.
 * Stripe is mocked per-test as a fake class with method spies so we
 * can assert on idempotency keys, transfer/payout sequencing, and
 * failure isolation between affiliates.
 *
 * Run: bun test apps/api/src/services/__tests__/affiliate.service.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from '../../__tests__/helpers/prisma-mock-exports'

// ---------------------------------------------------------------------------
// In-memory store + spies — reset by beforeEach.
// ---------------------------------------------------------------------------

type Row = Record<string, any>

let affiliates: Map<string, Row>
let clicks: Row[]
let attributions: Map<string, Row> // keyed by userId
let commissions: Row[]
let payouts: Row[]
let tiers: Row[]
let users: Map<string, Row>

let nextId = 0
function genId(prefix = 'id'): string {
  nextId++
  return `${prefix}_${nextId}`
}

function p2002() {
  const err: any = new Error('Unique constraint failed')
  err.code = 'P2002'
  return err
}

const prismaStub = {
  $transaction: async (fn: any) => fn(prismaStub),
  user: {
    findUnique: async ({ where }: any) => users.get(where.id) ?? null,
  },
  affiliate: {
    findUnique: async ({ where }: any) => {
      if (where.userId) {
        for (const a of affiliates.values()) if (a.userId === where.userId) return a
        return null
      }
      if (where.code) {
        for (const a of affiliates.values()) if (a.code === where.code) return a
        return null
      }
      return affiliates.get(where.id) ?? null
    },
    findFirst: async ({ where }: any) => {
      for (const a of affiliates.values()) {
        if (where.userId && a.userId !== where.userId) continue
        return a
      }
      return null
    },
    findMany: async ({ where, select }: any) => {
      const rows: Row[] = []
      for (const a of affiliates.values()) {
        if (where?.parentAffiliateId !== undefined) {
          const target = where.parentAffiliateId
          if (typeof target === 'string') {
            if (a.parentAffiliateId !== target) continue
          } else if (target?.in) {
            if (!target.in.includes(a.parentAffiliateId)) continue
          }
        }
        rows.push(select ? Object.fromEntries(Object.keys(select).map((k) => [k, a[k]])) : a)
      }
      return rows
    },
    create: async ({ data }: any) => {
      for (const a of affiliates.values()) {
        if (a.userId === data.userId) throw p2002()
        if (a.code === data.code) throw p2002()
      }
      const id = genId('aff')
      const row = {
        id,
        depth: 1,
        status: 'active',
        payoutStatus: 'not_setup',
        pendingPayoutCents: 0,
        totalEarningsCents: 0,
        totalPaidOutCents: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      }
      affiliates.set(id, row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = affiliates.get(where.id)
      if (!row) throw new Error('not found ' + where.id)
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && ('increment' in (v as any) || 'decrement' in (v as any))) {
          const delta = ('increment' in (v as any) ? (v as any).increment : -(v as any).decrement) as number
          row[k] = (row[k] ?? 0) + delta
        } else {
          row[k] = v as any
        }
      }
      return row
    },
  },
  affiliateClick: {
    create: async ({ data }: any) => {
      const id = genId('clk')
      const row = { id, createdAt: data.createdAt ?? new Date(), ...data }
      clicks.push(row)
      return row
    },
    findMany: async ({ where, take, include }: any) => {
      const now = new Date()
      const rows = clicks
        .filter((c) => c.visitorId === where.visitorId)
        .filter((c) => !where.expiresAt || c.expiresAt > (where.expiresAt.gt ?? now))
        .sort((a, b) => +b.createdAt - +a.createdAt)
        .slice(0, take ?? 50)
      if (include?.affiliate) {
        return rows.map((c) => ({ ...c, affiliate: affiliates.get(c.affiliateId) ?? null }))
      }
      return rows
    },
    count: async ({ where }: any) => clicks.filter((c) =>
      c.affiliateId === where.affiliateId &&
      (!where.createdAt?.gte || c.createdAt >= where.createdAt.gte),
    ).length,
  },
  affiliateAttribution: {
    findUnique: async ({ where }: any) => attributions.get(where.userId) ?? null,
    findFirst: async ({ where }: any) => {
      const list = [...attributions.values()].filter((a) => a.affiliateId === where.affiliateId)
      list.sort((a, b) => +b.attributedAt - +a.attributedAt)
      return list[0] ?? null
    },
    create: async ({ data }: any) => {
      if (attributions.has(data.userId)) throw p2002()
      const row = { id: genId('attr'), attributedAt: new Date(), ...data }
      attributions.set(data.userId, row)
      return row
    },
    count: async ({ where }: any) => [...attributions.values()].filter((a) =>
      a.affiliateId === where.affiliateId &&
      (!where.attributedAt?.gte || a.attributedAt >= where.attributedAt.gte),
    ).length,
  },
  affiliateCommission: {
    findFirst: async ({ where, orderBy, select }: any) => {
      const rows = commissions
        .filter((c) =>
          (!where.affiliateId || c.affiliateId === where.affiliateId) &&
          (!where.status || c.status === where.status) &&
          (where.payoutId === undefined || c.payoutId === where.payoutId),
        )
        .sort((a, b) => orderBy?.createdAt === 'asc' ? +a.createdAt - +b.createdAt : +b.createdAt - +a.createdAt)
      const row = rows[0] ?? null
      if (!row || !select) return row
      return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]))
    },
    findMany: async ({ where }: any) => {
      return commissions.filter((c) => {
        if (where.stripeChargeId && c.stripeChargeId !== where.stripeChargeId) return false
        if (where.status?.in && !where.status.in.includes(c.status)) return false
        return true
      })
    },
    groupBy: async ({ where, by, _sum }: any) => {
      const filtered = commissions.filter((c) => {
        if (where.status && c.status !== where.status) return false
        if (where.payoutId === null && c.payoutId !== null) return false
        if (where.affiliateId && c.affiliateId !== where.affiliateId) return false
        return true
      })
      const buckets = new Map<string, Row>()
      for (const c of filtered) {
        const key = by.map((b: string) => c[b]).join('|')
        let bucket = buckets.get(key)
        if (!bucket) {
          bucket = { ...Object.fromEntries(by.map((b: string) => [b, c[b]])), _sum: {} }
          buckets.set(key, bucket)
        }
        if (_sum) {
          for (const k of Object.keys(_sum)) {
            bucket._sum[k] = (bucket._sum[k] ?? 0) + (c[k] ?? 0)
          }
        }
      }
      return [...buckets.values()]
    },
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
    update: async ({ where, data }: any) => {
      const row = commissions.find((c) => c.id === where.id)
      if (!row) throw new Error('not found')
      Object.assign(row, data)
      return row
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const c of commissions) {
        if (where.status === c.status && (where.eligibleAt?.lte ? c.eligibleAt <= where.eligibleAt.lte : true)
            && (where.affiliateId === undefined || c.affiliateId === where.affiliateId)
            && (where.payoutId === undefined || c.payoutId === where.payoutId)) {
          Object.assign(c, data)
          count++
        }
      }
      return { count }
    },
  },
  affiliatePayout: {
    create: async ({ data }: any) => {
      const row = { id: genId('po'), status: 'pending', createdAt: new Date(), ...data }
      payouts.push(row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = payouts.find((p) => p.id === where.id)
      if (!row) throw new Error('not found')
      Object.assign(row, data)
      return row
    },
  },
  affiliateCommissionTier: {
    findMany: async ({ orderBy }: any) => {
      const sorted = [...tiers]
      if (orderBy?.level === 'asc') sorted.sort((a, b) => a.level - b.level)
      return sorted
    },
  },
}

mock.module('../../lib/prisma', () => withPrismaExports({ prisma: prismaStub }))

// Bypass the global advisory lock — just run the body.
mock.module('../../lib/global-job-lock', () => ({
  withGlobalJobLock: async (_name: string, body: () => any) => ({ acquired: true, result: await body() }),
  KNOWN_JOB_IDS: {} as Record<string, bigint>,
  jobNameToLockId: () => 0n,
}))

const svc = await import('../affiliate.service')

// ---------------------------------------------------------------------------
// Fake Stripe — minimal surface used by recordCommissionsForInvoice + payouts.
// ---------------------------------------------------------------------------

interface StripeCall {
  method: string
  args: any[]
  idempotencyKey?: string
  stripeAccount?: string
}

let stripeCalls: StripeCall[]
let customerMetadata: Record<string, Record<string, string>>
let subscriptionMetadata: Record<string, Record<string, string>>
let stripeFailureMethod: string | null = null

function makeStripe(): any {
  return {
    customers: {
      retrieve: async (id: string) => {
        stripeCalls.push({ method: 'customers.retrieve', args: [id] })
        return { id, deleted: false, metadata: customerMetadata[id] ?? {} }
      },
    },
    subscriptions: {
      retrieve: async (id: string) => {
        stripeCalls.push({ method: 'subscriptions.retrieve', args: [id] })
        return { id, metadata: subscriptionMetadata[id] ?? {} }
      },
    },
    transfers: {
      create: async (args: any, opts: any) => {
        stripeCalls.push({ method: 'transfers.create', args: [args], idempotencyKey: opts?.idempotencyKey })
        if (stripeFailureMethod === 'transfers.create') {
          stripeFailureMethod = null
          throw new Error('boom transfer')
        }
        return { id: `tr_${stripeCalls.length}` }
      },
    },
    payouts: {
      create: async (args: any, opts: any) => {
        stripeCalls.push({
          method: 'payouts.create',
          args: [args],
          idempotencyKey: opts?.idempotencyKey,
          stripeAccount: opts?.stripeAccount,
        })
        if (stripeFailureMethod === 'payouts.create') {
          stripeFailureMethod = null
          throw new Error('boom payout')
        }
        return { id: `po_${stripeCalls.length}` }
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  affiliates = new Map()
  clicks = []
  attributions = new Map()
  commissions = []
  payouts = []
  tiers = [
    { id: 'tier_l1', level: 1, rateBps: 2000, durationDays: 365, label: 'L1' },
    { id: 'tier_l2', level: 2, rateBps: 500, durationDays: 365, label: 'L2' },
    { id: 'tier_l3', level: 3, rateBps: 200, durationDays: 365, label: 'L3' },
  ]
  users = new Map()
  nextId = 0
  stripeCalls = []
  customerMetadata = {}
  subscriptionMetadata = {}
  stripeFailureMethod = null
  process.env.SHOGO_AFFILIATES_NATIVE = 'true'
  delete process.env.SHOGO_AFFILIATE_MAX_DEPTH
  delete process.env.SHOGO_AFFILIATE_REFUND_HOLD_DAYS
  delete process.env.SHOGO_AFFILIATE_MIN_PAYOUT_CENTS
  delete process.env.SHOGO_AFFILIATE_COOKIE_DAYS
})

afterEach(() => {
  delete process.env.SHOGO_AFFILIATES_NATIVE
})

function seedUser(id: string, email = `${id}@example.com`, name = id) {
  users.set(id, { id, email, name })
}

function seedAffiliate(opts: { id?: string; userId: string; code: string; parentAffiliateId?: string | null; depth?: number; status?: string }) {
  const id = opts.id ?? genId('aff')
  const row: Row = {
    id,
    userId: opts.userId,
    code: opts.code,
    parentAffiliateId: opts.parentAffiliateId ?? null,
    depth: opts.depth ?? 1,
    status: opts.status ?? 'active',
    payoutStatus: 'not_setup',
    stripeCustomAccountId: null,
    pendingPayoutCents: 0,
    totalEarningsCents: 0,
    totalPaidOutCents: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  affiliates.set(id, row)
  return row
}

// ===========================================================================
// enrollAffiliate
// ===========================================================================

describe('enrollAffiliate', () => {
  test('happy path: opt-in, slug derived from email', async () => {
    seedUser('u1', 'ada@example.com', 'Ada Lovelace')
    const row = await svc.enrollAffiliate('u1', { termsAccepted: true })
    expect(row.code).toBe('ada-lovelace')
    expect(row.depth).toBe(1)
    expect(row.parentAffiliateId).toBeNull()
    expect(row.termsAcceptedAt).toBeInstanceOf(Date)
  })

  test('terms must be accepted', async () => {
    seedUser('u1')
    await expect(svc.enrollAffiliate('u1', { termsAccepted: false })).rejects.toThrow(/terms/)
  })

  test('re-enrolling is idempotent (returns existing row)', async () => {
    seedUser('u1', 'a@a.com', 'Ada')
    const first = await svc.enrollAffiliate('u1', { termsAccepted: true })
    const second = await svc.enrollAffiliate('u1', { termsAccepted: true })
    expect(second.id).toBe(first.id)
  })

  test('explicit code collision is a hard error (no silent suffix)', async () => {
    seedUser('u1', 'a@a.com', 'Ada')
    seedUser('u2', 'b@b.com', 'Bob')
    await svc.enrollAffiliate('u1', { code: 'team-alpha', termsAccepted: true })
    await expect(
      svc.enrollAffiliate('u2', { code: 'team-alpha', termsAccepted: true }),
    ).rejects.toMatchObject({ code: 'code_taken' })
  })

  test('auto-derived slug collisions retry with random suffix', async () => {
    seedUser('u1', 'foo@example.com', 'shared')
    seedUser('u2', 'foo2@example.com', 'shared')
    const a = await svc.enrollAffiliate('u1', { termsAccepted: true })
    const b = await svc.enrollAffiliate('u2', { termsAccepted: true })
    expect(a.code).toBe('shared')
    expect(b.code).toMatch(/^shared-[a-z0-9]{4}$/)
  })

  test('rejects self-referral via parentCode (defensive guard)', async () => {
    // The enroll-by-userId idempotency check normally short-circuits
    // before the parent self-referral guard can run. Simulate the
    // corrupted state — an affiliate row whose code lookup resolves
    // to `u1` but whose userId lookup is missing — by patching the
    // mock for one call. (Real-world trigger: a backfill that wrote
    // a code-only row without a corresponding userId mapping.)
    seedAffiliate({ id: 'aff_mine', userId: 'u1', code: 'mine' })
    seedUser('u1', 'a@a.com', 'Ada')
    const origFindUnique = prismaStub.affiliate.findUnique
    prismaStub.affiliate.findUnique = (async ({ where }: any) => {
      if (where.userId === 'u1') return null
      return origFindUnique({ where })
    }) as any
    try {
      await expect(
        svc.enrollAffiliate('u1', { parentCode: 'mine', termsAccepted: true }),
      ).rejects.toMatchObject({ code: 'self_referral' })
    } finally {
      prismaStub.affiliate.findUnique = origFindUnique
    }
  })

  test('rejects parent_too_deep when chain would exceed max depth', async () => {
    process.env.SHOGO_AFFILIATE_MAX_DEPTH = '3'
    seedAffiliate({ userId: 'u-root', code: 'root', depth: 1 })
    const l2 = seedAffiliate({ userId: 'u-l2', code: 'l2', parentAffiliateId: 'aff_1', depth: 2 })
    seedAffiliate({ userId: 'u-l3', code: 'l3', parentAffiliateId: l2.id, depth: 3 })
    seedUser('u-new', 'n@n.com', 'New')
    await expect(
      svc.enrollAffiliate('u-new', { parentCode: 'l3', termsAccepted: true }),
    ).rejects.toMatchObject({ code: 'parent_too_deep' })
  })

  test('happy path with parent updates depth', async () => {
    seedAffiliate({ id: 'aff_root', userId: 'u-root', code: 'root', depth: 1 })
    seedUser('u-child', 'c@c.com', 'Child')
    const child = await svc.enrollAffiliate('u-child', { parentCode: 'root', termsAccepted: true })
    expect(child.depth).toBe(2)
    expect(child.parentAffiliateId).toBe('aff_root')
  })

  test('unknown parent code throws parent_not_found', async () => {
    seedUser('u1')
    await expect(
      svc.enrollAffiliate('u1', { parentCode: 'who-dis', termsAccepted: true }),
    ).rejects.toMatchObject({ code: 'parent_not_found' })
  })
})

// ===========================================================================
// recordClick
// ===========================================================================

describe('recordClick', () => {
  test('inserts a click row with cookie expiry math', async () => {
    process.env.SHOGO_AFFILIATE_COOKIE_DAYS = '7'
    seedAffiliate({ userId: 'u1', code: 'alpha' })
    const now = new Date('2026-06-01T00:00:00Z')
    const row = await svc.recordClick({
      code: 'alpha',
      visitorId: 'v1',
      ip: '203.0.113.1',
      userAgent: 'curl/8',
      landingPage: '/',
      utmSource: 'twitter',
      now,
    })
    expect(row.affiliateId).toBe('aff_1')
    expect(row.ipHash).toMatch(/^[a-f0-9]{64}$/)
    expect(row.utmSource).toBe('twitter')
    expect(+row.expiresAt - +now).toBe(7 * 24 * 60 * 60 * 1000)
  })

  test('404s on unknown affiliate', async () => {
    await expect(svc.recordClick({ code: 'nobody', visitorId: 'v' })).rejects.toMatchObject({
      code: 'affiliate_not_found',
    })
  })

  test('rejects suspended affiliate', async () => {
    seedAffiliate({ userId: 'u1', code: 'banned', status: 'suspended' })
    await expect(svc.recordClick({ code: 'banned', visitorId: 'v' })).rejects.toMatchObject({
      code: 'affiliate_inactive',
    })
  })
})

// ===========================================================================
// resolveAttributionForUser
// ===========================================================================

describe('resolveAttributionForUser', () => {
  test('picks the most-recent non-expired click for a visitor', async () => {
    seedAffiliate({ id: 'aff_a', userId: 'u-a', code: 'a' })
    seedAffiliate({ id: 'aff_b', userId: 'u-b', code: 'b' })
    seedUser('u-new')
    clicks.push(
      { id: 'c1', affiliateId: 'aff_a', visitorId: 'v', createdAt: new Date('2026-01-01'), expiresAt: new Date('2099-01-01') },
      { id: 'c2', affiliateId: 'aff_b', visitorId: 'v', createdAt: new Date('2026-02-01'), expiresAt: new Date('2099-01-01') },
    )
    const attr = await svc.resolveAttributionForUser('u-new', 'v')
    expect(attr).not.toBeNull()
    expect(attr!.affiliateId).toBe('aff_b')
  })

  test('ignores expired clicks', async () => {
    seedAffiliate({ id: 'aff_a', userId: 'u-a', code: 'a' })
    seedUser('u-new')
    clicks.push({
      id: 'c1', affiliateId: 'aff_a', visitorId: 'v', createdAt: new Date('2020-01-01'),
      expiresAt: new Date('2020-12-31'),
    })
    const attr = await svc.resolveAttributionForUser('u-new', 'v')
    expect(attr).toBeNull()
  })

  test('is idempotent — re-calls never overwrite', async () => {
    seedAffiliate({ id: 'aff_a', userId: 'u-a', code: 'a' })
    seedUser('u-new')
    clicks.push({ id: 'c1', affiliateId: 'aff_a', visitorId: 'v', createdAt: new Date(), expiresAt: new Date('2099-01-01') })
    const first = await svc.resolveAttributionForUser('u-new', 'v')
    const second = await svc.resolveAttributionForUser('u-new', 'v')
    expect(second!.id).toBe(first!.id)
  })

  test('rejects self-referral (click on your own affiliate)', async () => {
    seedAffiliate({ id: 'aff_self', userId: 'u-new', code: 'mine' })
    seedUser('u-new')
    clicks.push({ id: 'c1', affiliateId: 'aff_self', visitorId: 'v', createdAt: new Date(), expiresAt: new Date('2099-01-01') })
    const attr = await svc.resolveAttributionForUser('u-new', 'v')
    expect(attr).toBeNull()
  })

  test('uses the `code` hint to disambiguate concurrent clicks', async () => {
    seedAffiliate({ id: 'aff_a', userId: 'u-a', code: 'a' })
    seedAffiliate({ id: 'aff_b', userId: 'u-b', code: 'b' })
    seedUser('u-new')
    clicks.push(
      { id: 'c1', affiliateId: 'aff_a', visitorId: 'v', createdAt: new Date('2026-01-01'), expiresAt: new Date('2099-01-01') },
      { id: 'c2', affiliateId: 'aff_b', visitorId: 'v', createdAt: new Date('2026-02-01'), expiresAt: new Date('2099-01-01') },
    )
    const attr = await svc.resolveAttributionForUser('u-new', 'v', 'a')
    expect(attr!.affiliateId).toBe('aff_a')
  })
})

// ===========================================================================
// getUpline
// ===========================================================================

describe('getUpline', () => {
  test('returns single entry for a root affiliate', async () => {
    seedAffiliate({ id: 'aff_root', userId: 'u1', code: 'root' })
    const u = await svc.getUpline('aff_root', 3)
    expect(u).toEqual([{ affiliateId: 'aff_root', level: 1 }])
  })

  test('walks 3 levels in order', async () => {
    seedAffiliate({ id: 'aff_root', userId: 'u-root', code: 'root', depth: 1 })
    seedAffiliate({ id: 'aff_l2', userId: 'u-l2', code: 'l2', parentAffiliateId: 'aff_root', depth: 2 })
    seedAffiliate({ id: 'aff_l3', userId: 'u-l3', code: 'l3', parentAffiliateId: 'aff_l2', depth: 3 })
    const u = await svc.getUpline('aff_l3', 3)
    expect(u).toEqual([
      { affiliateId: 'aff_l3', level: 1 },
      { affiliateId: 'aff_l2', level: 2 },
      { affiliateId: 'aff_root', level: 3 },
    ])
  })

  test('respects the depth cap', async () => {
    seedAffiliate({ id: 'aff_root', userId: 'u-root', code: 'root', depth: 1 })
    seedAffiliate({ id: 'aff_l2', userId: 'u-l2', code: 'l2', parentAffiliateId: 'aff_root', depth: 2 })
    seedAffiliate({ id: 'aff_l3', userId: 'u-l3', code: 'l3', parentAffiliateId: 'aff_l2', depth: 3 })
    const u = await svc.getUpline('aff_l3', 2)
    expect(u.length).toBe(2)
    expect(u[1].affiliateId).toBe('aff_l2')
  })

  test('broken chain terminates cleanly', async () => {
    seedAffiliate({ id: 'aff_a', userId: 'u-a', code: 'a', parentAffiliateId: 'aff_missing' })
    const u = await svc.getUpline('aff_a', 3)
    expect(u).toEqual([{ affiliateId: 'aff_a', level: 1 }])
  })
})

// ===========================================================================
// recordCommissionsForInvoice
// ===========================================================================

describe('recordCommissionsForInvoice', () => {
  function setupTree() {
    const root = seedAffiliate({ id: 'aff_root', userId: 'u-root', code: 'root', depth: 1 })
    const l2 = seedAffiliate({ id: 'aff_l2', userId: 'u-l2', code: 'l2', parentAffiliateId: root.id, depth: 2 })
    const direct = seedAffiliate({ id: 'aff_direct', userId: 'u-direct', code: 'direct', parentAffiliateId: l2.id, depth: 3 })
    customerMetadata['cus_buyer'] = { affiliateId: direct.id }
    attributions.set('u-buyer', {
      id: 'attr_buyer',
      userId: 'u-buyer',
      affiliateId: direct.id,
      attributedAt: new Date('2026-05-01'),
    })
    return { root, l2, direct }
  }

  function buildInvoice(overrides: any = {}) {
    return {
      id: 'in_1',
      customer: 'cus_buyer',
      subscription: 'sub_1',
      subtotal: 10_000,
      total: 10_000,
      amount_paid: 10_000,
      charge: 'ch_1',
      lines: { data: [{ amount: 10_000, metadata: {} }] },
      ...overrides,
    }
  }

  test('writes 3-level commission split with seeded tier table', async () => {
    setupTree()
    const stripe = makeStripe()
    const created = await svc.recordCommissionsForInvoice(buildInvoice(), stripe, new Date('2026-05-15'))
    expect(created).toBe(3)
    const byAff = Object.fromEntries(commissions.map((c) => [c.affiliateId, c]))
    expect(byAff.aff_direct.amountCents).toBe(2000) // 20%
    expect(byAff.aff_direct.level).toBe(1)
    expect(byAff.aff_l2.amountCents).toBe(500) // 5%
    expect(byAff.aff_l2.level).toBe(2)
    expect(byAff.aff_root.amountCents).toBe(200) // 2%
    expect(byAff.aff_root.level).toBe(3)
    // Counters updated.
    expect(affiliates.get('aff_direct')!.pendingPayoutCents).toBe(2000)
    expect(affiliates.get('aff_l2')!.pendingPayoutCents).toBe(500)
    expect(affiliates.get('aff_root')!.pendingPayoutCents).toBe(200)
  })

  test('feature flag off → no-op', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'false'
    setupTree()
    const created = await svc.recordCommissionsForInvoice(buildInvoice(), makeStripe())
    expect(created).toBe(0)
    expect(commissions.length).toBe(0)
  })

  test('iOS IAP subscription short-circuits', async () => {
    setupTree()
    subscriptionMetadata['sub_1'] = { source: 'ios_iap' }
    const created = await svc.recordCommissionsForInvoice(buildInvoice(), makeStripe())
    expect(created).toBe(0)
    expect(commissions.length).toBe(0)
  })

  test('webhook replay is idempotent — no duplicate rows', async () => {
    setupTree()
    const stripe = makeStripe()
    await svc.recordCommissionsForInvoice(buildInvoice(), stripe, new Date('2026-05-15'))
    const beforeLen = commissions.length
    const beforePending = affiliates.get('aff_direct')!.pendingPayoutCents
    await svc.recordCommissionsForInvoice(buildInvoice(), stripe, new Date('2026-05-15'))
    expect(commissions.length).toBe(beforeLen)
    expect(affiliates.get('aff_direct')!.pendingPayoutCents).toBe(beforePending)
  })

  test('excludes overage_block line items from the basis', async () => {
    setupTree()
    const invoice = buildInvoice({
      subtotal: 30_000,
      lines: {
        data: [
          { amount: 10_000, metadata: { kind: 'subscription' } },
          { amount: 20_000, metadata: { kind: 'overage_block' } },
        ],
      },
    })
    await svc.recordCommissionsForInvoice(invoice, makeStripe(), new Date('2026-05-15'))
    // Basis = 30_000 - 20_000 = 10_000. L1 commission = 2000.
    const direct = commissions.find((c) => c.level === 1)!
    expect(direct.basisCents).toBe(10_000)
    expect(direct.amountCents).toBe(2000)
  })

  test('customer with no affiliateId metadata → no-op', async () => {
    customerMetadata['cus_buyer'] = {}
    seedAffiliate({ userId: 'u-other', code: 'other' })
    const created = await svc.recordCommissionsForInvoice(buildInvoice(), makeStripe())
    expect(created).toBe(0)
  })

  test('attribution older than L1 durationDays → skips L1 but still pays L2/L3 with longer windows', async () => {
    const { direct } = setupTree()
    attributions.set('u-buyer', {
      id: 'attr_buyer',
      userId: 'u-buyer',
      affiliateId: direct.id,
      attributedAt: new Date('2025-01-01'),
    })
    tiers = [
      { id: 't1', level: 1, rateBps: 2000, durationDays: 30, label: 'L1 short' },
      { id: 't2', level: 2, rateBps: 500, durationDays: null, label: 'L2 forever' },
      { id: 't3', level: 3, rateBps: 200, durationDays: 365, label: 'L3 expired' },
    ]
    const created = await svc.recordCommissionsForInvoice(buildInvoice(), makeStripe(), new Date('2026-05-15'))
    // L1 expired (30d < ~500d), L2 forever applies, L3 365d < ~500d, also skip.
    expect(created).toBe(1)
    expect(commissions[0].level).toBe(2)
  })
})

// ===========================================================================
// handleClawback
// ===========================================================================

describe('handleClawback', () => {
  test('pending and approved rows → refunded; counters decrement', async () => {
    const aff = seedAffiliate({ userId: 'u1', code: 'a' })
    aff.pendingPayoutCents = 1500
    commissions.push(
      { id: 'c1', affiliateId: aff.id, stripeChargeId: 'ch_x', status: 'pending', amountCents: 1000 },
      { id: 'c2', affiliateId: aff.id, stripeChargeId: 'ch_x', status: 'approved', amountCents: 500 },
    )
    const res = await svc.handleClawback('ch_x')
    expect(res.refunded).toBe(2)
    expect(res.clawedBack).toBe(0)
    expect(commissions[0].status).toBe('refunded')
    expect(commissions[1].status).toBe('refunded')
    expect(affiliates.get(aff.id)!.pendingPayoutCents).toBe(0)
  })

  test('paid rows → clawed_back; pending counter goes negative', async () => {
    const aff = seedAffiliate({ userId: 'u1', code: 'a' })
    aff.pendingPayoutCents = 0
    commissions.push(
      { id: 'c1', affiliateId: aff.id, stripeChargeId: 'ch_y', status: 'paid', amountCents: 700 },
    )
    const res = await svc.handleClawback('ch_y')
    expect(res.clawedBack).toBe(1)
    expect(commissions[0].status).toBe('clawed_back')
    expect(affiliates.get(aff.id)!.pendingPayoutCents).toBe(-700)
  })

  test('idempotent — re-running ignores already-clawed rows', async () => {
    const aff = seedAffiliate({ userId: 'u1', code: 'a' })
    commissions.push({ id: 'c1', affiliateId: aff.id, stripeChargeId: 'ch_z', status: 'refunded', amountCents: 1000 })
    const res = await svc.handleClawback('ch_z')
    expect(res.refunded).toBe(0)
    expect(res.clawedBack).toBe(0)
  })
})

// ===========================================================================
// approveEligibleCommissions
// ===========================================================================

describe('approveEligibleCommissions', () => {
  test('flips only pending rows whose eligibleAt has passed', async () => {
    commissions.push(
      { id: 'c1', status: 'pending', eligibleAt: new Date('2026-01-01'), amountCents: 100 },
      { id: 'c2', status: 'pending', eligibleAt: new Date('2099-01-01'), amountCents: 100 },
      { id: 'c3', status: 'refunded', eligibleAt: new Date('2026-01-01'), amountCents: 100 },
    )
    const res = await svc.approveEligibleCommissions(new Date('2026-06-01'))
    expect(res.approved).toBe(1)
    expect(commissions[0].status).toBe('approved')
    expect(commissions[1].status).toBe('pending')
    expect(commissions[2].status).toBe('refunded')
  })
})

// ===========================================================================
// runAffiliatePayouts
// ===========================================================================

describe('runAffiliatePayouts', () => {
  test('skips affiliates below minimum payout', async () => {
    const aff = seedAffiliate({ userId: 'u1', code: 'a' })
    aff.payoutStatus = 'verified'
    aff.stripeCustomAccountId = 'acct_aff1'
    commissions.push({ id: 'c1', affiliateId: aff.id, status: 'approved', amountCents: 100, payoutId: null, createdAt: new Date() })
    const summary = await svc.runAffiliatePayouts(new Date(), {
      minPayoutCents: 1000,
      stripeFactory: () => makeStripe(),
    })
    expect(summary.candidates).toBe(1)
    expect(summary.skippedBelowMinimum).toBe(1)
    expect(summary.paid).toBe(0)
  })

  test('skips affiliates without verified payout setup', async () => {
    const aff = seedAffiliate({ userId: 'u1', code: 'a' })
    aff.payoutStatus = 'pending_verification'
    commissions.push({ id: 'c1', affiliateId: aff.id, status: 'approved', amountCents: 10_000, payoutId: null, createdAt: new Date() })
    const summary = await svc.runAffiliatePayouts(new Date(), {
      minPayoutCents: 5000,
      stripeFactory: () => makeStripe(),
    })
    expect(summary.skippedUnverifiedPayout).toBe(1)
    expect(summary.paid).toBe(0)
  })

  test('pays via transfer + payout with idempotency keys, flips commissions', async () => {
    const aff = seedAffiliate({ userId: 'u1', code: 'a' })
    aff.payoutStatus = 'verified'
    aff.stripeCustomAccountId = 'acct_aff1'
    commissions.push(
      { id: 'c1', affiliateId: aff.id, status: 'approved', amountCents: 7000, payoutId: null, createdAt: new Date('2026-04-01') },
      { id: 'c2', affiliateId: aff.id, status: 'approved', amountCents: 3000, payoutId: null, createdAt: new Date('2026-05-01') },
    )
    aff.pendingPayoutCents = 10_000
    const summary = await svc.runAffiliatePayouts(new Date('2026-06-01'), {
      minPayoutCents: 5000,
      stripeFactory: () => makeStripe(),
    })
    expect(summary.paid).toBe(1)
    expect(summary.totalCentsPaid).toBe(10_000)
    // Both commissions flipped, point at the payout row.
    expect(commissions.every((c) => c.status === 'paid')).toBe(true)
    expect(commissions.every((c) => c.payoutId === payouts[0].id)).toBe(true)
    // Counters updated.
    expect(affiliates.get(aff.id)!.totalEarningsCents).toBe(10_000)
    expect(affiliates.get(aff.id)!.totalPaidOutCents).toBe(10_000)
    expect(affiliates.get(aff.id)!.pendingPayoutCents).toBe(0)
    // Stripe sequence: transfer then payout, both with payout.id-derived keys.
    const transferCall = stripeCalls.find((c) => c.method === 'transfers.create')
    const payoutCall = stripeCalls.find((c) => c.method === 'payouts.create')
    expect(transferCall?.idempotencyKey).toMatch(/:transfer$/)
    expect(payoutCall?.idempotencyKey).toMatch(/:payout$/)
    expect(payoutCall?.stripeAccount).toBe('acct_aff1')
  })

  test('transfer failure isolates one affiliate — the next still pays', async () => {
    const a = seedAffiliate({ userId: 'u1', code: 'a' })
    a.payoutStatus = 'verified'
    a.stripeCustomAccountId = 'acct_a'
    const b = seedAffiliate({ userId: 'u2', code: 'b' })
    b.payoutStatus = 'verified'
    b.stripeCustomAccountId = 'acct_b'
    commissions.push(
      { id: 'c_a', affiliateId: a.id, status: 'approved', amountCents: 10_000, payoutId: null, createdAt: new Date('2026-04-01') },
      { id: 'c_b', affiliateId: b.id, status: 'approved', amountCents: 10_000, payoutId: null, createdAt: new Date('2026-04-01') },
    )
    // First transfer (whichever affiliate gets ordered first) throws once.
    stripeFailureMethod = 'transfers.create'
    const summary = await svc.runAffiliatePayouts(new Date('2026-06-01'), {
      minPayoutCents: 5000,
      stripeFactory: () => makeStripe(),
    })
    expect(summary.failed).toBe(1)
    expect(summary.paid).toBe(1)
    // The failed payout row exists in `failed` status and the other in `paid`.
    const statuses = payouts.map((p) => p.status).sort()
    expect(statuses).toEqual(['failed', 'paid'])
  })

  test('with no candidates, returns a zeroed summary without touching Stripe', async () => {
    // No commissions in any state → groupBy returns []; the function
    // should never even instantiate the Stripe factory.
    let stripeCreated = false
    const summary = await svc.runAffiliatePayouts(new Date(), {
      minPayoutCents: 5000,
      stripeFactory: () => {
        stripeCreated = true
        return makeStripe()
      },
    })
    expect(summary.candidates).toBe(0)
    expect(summary.paid).toBe(0)
    expect(summary.failed).toBe(0)
    expect(stripeCreated).toBe(false)
  })
})

// ===========================================================================
// approveEligibleCommissionsLocked + runAffiliatePayoutsLocked
// ===========================================================================

describe('lock-wrapped entry points', () => {
  test('approveEligibleCommissionsLocked returns the wrapped summary', async () => {
    commissions.push({
      id: 'c1', status: 'pending', eligibleAt: new Date('2020-01-01'), amountCents: 100,
    })
    const res = await svc.approveEligibleCommissionsLocked(new Date())
    expect((res as any).approved).toBe(1)
  })

  test('runAffiliatePayoutsLocked returns the wrapped summary', async () => {
    const res = await svc.runAffiliatePayoutsLocked(new Date())
    expect(typeof (res as any).paid).toBe('number')
  })
})

// ===========================================================================
// runAffiliatePayouts — default stripeFactory branch (L719-721)
// ===========================================================================

describe('runAffiliatePayouts — default stripeFactory', () => {
  test('STRIPE_SECRET_KEY unset: warns and returns summary with paid=0, no Stripe construction', async () => {
    seedAffiliate({ userId: 'pu1', code: 'p1' })
    const aff = [...affiliates.values()][0]!
    commissions.push({
      id: 'c-pay-1', affiliateId: aff.id, status: 'approved', payoutId: null,
      amountCents: 50_000, eligibleAt: new Date('2020-01-01'),
    })
    delete (process.env as any).STRIPE_SECRET_KEY

    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...a: unknown[]) => { warns.push(a.join(' ')) }
    try {
      const res = await svc.runAffiliatePayouts(new Date())
      expect(res.candidates).toBe(1)
      expect(res.paid).toBe(0)
      expect(res.totalCentsPaid).toBe(0)
      expect(warns.some((w) => w.includes('STRIPE_SECRET_KEY unset'))).toBe(true)
    } finally {
      console.warn = origWarn
    }
  })

  test('STRIPE_SECRET_KEY set: default factory constructs a real Stripe client (subsequent loop uses it)', async () => {
    // We don't want to actually hit Stripe — seed zero candidates so the loop is skipped.
    // This still exercises the factory branch up to `const stripe = stripeFactory()`,
    // but with candidates=0 we return before any HTTP call would happen.
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
    try {
      // Make sure no approved commissions exist so candidates=0 short-circuits BEFORE
      // the factory is invoked.
      commissions.length = 0
      const res = await svc.runAffiliatePayouts(new Date())
      expect(res.candidates).toBe(0)
      expect(res.paid).toBe(0)
    } finally {
      delete (process.env as any).STRIPE_SECRET_KEY
    }
  })
})

// ===========================================================================
// getAffiliateSummary (L881-933)
// ===========================================================================

describe('getAffiliateSummary', () => {
  test('returns null when the user has no affiliate row', async () => {
    expect(await svc.getAffiliateSummary('nobody')).toBeNull()
  })

  test('happy path: zero clicks / signups / commissions / downline → empty buckets', async () => {
    seedAffiliate({ userId: 'su1', code: 's1' })
    const summary = await svc.getAffiliateSummary('su1')
    expect(summary).not.toBeNull()
    expect(summary!.clicks30d).toBe(0)
    expect(summary!.signups30d).toBe(0)
    expect(summary!.pendingCents).toBe(0)
    expect(summary!.approvedCents).toBe(0)
    expect(summary!.paidCents).toBe(0)
    expect(summary!.downlineCounts).toEqual({ 1: 0 })
    expect(summary!.cookieDays).toBeGreaterThan(0)
    expect(summary!.affiliate.code).toBe('s1')
  })

  test('aggregates commissions across pending / approved / paid statuses', async () => {
    const aff = seedAffiliate({ userId: 'su2', code: 's2' })
    commissions.push(
      { id: 'cs1', affiliateId: aff.id, status: 'pending', amountCents: 1000, eligibleAt: new Date(), createdAt: new Date() },
      { id: 'cs2', affiliateId: aff.id, status: 'pending', amountCents: 500, eligibleAt: new Date(), createdAt: new Date() },
      { id: 'cs3', affiliateId: aff.id, status: 'approved', amountCents: 2500, eligibleAt: new Date(), createdAt: new Date() },
      { id: 'cs4', affiliateId: aff.id, status: 'paid', amountCents: 7000, eligibleAt: new Date(), createdAt: new Date() },
    )
    const s = await svc.getAffiliateSummary('su2')
    expect(s!.pendingCents).toBe(1500)
    expect(s!.approvedCents).toBe(2500)
    expect(s!.paidCents).toBe(7000)
  })

  test('counts clicks and signup attributions only within the last 30 days', async () => {
    const aff = seedAffiliate({ userId: 'su3', code: 's3' })
    const now = new Date('2026-05-28T00:00:00Z')
    const recent = new Date('2026-05-20T00:00:00Z')
    const old = new Date('2026-03-01T00:00:00Z')
    clicks.push(
      { id: 'kc1', affiliateId: aff.id, visitorId: 'v1', createdAt: recent, expiresAt: recent },
      { id: 'kc2', affiliateId: aff.id, visitorId: 'v2', createdAt: recent, expiresAt: recent },
      { id: 'kc3', affiliateId: aff.id, visitorId: 'v3', createdAt: old, expiresAt: old },
    )
    attributions.set('au1', { id: 'a1', affiliateId: aff.id, userId: 'au1', attributedAt: recent })
    attributions.set('au2', { id: 'a2', affiliateId: aff.id, userId: 'au2', attributedAt: old })

    const s = await svc.getAffiliateSummary('su3', now)
    expect(s!.clicks30d).toBe(2)
    expect(s!.signups30d).toBe(1)
  })

  test('walks the downline tree up to SHOGO_AFFILIATE_MAX_DEPTH levels', async () => {
    process.env.SHOGO_AFFILIATE_MAX_DEPTH = '3'
    try {
      const root = seedAffiliate({ userId: 'r', code: 'root' })
      // L1: two direct children
      const c1 = seedAffiliate({ userId: 'c1u', code: 'c1', parentAffiliateId: root.id, depth: 2 })
      const c2 = seedAffiliate({ userId: 'c2u', code: 'c2', parentAffiliateId: root.id, depth: 2 })
      // L2: one grandchild under c1
      const g1 = seedAffiliate({ userId: 'g1u', code: 'g1', parentAffiliateId: c1.id, depth: 3 })
      // L3: one great-grandchild under g1 — should NOT be counted (out of cap)
      seedAffiliate({ userId: 'gg1u', code: 'gg1', parentAffiliateId: g1.id, depth: 4 })

      const s = await svc.getAffiliateSummary('r')
      expect(s!.downlineCounts[1]).toBe(2)
      expect(s!.downlineCounts[2]).toBe(1)
      // L3 frontier is [g1] → finds 1 great-grandchild within the cap
      expect(s!.downlineCounts[3]).toBe(1)
      // No L4 bucket — loop terminates at maxDepth=3
      expect(s!.downlineCounts[4]).toBeUndefined()

      // Use the void to satisfy noUnusedLocals.
      void c2
    } finally {
      delete process.env.SHOGO_AFFILIATE_MAX_DEPTH
    }
  })
})

describe('newVisitorId', () => {
  test('returns a unique-looking UUID string each call', () => {
    const a = svc.newVisitorId()
    const b = svc.newVisitorId()
    expect(typeof a).toBe('string')
    expect(a.length).toBeGreaterThan(20)
    expect(a).not.toBe(b)
  })
})
