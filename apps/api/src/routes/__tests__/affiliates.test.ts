// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for affiliate HTTP routes (apps/api/src/routes/affiliates.ts).
 *
 * IMPORTANT: We deliberately avoid `mock.module(.../affiliate.service)`
 * here because bun's `mock.module` is process-global and would poison
 * apps/api/src/services/__tests__/affiliate.service.test.ts. Instead
 * we mock prisma + stripe at the boundary and let the REAL affiliate
 * service run through — the resulting test exercises both the route
 * layer's wiring and the service layer's contract for free.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from '../../__tests__/helpers/prisma-mock-exports'

// ---- mock middleware: inject userId from x-test-user-id header --------
mock.module('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    const userId = c.req.header('x-test-user-id')
    if (userId) c.set('auth', { userId, isAuthenticated: true })
    else c.set('auth', { isAuthenticated: false })
    await next()
  },
  requireAuth: async (c: any, next: any) => {
    const a = c.get('auth')
    if (!a?.userId) return c.json({ ok: false, error: { code: 'unauthorized' } }, 401)
    await next()
  },
}))

// ---- mock stripe-connect (only the affiliate helpers we route to) ----
mock.module('../../services/stripe-connect.service', () => ({
  createCustomAccountForAffiliate: async (affId: string) => `acct_${affId}`,
  submitPayoutDetailsForAffiliate: async () => ({ payoutStatus: 'pending_verification' }),
  // Re-export every other stripe-connect symbol as undefined so this
  // mock doesn't claim to provide things it doesn't; bun will only
  // intercept the names we declare here, leaving real consumers alone.
}))

// ---- mock prisma -------------------------------------------------------
type AnyRow = Record<string, any>
const affiliateRows = new Map<string, AnyRow>()
const attributionRows = new Map<string, AnyRow>()
const commissions: AnyRow[] = []
const payouts: AnyRow[] = []
const clicks: AnyRow[] = []
const users = new Map<string, AnyRow>()
const tiers: AnyRow[] = []

function affiliateFindUnique({ where }: any): AnyRow | null {
  if (where.userId) {
    for (const a of affiliateRows.values()) if (a.userId === where.userId) return a
    return null
  }
  if (where.code) {
    for (const a of affiliateRows.values()) if (a.code === where.code) return a
    return null
  }
  if (where.id) return affiliateRows.get(where.id) ?? null
  return null
}

const prismaStub = {
  user: {
    findUnique: async ({ where }: any) => users.get(where.id) ?? null,
  },
  affiliate: {
    findUnique: async (args: any) => affiliateFindUnique(args),
    findFirst: async ({ where }: any) => {
      for (const a of affiliateRows.values()) {
        if (where?.code && a.code !== where.code) continue
        return a
      }
      return null
    },
    findMany: async ({ where }: any) => {
      const out: AnyRow[] = []
      const parents = Array.isArray(where?.parentAffiliateId?.in)
        ? where.parentAffiliateId.in
        : where?.parentAffiliateId
          ? [where.parentAffiliateId]
          : []
      for (const a of affiliateRows.values()) {
        if (parents.length && parents.includes(a.parentAffiliateId)) out.push(a)
      }
      return out.map((a) => ({
        id: a.id, code: a.code, depth: a.depth, createdAt: a.createdAt,
        parentAffiliateId: a.parentAffiliateId,
        user: { name: `User ${a.userId.slice(-2)}` },
      }))
    },
    create: async ({ data }: any) => {
      const id = `aff_${affiliateRows.size + 1}`
      const row = { id, createdAt: new Date(), depth: 0, ...data }
      affiliateRows.set(id, row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = affiliateRows.get(where.id) ?? affiliateFindUnique({ where })
      if (!row) throw new Error('affiliate not found')
      Object.assign(row, data)
      affiliateRows.set(row.id, row)
      return row
    },
  },
  affiliateAttribution: {
    findUnique: async ({ where }: any) => attributionRows.get(where.userId) ?? null,
    create: async ({ data }: any) => { attributionRows.set(data.userId, { ...data, id: `attr_${attributionRows.size + 1}` }); return attributionRows.get(data.userId) },
    count: async () => 0,
  },
  affiliateClick: {
    create: async ({ data }: any) => { const row = { id: `click_${clicks.length + 1}`, ...data }; clicks.push(row); return row },
    findFirst: async () => null,
    count: async () => clicks.length,
  },
  affiliateCommission: {
    findMany: async ({ where, take }: any) => {
      let rows = commissions.filter((c) => c.affiliateId === where.affiliateId)
      if (where.status) rows = rows.filter((c) => c.status === where.status)
      return rows.slice(0, take)
    },
    count: async ({ where }: any) =>
      commissions.filter((c) => c.affiliateId === where?.affiliateId).length,
    groupBy: async ({ where }: any) => {
      const grouped = new Map<string, number>()
      for (const c of commissions) {
        if (where?.affiliateId && c.affiliateId !== where.affiliateId) continue
        grouped.set(c.status, (grouped.get(c.status) ?? 0) + (c.amountCents ?? 0))
      }
      return Array.from(grouped.entries()).map(([status, sum]) => ({
        status, _sum: { amountCents: sum },
      }))
    },
  },
  affiliatePayout: {
    findMany: async ({ where, take }: any) =>
      payouts.filter((p) => p.affiliateId === where.affiliateId).slice(0, take),
  },
  affiliateCommissionTier: {
    findMany: async () => tiers,
  },
}

mock.module('../../lib/prisma', () => withPrismaExports({ prisma: prismaStub }))

const { affiliateRoutes } = await import('../affiliates')

function makeApp() {
  const { Hono } = require('hono')
  const app = new Hono()
  app.route('/api', affiliateRoutes())
  return app
}

beforeEach(() => {
  process.env.SHOGO_AFFILIATES_NATIVE = 'true'
  process.env.SHOGO_INTERNAL_SECRET = 'test-secret'
  affiliateRows.clear()
  attributionRows.clear()
  commissions.length = 0
  payouts.length = 0
  clicks.length = 0
  users.clear()
  tiers.length = 0
  tiers.push(
    { level: 1, rateBps: 2000, durationDays: 365 },
    { level: 2, rateBps: 500, durationDays: 365 },
    { level: 3, rateBps: 200, durationDays: 365 },
  )
  // Reset the default findUnique so individual tests can locally
  // override it without leaking into siblings.
  prismaStub.affiliate.findUnique = (async (args: any) => affiliateFindUnique(args)) as any
})

afterEach(() => {
  delete process.env.SHOGO_AFFILIATES_NATIVE
  delete process.env.SHOGO_INTERNAL_SECRET
})

// ============================================================================
// Internal click endpoint — real service path through to recordClick
// ============================================================================
describe('POST /api/affiliates/click (internal)', () => {
  test('rejects without internal secret', async () => {
    const app = makeApp()
    const res = await app.request('/api/affiliates/click', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'alice', visitorId: 'v_12345678' }),
    })
    expect(res.status).toBe(401)
  })

  test('returns 503 when flag is off', async () => {
    delete process.env.SHOGO_AFFILIATES_NATIVE
    const app = makeApp()
    const res = await app.request('/api/affiliates/click', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shogo-internal-secret': 'test-secret',
      },
      body: JSON.stringify({ code: 'alice', visitorId: 'v_12345678' }),
    })
    expect(res.status).toBe(503)
  })

  test('records click and returns the id when affiliate exists', async () => {
    users.set('u_alice', { id: 'u_alice', email: 'a@x.com' })
    affiliateRows.set('aff_1', {
      id: 'aff_1', userId: 'u_alice', code: 'alice', status: 'active',
      depth: 0, parentAffiliateId: null, createdAt: new Date(),
    })
    const app = makeApp()
    const res = await app.request('/api/affiliates/click', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shogo-internal-secret': 'test-secret',
      },
      body: JSON.stringify({
        code: 'alice', visitorId: 'v_12345678', utmSource: 'twitter',
      }),
    })
    expect(res.status).toBe(200)
    const json: any = await res.json()
    expect(json.ok).toBe(true)
    expect(typeof json.clickId).toBe('string')
    expect(clicks.length).toBe(1)
  })

  test('unknown affiliate code → 404', async () => {
    const app = makeApp()
    const res = await app.request('/api/affiliates/click', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shogo-internal-secret': 'test-secret',
      },
      body: JSON.stringify({ code: 'ghost', visitorId: 'v_12345678' }),
    })
    expect(res.status).toBe(404)
    const json: any = await res.json()
    expect(json.error.code).toBe('affiliate_not_found')
  })
})

// ============================================================================
// Public lookup
// ============================================================================
describe('GET /api/affiliates/lookup', () => {
  test('returns exists=false for missing code', async () => {
    const app = makeApp()
    const res = await app.request('/api/affiliates/lookup?code=ghost')
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).exists).toBe(false)
  })

  test('returns exists=true with displayName for active affiliate', async () => {
    affiliateRows.set('aff_1', {
      id: 'aff_1', userId: 'u_alice', code: 'alice', status: 'active',
    })
    prismaStub.affiliate.findUnique = (async ({ where }: any) => {
      if (where.code) return { id: 'aff_1', status: 'active', user: { name: 'Alice' } }
      return null
    }) as any
    const app = makeApp()
    const res = await app.request('/api/affiliates/lookup?code=alice')
    const json: any = await res.json()
    expect(json.exists).toBe(true)
    expect(json.displayName).toBe('Alice')
  })

  test('treats archived affiliates as missing', async () => {
    prismaStub.affiliate.findUnique = (async () => ({
      id: 'aff_1', status: 'archived', user: { name: 'Alice' },
    })) as any
    const app = makeApp()
    const res = await app.request('/api/affiliates/lookup?code=alice')
    expect(((await res.json()) as any).exists).toBe(false)
  })
})

// ============================================================================
// Enrollment (authenticated) — exercises real enrollAffiliate
// ============================================================================
describe('POST /api/affiliates/enroll', () => {
  test('401 without session', async () => {
    const app = makeApp()
    const res = await app.request('/api/affiliates/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ termsAccepted: true }),
    })
    expect(res.status).toBe(401)
  })

  test('rejects when termsAccepted is missing', async () => {
    const app = makeApp()
    const res = await app.request('/api/affiliates/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user-id': 'u1' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test('enrolls and returns an affiliate row', async () => {
    users.set('u1', { id: 'u1', email: 'alice@example.com', name: 'Alice' })
    const app = makeApp()
    const res = await app.request('/api/affiliates/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user-id': 'u1' },
      body: JSON.stringify({ termsAccepted: true }),
    })
    expect(res.status).toBe(200)
    const json: any = await res.json()
    expect(json.ok).toBe(true)
    expect(json.affiliate.userId).toBe('u1')
    expect(typeof json.affiliate.code).toBe('string')
  })
})

// ============================================================================
// /me dashboard (uses prisma + service)
// ============================================================================
describe('GET /api/affiliates/me', () => {
  test('returns enrolled=false when no row', async () => {
    const app = makeApp()
    const res = await app.request('/api/affiliates/me', {
      headers: { 'x-test-user-id': 'u1' },
    })
    expect(res.status).toBe(200)
    const json: any = await res.json()
    expect(json.enrolled).toBe(false)
  })

  test('returns summary fields when enrolled', async () => {
    users.set('u1', { id: 'u1', email: 'a@x.com' })
    affiliateRows.set('aff_1', {
      id: 'aff_1', userId: 'u1', code: 'alice', status: 'active',
      depth: 0, parentAffiliateId: null, createdAt: new Date(),
      stripeCustomAccountId: null, payoutStatus: null,
    })
    commissions.push(
      { id: 'c1', affiliateId: 'aff_1', status: 'pending', amountCents: 1500, createdAt: new Date() },
      { id: 'c2', affiliateId: 'aff_1', status: 'paid', amountCents: 2500, createdAt: new Date() },
    )
    const app = makeApp()
    const res = await app.request('/api/affiliates/me', {
      headers: { 'x-test-user-id': 'u1' },
    })
    expect(res.status).toBe(200)
    const json: any = await res.json()
    expect(json.enrolled).toBe(true)
    expect(json.affiliate.code).toBe('alice')
    expect(json.pendingCents).toBe(1500)
    expect(json.paidCents).toBe(2500)
  })
})

// ============================================================================
// /me/commissions
// ============================================================================
describe('GET /api/affiliates/me/commissions', () => {
  test('returns empty list when not enrolled', async () => {
    const app = makeApp()
    const res = await app.request('/api/affiliates/me/commissions', {
      headers: { 'x-test-user-id': 'u1' },
    })
    const json: any = await res.json()
    expect(json.commissions).toEqual([])
  })

  test('returns filtered commissions', async () => {
    affiliateRows.set('aff_1', { id: 'aff_1', userId: 'u1' })
    commissions.push(
      { id: 'c1', affiliateId: 'aff_1', status: 'approved', amountCents: 100, createdAt: new Date() },
      { id: 'c2', affiliateId: 'aff_1', status: 'pending', amountCents: 200, createdAt: new Date() },
    )
    const app = makeApp()
    const res = await app.request('/api/affiliates/me/commissions?status=approved', {
      headers: { 'x-test-user-id': 'u1' },
    })
    const json: any = await res.json()
    expect(json.commissions.length).toBe(1)
    expect(json.commissions[0].id).toBe('c1')
  })
})

// ============================================================================
// /me/payouts
// ============================================================================
describe('GET /api/affiliates/me/payouts', () => {
  test('returns empty when not enrolled', async () => {
    const app = makeApp()
    const res = await app.request('/api/affiliates/me/payouts', {
      headers: { 'x-test-user-id': 'u1' },
    })
    expect(((await res.json()) as any).payouts).toEqual([])
  })

  test('returns rows for enrolled affiliate', async () => {
    affiliateRows.set('aff_1', { id: 'aff_1', userId: 'u1' })
    payouts.push({ id: 'p1', affiliateId: 'aff_1', amountCents: 5000, status: 'paid', createdAt: new Date() })
    const app = makeApp()
    const res = await app.request('/api/affiliates/me/payouts', {
      headers: { 'x-test-user-id': 'u1' },
    })
    const json: any = await res.json()
    expect(json.payouts.length).toBe(1)
    expect(json.payouts[0].id).toBe('p1')
  })
})

// ============================================================================
// /me/downline
// ============================================================================
describe('GET /api/affiliates/me/downline', () => {
  test('returns direct children by default', async () => {
    affiliateRows.set('aff_root', {
      id: 'aff_root', userId: 'u1', code: 'root', depth: 0, parentAffiliateId: null,
      createdAt: new Date(),
    })
    affiliateRows.set('aff_child1', {
      id: 'aff_child1', userId: 'u_c1', code: 'c1', depth: 1,
      parentAffiliateId: 'aff_root', createdAt: new Date(),
    })
    affiliateRows.set('aff_grandchild', {
      id: 'aff_grandchild', userId: 'u_g1', code: 'gc1', depth: 2,
      parentAffiliateId: 'aff_child1', createdAt: new Date(),
    })
    const app = makeApp()
    const res = await app.request('/api/affiliates/me/downline', {
      headers: { 'x-test-user-id': 'u1' },
    })
    const json: any = await res.json()
    expect(json.downline.length).toBe(1)
    expect(json.downline[0].id).toBe('aff_child1')
  })

  test('level=all walks the whole tree', async () => {
    affiliateRows.set('aff_root', { id: 'aff_root', userId: 'u1', code: 'root', depth: 0, parentAffiliateId: null, createdAt: new Date() })
    affiliateRows.set('aff_child1', { id: 'aff_child1', userId: 'u_c1', code: 'c1', depth: 1, parentAffiliateId: 'aff_root', createdAt: new Date() })
    affiliateRows.set('aff_grandchild', { id: 'aff_grandchild', userId: 'u_g1', code: 'gc1', depth: 2, parentAffiliateId: 'aff_child1', createdAt: new Date() })
    const app = makeApp()
    const res = await app.request('/api/affiliates/me/downline?level=all', {
      headers: { 'x-test-user-id': 'u1' },
    })
    const json: any = await res.json()
    expect(json.downline.length).toBe(2)
    const levels = json.downline.map((d: any) => d.level).sort()
    expect(levels).toEqual([1, 2])
  })
})

// ============================================================================
// /me/stripe-connect/onboard
// ============================================================================
describe('POST /api/affiliates/me/stripe-connect/onboard', () => {
  test('404 when not enrolled', async () => {
    const app = makeApp()
    const res = await app.request('/api/affiliates/me/stripe-connect/onboard', {
      method: 'POST',
      headers: { 'x-test-user-id': 'u1' },
    })
    expect(res.status).toBe(404)
  })

  test('returns onboardUrl for enrolled affiliate', async () => {
    affiliateRows.set('aff_1', { id: 'aff_1', userId: 'u1', payoutStatus: 'pending_verification' })
    const app = makeApp()
    const res = await app.request('/api/affiliates/me/stripe-connect/onboard', {
      method: 'POST',
      headers: { 'x-test-user-id': 'u1' },
    })
    expect(res.status).toBe(200)
    const json: any = await res.json()
    expect(json.onboardUrl).toBe('acct_aff_1')
  })
})

// ============================================================================
// /click — error-branch coverage (body parse, zod, AffiliateError switch)
// ============================================================================
describe('POST /api/affiliates/click (error branches)', () => {
  test('bad_request when body is not JSON', async () => {
    const app = makeApp()
    const res = await app.request('/api/affiliates/click', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shogo-internal-secret': 'test-secret' },
      body: 'not-json{',
    })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error.code).toBe('bad_request')
  })

  test('invalid_request when payload fails zod (missing code)', async () => {
    const app = makeApp()
    const res = await app.request('/api/affiliates/click', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shogo-internal-secret': 'test-secret' },
      body: JSON.stringify({ visitorId: 'v_12345678' }),
    })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error.code).toBe('invalid_request')
    expect(Array.isArray(j.error.issues)).toBe(true)
  })

  test('AffiliateError affiliate_not_found → 404', async () => {
    const app = makeApp()
    const res = await app.request('/api/affiliates/click', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shogo-internal-secret': 'test-secret' },
      body: JSON.stringify({ code: 'nope', visitorId: 'v_12345678' }),
    })
    expect(res.status).toBe(404)
    const j: any = await res.json()
    expect(j.error.code).toBe('affiliate_not_found')
  })

  test('AffiliateError affiliate_inactive → 410 (via affiliateErrorStatus switch)', async () => {
    affiliateRows.set('aff_ina', {
      id: 'aff_ina', userId: 'u_ina', code: 'ina', depth: 0, status: 'inactive', createdAt: new Date(),
    })
    const app = makeApp()
    const res = await app.request('/api/affiliates/click', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shogo-internal-secret': 'test-secret' },
      body: JSON.stringify({ code: 'ina', visitorId: 'v_12345678' }),
    })
    expect(res.status).toBe(410)
    const j: any = await res.json()
    expect(j.error.code).toBe('affiliate_inactive')
  })

  test('generic err → 500 server_error', async () => {
    affiliateRows.set('aff_ok', {
      id: 'aff_ok', userId: 'u_ok', code: 'ok', depth: 0, status: 'active', createdAt: new Date(),
    })
    const orig = prismaStub.affiliateClick.create
    prismaStub.affiliateClick.create = (async () => { throw new Error('boom-db') }) as any
    try {
      const origErr = console.error
      console.error = () => {}
      const app = makeApp()
      const res = await app.request('/api/affiliates/click', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shogo-internal-secret': 'test-secret' },
        body: JSON.stringify({ code: 'ok', visitorId: 'v_12345678' }),
      })
      console.error = origErr
      expect(res.status).toBe(500)
      const j: any = await res.json()
      expect(j.error.code).toBe('server_error')
    } finally {
      prismaStub.affiliateClick.create = orig
    }
  })
})

// ============================================================================
// /enroll — error-branch coverage
// ============================================================================
describe('POST /api/affiliates/enroll (error branches)', () => {
  test('503 when flag off', async () => {
    delete process.env.SHOGO_AFFILIATES_NATIVE
    const app = makeApp()
    const res = await app.request('/api/affiliates/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user-id': 'u1' },
      body: JSON.stringify({ termsAccepted: true }),
    })
    expect(res.status).toBe(503)
  })

  test('401 when no auth header', async () => {
    const app = makeApp()
    const res = await app.request('/api/affiliates/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ termsAccepted: true }),
    })
    expect(res.status).toBe(401)
  })

  test('400 bad_request when body is not JSON', async () => {
    users.set('u_e', { id: 'u_e', email: 'e@x.io', name: 'E' })
    const app = makeApp()
    const res = await app.request('/api/affiliates/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user-id': 'u_e' },
      body: '{not-json',
    })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error.code).toBe('bad_request')
  })

  test('400 invalid_request when zod validation fails', async () => {
    users.set('u_e', { id: 'u_e', email: 'e@x.io', name: 'E' })
    const app = makeApp()
    const res = await app.request('/api/affiliates/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user-id': 'u_e' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error.code).toBe('invalid_request')
  })

  test('AffiliateError terms_required → 400', async () => {
    users.set('u_e', { id: 'u_e', email: 'e@x.io', name: 'E' })
    const app = makeApp()
    const res = await app.request('/api/affiliates/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user-id': 'u_e' },
      body: JSON.stringify({ termsAccepted: false }),
    })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error.code).toBe('terms_required')
  })

  test('AffiliateError invalid_code → 400', async () => {
    users.set('u_e', { id: 'u_e', email: 'e@x.io', name: 'E' })
    const app = makeApp()
    const res = await app.request('/api/affiliates/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user-id': 'u_e' },
      body: JSON.stringify({ termsAccepted: true, code: '--bad' }),
    })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error.code).toBe('invalid_code')
  })

  test('AffiliateError parent_not_found → 404', async () => {
    users.set('u_e', { id: 'u_e', email: 'e@x.io', name: 'E' })
    const app = makeApp()
    const res = await app.request('/api/affiliates/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user-id': 'u_e' },
      body: JSON.stringify({ termsAccepted: true, parentCode: 'ghost' }),
    })
    expect(res.status).toBe(404)
    const j: any = await res.json()
    expect(j.error.code).toBe('parent_not_found')
  })

  test('AffiliateError user_not_found → 404 (user missing in db)', async () => {
    const app = makeApp()
    const res = await app.request('/api/affiliates/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user-id': 'u_ghost' },
      body: JSON.stringify({ termsAccepted: true }),
    })
    expect(res.status).toBe(404)
    const j: any = await res.json()
    expect(j.error.code).toBe('user_not_found')
  })

  test('generic err → 500 server_error (user lookup throws)', async () => {
    users.set('u_e', { id: 'u_e', email: 'e@x.io', name: 'E' })
    const orig = prismaStub.user.findUnique
    prismaStub.user.findUnique = (async () => { throw new Error('db-down') }) as any
    const origErr = console.error
    console.error = () => {}
    try {
      const app = makeApp()
      const res = await app.request('/api/affiliates/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user-id': 'u_e' },
        body: JSON.stringify({ termsAccepted: true }),
      })
      expect(res.status).toBe(500)
      const j: any = await res.json()
      expect(j.error.code).toBe('server_error')
    } finally {
      prismaStub.user.findUnique = orig
      console.error = origErr
    }
  })
})

// ============================================================================
// /me — flag + auth + not-enrolled branches
// ============================================================================
describe('GET /api/affiliates/me', () => {
  test('503 when flag off', async () => {
    delete process.env.SHOGO_AFFILIATES_NATIVE
    const app = makeApp()
    const res = await app.request('/api/affiliates/me', {
      headers: { 'x-test-user-id': 'u1' },
    })
    expect(res.status).toBe(503)
  })

  test('returns enrolled: false when user has no affiliate row', async () => {
    const app = makeApp()
    const res = await app.request('/api/affiliates/me', {
      headers: { 'x-test-user-id': 'u_no' },
    })
    expect(res.status).toBe(200)
    const j: any = await res.json()
    expect(j.ok).toBe(true)
    expect(j.enrolled).toBe(false)
  })
})

// ============================================================================
// /me/stripe-connect/onboard — error branches
// ============================================================================
describe('POST /api/affiliates/me/stripe-connect/onboard (error branches)', () => {
  test('503 when flag off', async () => {
    delete process.env.SHOGO_AFFILIATES_NATIVE
    const app = makeApp()
    const res = await app.request('/api/affiliates/me/stripe-connect/onboard', {
      method: 'POST',
      headers: { 'x-test-user-id': 'u1' },
    })
    expect(res.status).toBe(503)
  })

  test('500 generic when wrapper throws non-NOT_FOUND error', async () => {
    affiliateRows.set('aff_g', { id: 'aff_g', userId: 'u_g', payoutStatus: 'not_setup' })
    // Override the dynamic-import mock for stripe-connect: make wrapper throw a real error.
    mock.module('../../services/stripe-connect.service', () => ({
      createCustomAccountForAffiliate: async () => { throw new Error('stripe-down') },
      submitPayoutDetailsForAffiliate: async () => ({ payoutStatus: 'pending_verification' }),
    }))
    const origErr = console.error
    console.error = () => {}
    try {
      const app = makeApp()
      const res = await app.request('/api/affiliates/me/stripe-connect/onboard', {
        method: 'POST',
        headers: { 'x-test-user-id': 'u_g' },
      })
      expect(res.status).toBe(500)
      const j: any = await res.json()
      expect(j.error.code).toBe('server_error')
    } finally {
      console.error = origErr
      // Restore the good mock for subsequent tests.
      mock.module('../../services/stripe-connect.service', () => ({
        createCustomAccountForAffiliate: async (affId: string) => `acct_${affId}`,
        submitPayoutDetailsForAffiliate: async () => ({ payoutStatus: 'pending_verification' }),
      }))
    }
  })
})

// ============================================================================
// /me/stripe-connect/details — covers entire endpoint (L355-375)
// ============================================================================
describe('POST /api/affiliates/me/stripe-connect/details', () => {
  test('503 when flag off', async () => {
    delete process.env.SHOGO_AFFILIATES_NATIVE
    const app = makeApp()
    const res = await app.request('/api/affiliates/me/stripe-connect/details', {
      method: 'POST',
      headers: { 'x-test-user-id': 'u1' },
    })
    expect(res.status).toBe(503)
  })

  test('400 not_onboarded when affiliate has no stripeCustomAccountId', async () => {
    affiliateRows.set('aff_d', { id: 'aff_d', userId: 'u_d', stripeCustomAccountId: null })
    const app = makeApp()
    const res = await app.request('/api/affiliates/me/stripe-connect/details', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user-id': 'u_d' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error.code).toBe('not_onboarded')
  })

  test('400 not_onboarded when user has no affiliate row at all', async () => {
    const app = makeApp()
    const res = await app.request('/api/affiliates/me/stripe-connect/details', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user-id': 'u_x' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error.code).toBe('not_onboarded')
  })

  test('400 bad_request when body fails to parse', async () => {
    affiliateRows.set('aff_d', { id: 'aff_d', userId: 'u_d', stripeCustomAccountId: 'acct_x' })
    const app = makeApp()
    const res = await app.request('/api/affiliates/me/stripe-connect/details', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user-id': 'u_d' },
      body: '{not-json',
    })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error.code).toBe('bad_request')
  })

  test('200 happy: returns wrapper result on success', async () => {
    affiliateRows.set('aff_d', { id: 'aff_d', userId: 'u_d', stripeCustomAccountId: 'acct_x' })
    const app = makeApp()
    const res = await app.request('/api/affiliates/me/stripe-connect/details', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user-id': 'u_d' },
      body: JSON.stringify({ firstName: 'A', lastName: 'B' }),
    })
    expect(res.status).toBe(200)
    const j: any = await res.json()
    expect(j.ok).toBe(true)
    expect(j.payoutStatus).toBe('pending_verification')
  })

  test('500 generic when wrapper throws non-matching error', async () => {
    affiliateRows.set('aff_d', { id: 'aff_d', userId: 'u_d', stripeCustomAccountId: 'acct_x' })
    mock.module('../../services/stripe-connect.service', () => ({
      createCustomAccountForAffiliate: async (affId: string) => `acct_${affId}`,
      submitPayoutDetailsForAffiliate: async () => { throw new Error('stripe-down') },
    }))
    const origErr = console.error
    console.error = () => {}
    try {
      const app = makeApp()
      const res = await app.request('/api/affiliates/me/stripe-connect/details', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user-id': 'u_d' },
        body: JSON.stringify({ firstName: 'A' }),
      })
      expect(res.status).toBe(500)
      const j: any = await res.json()
      expect(j.error.code).toBe('server_error')
    } finally {
      console.error = origErr
      mock.module('../../services/stripe-connect.service', () => ({
        createCustomAccountForAffiliate: async (affId: string) => `acct_${affId}`,
        submitPayoutDetailsForAffiliate: async () => ({ payoutStatus: 'pending_verification' }),
      }))
    }
  })

  test('501 not_implemented when wrapper rejects with a "submitPayoutDetailsForAffiliate" message', async () => {
    affiliateRows.set('aff_d', { id: 'aff_d', userId: 'u_d', stripeCustomAccountId: 'acct_x' })
    mock.module('../../services/stripe-connect.service', () => ({
      createCustomAccountForAffiliate: async (affId: string) => `acct_${affId}`,
      submitPayoutDetailsForAffiliate: async () => {
        throw new Error('submitPayoutDetailsForAffiliate is not implemented')
      },
    }))
    try {
      const app = makeApp()
      const res = await app.request('/api/affiliates/me/stripe-connect/details', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user-id': 'u_d' },
        body: JSON.stringify({ firstName: 'A' }),
      })
      expect(res.status).toBe(501)
      const j: any = await res.json()
      expect(j.error.code).toBe('not_implemented')
    } finally {
      mock.module('../../services/stripe-connect.service', () => ({
        createCustomAccountForAffiliate: async (affId: string) => `acct_${affId}`,
        submitPayoutDetailsForAffiliate: async () => ({ payoutStatus: 'pending_verification' }),
      }))
    }
  })
})
