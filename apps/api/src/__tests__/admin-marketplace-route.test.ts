// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/routes/admin-marketplace.ts` — super-admin marketplace ops.
 *
 * Covers all 7 endpoints + helpers:
 *   GET    /payouts/pending       — joins stripe balance, handles Stripe errors
 *   POST   /payouts/release       — body validation, per-creator branches:
 *                                    not-found / no-stripe-account / balance-fetch
 *                                    fail / zero / over-balance / payout throws /
 *                                    ledger update throws / happy path
 *   POST   /payouts/hold          — body validation, 404 when no rows updated
 *   GET    /payouts/history       — pagination clamping, optional creatorId filter
 *   GET    /listings              — pagination + status filter (allowlist)
 *   PATCH  /listings/:id/status   — admin status allowlist, 404 on update miss
 *   POST   /listings/:id/feature  — featuredAt parsing (string/null/omitted/bad)
 *
 * Middleware (`requireSuperAdmin`) is stubbed pass-through; Prisma and
 * stripe-connect.service are replaced with in-memory stubs.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

// ─── Middleware mocks ─────────────────────────────────────────────────

mock.module('../middleware/auth', () => ({
  authMiddleware: async (_c: any, next: any) => next(),
  requireAuth: async (_c: any, next: any) => next(),
}))
mock.module('../middleware/super-admin', () => ({
  requireSuperAdmin: async (_c: any, next: any) => next(),
}))

// ─── stripe-connect.service mock ──────────────────────────────────────

const stripeSpies = {
  getAccountBalance: mock(async (_: string): Promise<number> => 0),
  triggerPayout: mock(async (_creatorId: string, _amount?: number): Promise<string> => 'po_default'),
}
mock.module('../services/stripe-connect.service', () => stripeSpies)

// ─── Prisma mock ──────────────────────────────────────────────────────

let creators: Map<string, any>
let listings: any[]
let txns: any[]
let txnCreateThrow: Error | null = null
let updateThrow: Error | null = null

function resetState() {
  creators = new Map()
  listings = []
  txns = []
  txnCreateThrow = null
  updateThrow = null
  stripeSpies.getAccountBalance.mockClear()
  stripeSpies.triggerPayout.mockClear()
  stripeSpies.getAccountBalance.mockImplementation(async () => 0)
  stripeSpies.triggerPayout.mockImplementation(async () => 'po_default')
}
resetState()

const creatorProfileTable = {
  findMany: async (args: any) => {
    let rows = Array.from(creators.values())
    if (args.where?.pendingPayoutInCents?.gt !== undefined) {
      rows = rows.filter((c) => c.pendingPayoutInCents > args.where.pendingPayoutInCents.gt)
    }
    if (args.orderBy?.pendingPayoutInCents === 'desc') {
      rows.sort((a, b) => b.pendingPayoutInCents - a.pendingPayoutInCents)
    }
    if (args.include?.user) {
      rows = rows.map((c) => ({ ...c, user: { email: c.email ?? null } }))
    }
    return rows
  },
  findUnique: async (args: any) => creators.get(args.where.id) ?? null,
  update: async (args: any) => {
    const c = creators.get(args.where.id)
    if (!c) throw new Error('not found')
    Object.assign(c, args.data)
    return c
  },
  updateMany: async (args: any) => {
    const c = creators.get(args.where.id)
    if (!c) return { count: 0 }
    Object.assign(c, args.data)
    return { count: 1 }
  },
}

const listingTable = {
  findFirst: async (args: any) => {
    return listings
      .filter((l) => !args.where?.creatorId || l.creatorId === args.where.creatorId)
      .sort((a, b) =>
        args.orderBy?.createdAt === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt,
      )[0] ?? null
  },
  findMany: async (args: any) => {
    let rows = listings.slice()
    if (args.where?.status) rows = rows.filter((l) => l.status === args.where.status)
    if (args.orderBy?.updatedAt === 'desc') {
      rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    }
    if (args.skip) rows = rows.slice(args.skip)
    if (args.take) rows = rows.slice(0, args.take)
    return rows
  },
  count: async (args: any) =>
    listings.filter((l) => !args.where?.status || l.status === args.where.status).length,
  update: async (args: any) => {
    if (updateThrow) throw updateThrow
    const l = listings.find((row) => row.id === args.where.id)
    if (!l) throw new Error('listing not found')
    Object.assign(l, args.data)
    return l
  },
}

const txnTable = {
  create: async (args: any) => {
    if (txnCreateThrow) throw txnCreateThrow
    const row = { id: `tx_${txns.length + 1}`, createdAt: new Date(), ...args.data }
    txns.push(row)
    return row
  },
  findMany: async (args: any) => {
    let rows = txns.filter((t) => !args.where?.creatorId || t.creatorId === args.where.creatorId)
    rows.sort((a, b) => b.createdAt - a.createdAt)
    if (args.skip) rows = rows.slice(args.skip)
    if (args.take) rows = rows.slice(0, args.take)
    return rows
  },
  count: async (args: any) =>
    txns.filter((t) => !args.where?.creatorId || t.creatorId === args.where.creatorId).length,
}

mock.module('../lib/prisma', () => ({
  prisma: {
    creatorProfile: creatorProfileTable,
    marketplaceListing: listingTable,
    marketplaceTransaction: txnTable,
    $transaction: async (fn: any) => fn({
      creatorProfile: creatorProfileTable,
      marketplaceTransaction: txnTable,
    }),
  },
}))

const { adminMarketplaceRoutes } = await import('../routes/admin-marketplace')

// ─── helpers ──────────────────────────────────────────────────────────

function makeApp() {
  return adminMarketplaceRoutes()
}
async function call(method: string, path: string, body?: any) {
  const init: any = { method }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  const res = await makeApp().fetch(new Request(`http://test${path}`, init))
  const json = await res.json().catch(() => ({}))
  return { status: res.status, body: json }
}

function seedCreator(id: string, over: any = {}) {
  creators.set(id, {
    id,
    userId: `u_${id}`,
    displayName: `D-${id}`,
    email: `${id}@x.y`,
    pendingPayoutInCents: 0,
    totalPaidOutInCents: 0,
    stripeCustomAccountId: 'acct_x',
    payoutStatus: 'verified',
    ...over,
  })
}

beforeEach(() => resetState())

// ──────────────────────────────────────────────────────────────────────
// GET /payouts/pending
// ──────────────────────────────────────────────────────────────────────

describe('GET /payouts/pending', () => {
  test('returns rows with stripeBalance from service', async () => {
    seedCreator('c1', { pendingPayoutInCents: 1000, stripeCustomAccountId: 'acct_1' })
    seedCreator('c2', { pendingPayoutInCents: 500,  stripeCustomAccountId: 'acct_2' })
    stripeSpies.getAccountBalance.mockImplementation(async (acct) =>
      acct === 'acct_1' ? 2000 : 750,
    )
    const res = await call('GET', '/payouts/pending')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.data[0].creatorId).toBe('c1') // higher pending first
    expect(res.body.data[0].stripeBalance).toBe(2000)
    expect(res.body.data[1].stripeBalance).toBe(750)
  })

  test('Stripe balance fetch throw → stripeBalance=null', async () => {
    seedCreator('c1', { pendingPayoutInCents: 1000 })
    stripeSpies.getAccountBalance.mockImplementation(async () => {
      throw new Error('stripe down')
    })
    const res = await call('GET', '/payouts/pending')
    expect(res.body.data[0].stripeBalance).toBeNull()
  })

  test('creator without stripe account → stripeBalance=null, no service call', async () => {
    seedCreator('c1', { pendingPayoutInCents: 1000, stripeCustomAccountId: null })
    const res = await call('GET', '/payouts/pending')
    expect(res.body.data[0].stripeBalance).toBeNull()
    expect(stripeSpies.getAccountBalance).not.toHaveBeenCalled()
  })

  test('only creators with pendingPayoutInCents > 0 are returned', async () => {
    seedCreator('c1', { pendingPayoutInCents: 0 })
    seedCreator('c2', { pendingPayoutInCents: 100 })
    const res = await call('GET', '/payouts/pending')
    expect(res.body.data.map((r: any) => r.creatorId)).toEqual(['c2'])
  })
})

// ──────────────────────────────────────────────────────────────────────
// POST /payouts/release
// ──────────────────────────────────────────────────────────────────────

describe('POST /payouts/release — body validation', () => {
  test('400 invalid_json on malformed body', async () => {
    const res = await call('POST', '/payouts/release', 'not-json')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_json')
  })

  test('400 when creatorIds is not an array', async () => {
    const res = await call('POST', '/payouts/release', { creatorIds: 'c1' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_body')
  })

  test('400 when any creatorIds element is not a string', async () => {
    const res = await call('POST', '/payouts/release', { creatorIds: ['c1', 7] })
    expect(res.status).toBe(400)
  })

  test('400 when amountInCents is non-number', async () => {
    const res = await call('POST', '/payouts/release', {
      creatorIds: ['c1'],
      amountInCents: 'lots',
    })
    expect(res.status).toBe(400)
  })

  test('400 when amountInCents is non-positive', async () => {
    const res = await call('POST', '/payouts/release', {
      creatorIds: ['c1'],
      amountInCents: 0,
    })
    expect(res.status).toBe(400)
  })

  test('400 when amountInCents is negative', async () => {
    const res = await call('POST', '/payouts/release', {
      creatorIds: ['c1'],
      amountInCents: -50,
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /payouts/release — per-creator branches', () => {
  test('Creator not found → record error in results', async () => {
    const res = await call('POST', '/payouts/release', { creatorIds: ['ghost'] })
    expect(res.status).toBe(200)
    expect(res.body.data.results[0]).toEqual({
      creatorId: 'ghost',
      success: false,
      error: 'Creator not found',
    })
  })

  test('No Stripe account → recorded error', async () => {
    seedCreator('c1', { stripeCustomAccountId: null })
    const res = await call('POST', '/payouts/release', { creatorIds: ['c1'] })
    expect(res.body.data.results[0]).toEqual({
      creatorId: 'c1',
      success: false,
      error: 'Creator has no Stripe Connect account',
    })
  })

  test('Stripe balance throws → recorded error', async () => {
    seedCreator('c1')
    stripeSpies.getAccountBalance.mockImplementation(async () => {
      throw new Error('stripe boom')
    })
    const res = await call('POST', '/payouts/release', { creatorIds: ['c1'] })
    expect(res.body.data.results[0].success).toBe(false)
    expect(res.body.data.results[0].error).toBe('stripe boom')
  })

  test('Zero available + no override → "No amount available"', async () => {
    seedCreator('c1')
    stripeSpies.getAccountBalance.mockImplementation(async () => 0)
    const res = await call('POST', '/payouts/release', { creatorIds: ['c1'] })
    expect(res.body.data.results[0].error).toBe('No amount available to payout')
  })

  test('Override > available → "Requested payout exceeds available balance"', async () => {
    seedCreator('c1')
    stripeSpies.getAccountBalance.mockImplementation(async () => 500)
    const res = await call('POST', '/payouts/release', {
      creatorIds: ['c1'],
      amountInCents: 1000,
    })
    expect(res.body.data.results[0].error).toContain('exceeds available balance')
  })

  test('Stripe payout throws → recorded error', async () => {
    seedCreator('c1')
    stripeSpies.getAccountBalance.mockImplementation(async () => 1000)
    stripeSpies.triggerPayout.mockImplementation(async () => {
      throw new Error('declined')
    })
    const res = await call('POST', '/payouts/release', { creatorIds: ['c1'] })
    expect(res.body.data.results[0]).toMatchObject({
      creatorId: 'c1', success: false, error: 'declined',
    })
  })

  test('Ledger transaction throws → recorded error, no successful entry', async () => {
    seedCreator('c1', { pendingPayoutInCents: 1000 })
    listings.push({ id: 'l1', creatorId: 'c1', createdAt: 1 })
    stripeSpies.getAccountBalance.mockImplementation(async () => 1000)
    stripeSpies.triggerPayout.mockImplementation(async () => 'po_x')
    txnCreateThrow = new Error('db down')
    const res = await call('POST', '/payouts/release', { creatorIds: ['c1'] })
    expect(res.body.data.results[0]).toMatchObject({ success: false, error: 'db down' })
  })

  test('Happy path: updates ledger + creates transaction with anchor listing', async () => {
    seedCreator('c1', { pendingPayoutInCents: 1500, totalPaidOutInCents: 200 })
    listings.push({ id: 'l1', creatorId: 'c1', createdAt: 1 })
    stripeSpies.getAccountBalance.mockImplementation(async () => 2000)
    stripeSpies.triggerPayout.mockImplementation(async (_, a) => `po_${a ?? 'auto'}`)
    const res = await call('POST', '/payouts/release', { creatorIds: ['c1'] })
    expect(res.body.data.results[0]).toEqual({
      creatorId: 'c1',
      success: true,
      payoutId: 'po_auto',
      amountInCents: 2000,
    })
    expect(creators.get('c1')!.pendingPayoutInCents).toBe(0)
    expect(creators.get('c1')!.totalPaidOutInCents).toBe(2200)
    expect(txns).toHaveLength(1)
    expect(txns[0].listingId).toBe('l1')
    expect(txns[0].type).toBe('refund')
  })

  test('Happy path with override: triggerPayout called with explicit amount', async () => {
    seedCreator('c1', { pendingPayoutInCents: 500 })
    listings.push({ id: 'l1', creatorId: 'c1', createdAt: 1 })
    stripeSpies.getAccountBalance.mockImplementation(async () => 1000)
    const res = await call('POST', '/payouts/release', {
      creatorIds: ['c1'],
      amountInCents: 300,
    })
    expect(stripeSpies.triggerPayout).toHaveBeenCalledWith('c1', 300)
    expect(res.body.data.results[0].amountInCents).toBe(300)
    expect(creators.get('c1')!.pendingPayoutInCents).toBe(200)
  })

  test('Happy path with no listings: skips transaction creation', async () => {
    seedCreator('c1', { pendingPayoutInCents: 1000 })
    stripeSpies.getAccountBalance.mockImplementation(async () => 1000)
    const res = await call('POST', '/payouts/release', { creatorIds: ['c1'] })
    expect(res.body.data.results[0].success).toBe(true)
    expect(txns).toHaveLength(0)
  })
})

// ──────────────────────────────────────────────────────────────────────
// POST /payouts/hold
// ──────────────────────────────────────────────────────────────────────

describe('POST /payouts/hold', () => {
  test('400 on bad JSON', async () => {
    const res = await call('POST', '/payouts/hold', 'nope')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_json')
  })

  test('400 when creatorId missing', async () => {
    const res = await call('POST', '/payouts/hold', { reason: 'fraud' })
    expect(res.status).toBe(400)
  })

  test('400 when reason missing / whitespace', async () => {
    const res = await call('POST', '/payouts/hold', { creatorId: 'c1', reason: '   ' })
    expect(res.status).toBe(400)
  })

  test('404 when no rows updated', async () => {
    const res = await call('POST', '/payouts/hold', { creatorId: 'c_ghost', reason: 'r' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  test('200 + sets payoutStatus=disabled', async () => {
    seedCreator('c1', { payoutStatus: 'verified' })
    const res = await call('POST', '/payouts/hold', { creatorId: 'c1', reason: 'fraud' })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ creatorId: 'c1', reason: 'fraud' })
    expect(creators.get('c1')!.payoutStatus).toBe('disabled')
  })
})

// ──────────────────────────────────────────────────────────────────────
// GET /payouts/history
// ──────────────────────────────────────────────────────────────────────

describe('GET /payouts/history', () => {
  beforeEach(() => {
    for (let i = 0; i < 30; i++) {
      txns.push({
        id: `t${i}`, createdAt: i,
        creatorId: i < 10 ? 'c1' : 'c2',
        type: 'refund', amountInCents: 100,
      })
    }
  })

  test('default page=1, limit=20, sorted desc', async () => {
    const res = await call('GET', '/payouts/history')
    expect(res.status).toBe(200)
    expect(res.body.data.page).toBe(1)
    expect(res.body.data.limit).toBe(20)
    expect(res.body.data.total).toBe(30)
    expect(res.body.data.items).toHaveLength(20)
    expect(res.body.data.totalPages).toBe(2)
    expect(res.body.data.items[0].id).toBe('t29')
  })

  test('creatorId filter restricts to that creator', async () => {
    const res = await call('GET', '/payouts/history?creatorId=c1')
    expect(res.body.data.total).toBe(10)
    expect(res.body.data.items.every((i: any) => i.creatorId === 'c1')).toBe(true)
  })

  test('clamps page<1 → 1, limit>100 → 100', async () => {
    const res = await call('GET', '/payouts/history?page=0&limit=500')
    expect(res.body.data.page).toBe(1)
    expect(res.body.data.limit).toBe(100)
  })

  test('totalPages is 1 when total=0', async () => {
    txns.length = 0
    const res = await call('GET', '/payouts/history')
    expect(res.body.data.totalPages).toBe(1)
  })

  test('blank creatorId is treated as undefined', async () => {
    const res = await call('GET', '/payouts/history?creatorId=%20%20')
    expect(res.body.data.total).toBe(30)
  })
})

// ──────────────────────────────────────────────────────────────────────
// GET /listings
// ──────────────────────────────────────────────────────────────────────

describe('GET /listings', () => {
  beforeEach(() => {
    for (let i = 0; i < 12; i++) {
      listings.push({
        id: `l${i}`,
        creatorId: 'c1',
        status: i < 4 ? 'published' : i < 8 ? 'draft' : 'suspended',
        updatedAt: i,
      })
    }
  })

  test('defaults page=1, limit=20', async () => {
    const res = await call('GET', '/listings')
    expect(res.status).toBe(200)
    expect(res.body.data.items).toHaveLength(12)
    expect(res.body.data.page).toBe(1)
  })

  test('valid status filter is applied', async () => {
    const res = await call('GET', '/listings?status=published')
    expect(res.body.data.items.every((l: any) => l.status === 'published')).toBe(true)
    expect(res.body.data.total).toBe(4)
  })

  test('unknown status is ignored (no filter applied)', async () => {
    const res = await call('GET', '/listings?status=nonsense')
    expect(res.body.data.total).toBe(12)
  })

  test('pagination clamping', async () => {
    const res = await call('GET', '/listings?page=-1&limit=5')
    expect(res.body.data.page).toBe(1)
    expect(res.body.data.limit).toBe(5)
    expect(res.body.data.items).toHaveLength(5)
  })
})

// ──────────────────────────────────────────────────────────────────────
// PATCH /listings/:id/status
// ──────────────────────────────────────────────────────────────────────

describe('PATCH /listings/:id/status', () => {
  test('400 invalid_json', async () => {
    const res = await call('PATCH', '/listings/l1/status', 'nope')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_json')
  })

  test.each(['draft', 'in_review', 'pending', 'lol'])(
    '400 when status=%s is not in admin allowlist',
    async (status) => {
      const res = await call('PATCH', '/listings/l1/status', { status })
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('invalid_body')
    },
  )

  test.each(['published', 'suspended', 'archived'])(
    '200 + updates status when status=%s',
    async (status) => {
      listings.push({ id: 'l1', status: 'draft', updatedAt: 1 })
      const res = await call('PATCH', '/listings/l1/status', { status })
      expect(res.status).toBe(200)
      expect(res.body.data.status).toBe(status)
    },
  )

  test('404 when listing does not exist', async () => {
    const res = await call('PATCH', '/listings/missing/status', { status: 'published' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})

// ──────────────────────────────────────────────────────────────────────
// POST /listings/:id/feature
// ──────────────────────────────────────────────────────────────────────

describe('POST /listings/:id/feature', () => {
  beforeEach(() => {
    listings.push({ id: 'l1', status: 'published', updatedAt: 1, featuredAt: null })
  })

  test('omitted body → featuredAt=now', async () => {
    const res = await call('POST', '/listings/l1/feature')
    expect(res.status).toBe(200)
    expect(res.body.data.featuredAt).toBeTruthy()
  })

  test('featuredAt=null → clears feature flag', async () => {
    listings[0].featuredAt = new Date()
    const res = await call('POST', '/listings/l1/feature', { featuredAt: null })
    expect(res.status).toBe(200)
    expect(res.body.data.featuredAt).toBeNull()
  })

  test('valid ISO date string is accepted', async () => {
    const iso = '2026-06-01T00:00:00Z'
    const res = await call('POST', '/listings/l1/feature', { featuredAt: iso })
    expect(res.status).toBe(200)
    // The Date is normalized on the way back through JSON; compare timestamps
    // rather than canonical-form strings.
    expect(new Date(res.body.data.featuredAt).getTime()).toBe(new Date(iso).getTime())
  })

  test('400 on invalid date string', async () => {
    const res = await call('POST', '/listings/l1/feature', { featuredAt: 'not-a-date' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_body')
  })

  test('400 on non-string non-null featuredAt', async () => {
    const res = await call('POST', '/listings/l1/feature', { featuredAt: 123 })
    expect(res.status).toBe(400)
  })

  test('404 when listing does not exist', async () => {
    listings.length = 0
    const res = await call('POST', '/listings/missing/feature')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})
