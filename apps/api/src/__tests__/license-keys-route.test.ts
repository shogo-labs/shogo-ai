// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/routes/license-keys.ts` — covers both routers:
 *
 *   `licenseKeyAdminRoutes()` (super-admin)
 *     POST /license-keys/mint            (body validation, plaintext-once)
 *     GET  /license-keys                  (batchId / redeemed filters)
 *     POST /license-keys/:id/revoke      (404, 409 already_redeemed, ok)
 *
 *   `licenseKeyRoutes()` (workspace member)
 *     POST /workspaces/:workspaceId/redeem-license
 *       - 403 when not a member
 *       - 400 on bad body
 *       - 404/410/409 on service errors
 *       - 200 happy path + grant created + wallet refresh attempted
 *       - wallet refresh failure does NOT roll back the redemption
 *
 * Middleware (`authMiddleware`/`requireAuth`/`requireSuperAdmin`) is stubbed
 * pass-through; the auth context is injected by hand via the
 * `setAuth` middleware in `makeApp`.
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

// ─── In-memory state for license-key service + member checks ──────────

interface LicenseKeyRow {
  id: string
  codeHash: string
  codePrefix: string
  batchId: string | null
  planId: string
  monthlyIncludedUsd: number
  freeSeats: number
  durationDays: number | null
  expiresAt: Date | null
  redeemedAt: Date | null
  redeemedByWorkspaceId: string | null
  redeemedByUserId: string | null
  redeemedGrantId: string | null
  note: string | null
  createdByUserId: string | null
  createdAt: Date
}
interface GrantRow {
  id: string
  workspaceId: string
  freeSeats: number
  monthlyIncludedUsd: number
  planId: string | null
  startsAt: Date
  expiresAt: Date | null
  note: string | null
  createdByUserId: string | null
  createdAt: Date
}
interface MemberRow {
  userId: string
  workspaceId: string
}

const keys: LicenseKeyRow[] = []
const grants: GrantRow[] = []
const members: MemberRow[] = []
let keyIdSeq = 0
let grantIdSeq = 0
let walletRefreshThrow: Error | null = null
const walletRefreshCalls: string[] = []

function reset() {
  keys.length = 0
  grants.length = 0
  members.length = 0
  keyIdSeq = 0
  grantIdSeq = 0
  walletRefreshThrow = null
  walletRefreshCalls.length = 0
}

function matchWhere(row: LicenseKeyRow, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR' && Array.isArray(v)) {
      const ok = v.some((c) => matchWhere(row, c as Record<string, unknown>))
      if (!ok) return false
      continue
    }
    if (k === 'redeemedAt') {
      if (v === null && row.redeemedAt !== null) return false
      if (v && typeof v === 'object' && 'not' in (v as object) && row.redeemedAt === null) return false
      continue
    }
    if (k === 'expiresAt') {
      if (v === null) {
        if (row.expiresAt !== null) return false
      } else if (v && typeof v === 'object' && 'gt' in (v as object)) {
        if (!row.expiresAt) return false
        if (+row.expiresAt <= +((v as { gt: Date }).gt)) return false
      }
      continue
    }
    if ((row as any)[k] !== v) return false
  }
  return true
}

const prismaMock = {
  licenseKey: {
    findUnique: async ({ where }: any) => {
      if (where.codeHash) return keys.find((k) => k.codeHash === where.codeHash) ?? null
      if (where.id) return keys.find((k) => k.id === where.id) ?? null
      return null
    },
    findMany: async ({ where, take, skip, orderBy }: any) => {
      let rows = [...keys]
      if (where) {
        if (where.batchId) rows = rows.filter((k) => k.batchId === where.batchId)
        if (where.redeemedAt === null) rows = rows.filter((k) => k.redeemedAt === null)
        if (where.redeemedAt && typeof where.redeemedAt === 'object' && 'not' in where.redeemedAt) {
          rows = rows.filter((k) => k.redeemedAt !== null)
        }
      }
      if (orderBy?.createdAt === 'desc') rows.sort((a, b) => +b.createdAt - +a.createdAt)
      return rows.slice(skip ?? 0, (skip ?? 0) + (take ?? rows.length))
    },
    create: async ({ data }: any) => {
      if (keys.some((k) => k.codeHash === data.codeHash)) {
        throw new Error('unique codeHash')
      }
      keyIdSeq += 1
      const row: LicenseKeyRow = {
        id: `lk_${keyIdSeq}`,
        codeHash: data.codeHash,
        codePrefix: data.codePrefix,
        batchId: data.batchId ?? null,
        planId: data.planId,
        monthlyIncludedUsd: data.monthlyIncludedUsd ?? 0,
        freeSeats: data.freeSeats ?? 0,
        durationDays: data.durationDays ?? null,
        expiresAt: data.expiresAt ?? null,
        redeemedAt: null,
        redeemedByWorkspaceId: null,
        redeemedByUserId: null,
        redeemedGrantId: null,
        note: data.note ?? null,
        createdByUserId: data.createdByUserId ?? null,
        createdAt: new Date(),
      }
      keys.push(row)
      return { id: row.id, codePrefix: row.codePrefix, planId: row.planId, expiresAt: row.expiresAt }
    },
    update: async ({ where, data }: any) => {
      const row = where.codeHash
        ? keys.find((k) => k.codeHash === where.codeHash)
        : keys.find((k) => k.id === where.id)
      if (!row) throw new Error('not found')
      Object.assign(row, data)
      return row
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const row of keys) {
        if (!matchWhere(row, where)) continue
        Object.assign(row, data)
        count += 1
      }
      return { count }
    },
  },
  workspaceGrant: {
    create: async ({ data, select }: any) => {
      grantIdSeq += 1
      const row: GrantRow = {
        id: `wg_${grantIdSeq}`,
        workspaceId: data.workspaceId,
        freeSeats: data.freeSeats ?? 0,
        monthlyIncludedUsd: data.monthlyIncludedUsd ?? 0,
        planId: data.planId ?? null,
        startsAt: data.startsAt ?? new Date(),
        expiresAt: data.expiresAt ?? null,
        note: data.note ?? null,
        createdByUserId: data.createdByUserId ?? null,
        createdAt: new Date(),
      }
      grants.push(row)
      if (!select) return row
      const out: any = {}
      for (const k of Object.keys(select)) if (select[k]) out[k] = (row as any)[k]
      return out
    },
  },
  member: {
    findFirst: async ({ where }: any) =>
      members.find((m) => m.userId === where.userId && m.workspaceId === where.workspaceId) ?? null,
  },
  $transaction: async (ops: any) => {
    if (Array.isArray(ops)) return Promise.all(ops)
    return ops(prismaMock)
  },
}

mock.module('../lib/prisma', () => ({ prisma: prismaMock }))

mock.module('../services/billing.service', () => ({
  applyGrantMonthlyAllocation: async (workspaceId: string) => {
    walletRefreshCalls.push(workspaceId)
    if (walletRefreshThrow) throw walletRefreshThrow
    return { workspaceId, monthlyIncludedUsd: 20 }
  },
}))

const { licenseKeyAdminRoutes, licenseKeyRoutes } = await import('../routes/license-keys')

// ─── helpers ──────────────────────────────────────────────────────────

function makeAdminApp() {
  return licenseKeyAdminRoutes()
}

function makeRedeemApp(userId: string | null = 'u-redeemer') {
  // Hono middleware must be registered BEFORE the routes it should
  // intercept, so we wrap `licenseKeyRoutes()` behind a parent app
  // that injects the auth context first. Pass `null` (NOT `undefined`,
  // which would trigger the default parameter) to simulate an
  // unauthenticated caller — in that case we skip the middleware
  // entirely so `c.get('auth')` is naturally undefined.
  const Hono = require('hono').Hono
  const parent = new Hono()
  if (userId !== null) {
    parent.use('*', async (c: any, next: any) => {
      c.set('auth', { userId })
      await next()
    })
  }
  parent.route('/', licenseKeyRoutes())
  return parent
}

async function call(app: any, method: string, path: string, body?: any) {
  const init: any = { method }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  const res = await app.fetch(new Request(`http://test${path}`, init))
  const json = await res.json().catch(() => ({}))
  return { status: res.status, body: json }
}

beforeEach(reset)

// ============================================================================
// Admin routes
// ============================================================================

describe('POST /admin/license-keys/mint', () => {
  test('400 when body is not JSON', async () => {
    const res = await call(makeAdminApp(), 'POST', '/license-keys/mint', 'not-json')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })

  test('400 when count is missing', async () => {
    const res = await call(makeAdminApp(), 'POST', '/license-keys/mint', { planId: 'pro' })
    expect(res.status).toBe(400)
  })

  test('400 when planId is free', async () => {
    const res = await call(makeAdminApp(), 'POST', '/license-keys/mint', {
      count: 1,
      planId: 'free',
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('mint_failed')
  })

  test('200 returns plaintext codes and persists hashes', async () => {
    const res = await call(makeAdminApp(), 'POST', '/license-keys/mint', {
      count: 3,
      planId: 'pro',
      batchId: 'launch',
      durationDays: 30,
    })
    expect(res.status).toBe(200)
    expect(res.body.data.count).toBe(3)
    expect(res.body.data.keys).toHaveLength(3)
    for (const k of res.body.data.keys) {
      expect(k.plaintext).toMatch(/^SHGO-PRO-/)
      expect(k.planId).toBe('pro')
    }
    expect(keys).toHaveLength(3)
    for (const k of keys) {
      expect(k.batchId).toBe('launch')
      expect(k.durationDays).toBe(30)
      expect((k as any).plaintext).toBeUndefined()
    }
  })
})

describe('GET /admin/license-keys', () => {
  test('returns rows filtered by batchId and redeemed flag', async () => {
    await call(makeAdminApp(), 'POST', '/license-keys/mint', { count: 2, planId: 'pro', batchId: 'A' })
    await call(makeAdminApp(), 'POST', '/license-keys/mint', { count: 1, planId: 'pro', batchId: 'B' })
    const all = await call(makeAdminApp(), 'GET', '/license-keys')
    expect(all.body.data.count).toBe(3)
    const a = await call(makeAdminApp(), 'GET', '/license-keys?batchId=A')
    expect(a.body.data.count).toBe(2)
    const un = await call(makeAdminApp(), 'GET', '/license-keys?redeemed=false')
    expect(un.body.data.count).toBe(3)
    const r = await call(makeAdminApp(), 'GET', '/license-keys?redeemed=true')
    expect(r.body.data.count).toBe(0)
  })
})

describe('POST /admin/license-keys/:id/revoke', () => {
  test('404 when key does not exist', async () => {
    const res = await call(makeAdminApp(), 'POST', '/license-keys/missing/revoke')
    expect(res.status).toBe(404)
  })

  test('409 when key is already redeemed', async () => {
    const mint = await call(makeAdminApp(), 'POST', '/license-keys/mint', { count: 1, planId: 'pro' })
    const id = mint.body.data.keys[0].id
    // Force redeemed state directly.
    keys[0].redeemedAt = new Date()
    const res = await call(makeAdminApp(), 'POST', `/license-keys/${id}/revoke`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('already_redeemed')
  })

  test('200 expires unredeemed key', async () => {
    const mint = await call(makeAdminApp(), 'POST', '/license-keys/mint', { count: 1, planId: 'pro' })
    const id = mint.body.data.keys[0].id
    const res = await call(makeAdminApp(), 'POST', `/license-keys/${id}/revoke`)
    expect(res.status).toBe(200)
    expect(new Date(res.body.data.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 100)
  })
})

// ============================================================================
// Redeem route
// ============================================================================

async function mintOne(opts: any = {}) {
  const res = await call(makeAdminApp(), 'POST', '/license-keys/mint', {
    count: 1,
    planId: 'pro',
    ...opts,
  })
  return res.body.data.keys[0].plaintext as string
}

describe('POST /workspaces/:workspaceId/redeem-license', () => {
  test('401 when unauthenticated', async () => {
    const res = await call(makeRedeemApp(null), 'POST', '/workspaces/ws1/redeem-license', {
      code: 'irrelevant',
    })
    expect(res.status).toBe(401)
  })

  test('403 when user is not a member of the workspace', async () => {
    const plaintext = await mintOne()
    // No member row -> forbidden.
    const res = await call(makeRedeemApp('u-stranger'), 'POST', '/workspaces/ws1/redeem-license', {
      code: plaintext,
    })
    expect(res.status).toBe(403)
    expect(grants).toHaveLength(0)
  })

  test('400 when body is not JSON', async () => {
    members.push({ userId: 'u-redeemer', workspaceId: 'ws1' })
    const res = await call(makeRedeemApp('u-redeemer'), 'POST', '/workspaces/ws1/redeem-license', 'nope')
    expect(res.status).toBe(400)
  })

  test('400 when code is missing', async () => {
    members.push({ userId: 'u-redeemer', workspaceId: 'ws1' })
    const res = await call(makeRedeemApp('u-redeemer'), 'POST', '/workspaces/ws1/redeem-license', {})
    expect(res.status).toBe(400)
  })

  test('404 when license key is unknown', async () => {
    members.push({ userId: 'u-redeemer', workspaceId: 'ws1' })
    const res = await call(makeRedeemApp('u-redeemer'), 'POST', '/workspaces/ws1/redeem-license', {
      code: 'SHGO-PRO-XXXX-XXXX-XXXX',
    })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  test('200 happy path mints grant + refreshes wallet', async () => {
    const plaintext = await mintOne({ durationDays: 30, monthlyIncludedUsd: 25 })
    members.push({ userId: 'u-redeemer', workspaceId: 'ws1' })
    const res = await call(makeRedeemApp('u-redeemer'), 'POST', '/workspaces/ws1/redeem-license', {
      code: plaintext,
    })
    expect(res.status).toBe(200)
    expect(res.body.data.planId).toBe('pro')
    expect(grants).toHaveLength(1)
    expect(grants[0].workspaceId).toBe('ws1')
    expect(grants[0].planId).toBe('pro')
    expect(walletRefreshCalls).toEqual(['ws1'])
  })

  test('409 already_redeemed on second attempt', async () => {
    const plaintext = await mintOne()
    members.push({ userId: 'u-redeemer', workspaceId: 'ws1' })
    members.push({ userId: 'u-other', workspaceId: 'ws2' })
    const first = await call(makeRedeemApp('u-redeemer'), 'POST', '/workspaces/ws1/redeem-license', {
      code: plaintext,
    })
    expect(first.status).toBe(200)
    const second = await call(makeRedeemApp('u-other'), 'POST', '/workspaces/ws2/redeem-license', {
      code: plaintext,
    })
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('already_redeemed')
    expect(grants).toHaveLength(1)
  })

  test('410 expired when license-key expiry has lapsed', async () => {
    const plaintext = await mintOne({ expiresAt: new Date('2020-01-01T00:00:00Z').toISOString() })
    members.push({ userId: 'u-redeemer', workspaceId: 'ws1' })
    const res = await call(makeRedeemApp('u-redeemer'), 'POST', '/workspaces/ws1/redeem-license', {
      code: plaintext,
    })
    expect(res.status).toBe(410)
    expect(res.body.error.code).toBe('expired')
    expect(grants).toHaveLength(0)
  })

  test('wallet refresh failure does NOT roll back the redemption', async () => {
    const plaintext = await mintOne()
    members.push({ userId: 'u-redeemer', workspaceId: 'ws1' })
    walletRefreshThrow = new Error('wallet down')
    const res = await call(makeRedeemApp('u-redeemer'), 'POST', '/workspaces/ws1/redeem-license', {
      code: plaintext,
    })
    expect(res.status).toBe(200)
    expect(grants).toHaveLength(1)
    expect(walletRefreshCalls).toEqual(['ws1'])
  })
})
