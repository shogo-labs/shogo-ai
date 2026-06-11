// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Scoped admin-access middleware tests.
 *
 * Exercises the real requireAdminScope / requireAnyAdmin against a fake Hono
 * context with a mocked prisma.user.findUnique (mirrors super-admin.test.ts).
 *
 * Run: bun test apps/api/src/middleware/__tests__/admin-access.test.ts
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

let findUniqueImpl: (args: { where: { id: string }; select: any }) => Promise<any> = async () =>
  null

mock.module('../../lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (args: any) => findUniqueImpl(args),
    },
  },
}))

const { requireAdminScope, requireAnyScope, requireAnyAdmin } = await import('../admin-access')

interface FakeJsonResponse {
  body: any
  status: number
}

function makeContext(auth: any) {
  const store: Record<string, any> = { auth }
  return {
    get: (k: string) => store[k],
    set: (k: string, v: any) => {
      store[k] = v
    },
    json: (body: any, status?: number): FakeJsonResponse => ({
      body,
      status: status ?? 200,
    }),
  } as any
}

let nextCalled = 0
const next = async () => {
  nextCalled += 1
}

beforeEach(() => {
  nextCalled = 0
  findUniqueImpl = async () => null
})

describe('requireAdminScope', () => {
  it('returns 401 when auth is missing', async () => {
    const c = makeContext(undefined)
    const res = (await requireAdminScope('analytics:read')(c, next)) as FakeJsonResponse
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('unauthorized')
    expect(nextCalled).toBe(0)
  })

  it('returns 401 when auth has no userId', async () => {
    const c = makeContext({})
    const res = (await requireAdminScope('analytics:read')(c, next)) as FakeJsonResponse
    expect(res.status).toBe(401)
    expect(nextCalled).toBe(0)
  })

  it('lets a super_admin through for any scope (implicit all-scopes)', async () => {
    findUniqueImpl = async () => ({ role: 'super_admin', adminScopes: [] })
    const c = makeContext({ userId: 'admin-1' })
    await requireAdminScope('analytics:read')(c, next)
    await requireAdminScope('creators:read')(c, next)
    expect(nextCalled).toBe(2)
  })

  it('lets a user with the exact scope through', async () => {
    findUniqueImpl = async () => ({ role: 'user', adminScopes: ['analytics:read'] })
    const c = makeContext({ userId: 'user-1' })
    const res = await requireAdminScope('analytics:read')(c, next)
    expect(res).toBeUndefined()
    expect(nextCalled).toBe(1)
  })

  it('forbids a user who lacks the requested scope', async () => {
    findUniqueImpl = async () => ({ role: 'user', adminScopes: ['analytics:read'] })
    const c = makeContext({ userId: 'user-1' })
    const res = (await requireAdminScope('creators:read')(c, next)) as FakeJsonResponse
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('forbidden')
    expect(nextCalled).toBe(0)
  })

  it('forbids a plain user with no scopes', async () => {
    findUniqueImpl = async () => ({ role: 'user', adminScopes: [] })
    const c = makeContext({ userId: 'user-1' })
    const res = (await requireAdminScope('analytics:read')(c, next)) as FakeJsonResponse
    expect(res.status).toBe(403)
    expect(nextCalled).toBe(0)
  })

  it('normalizes a JSON-string adminScopes value (SQLite shape)', async () => {
    findUniqueImpl = async () => ({ role: 'user', adminScopes: '["creators:read"]' })
    const c = makeContext({ userId: 'user-1' })
    await requireAdminScope('creators:read')(c, next)
    expect(nextCalled).toBe(1)
  })

  it('ignores unknown scope strings stored on the user', async () => {
    findUniqueImpl = async () => ({ role: 'user', adminScopes: ['totally:bogus'] })
    const c = makeContext({ userId: 'user-1' })
    const res = (await requireAdminScope('analytics:read')(c, next)) as FakeJsonResponse
    expect(res.status).toBe(403)
    expect(nextCalled).toBe(0)
  })
})

describe('requireAnyScope', () => {
  it('returns 401 when auth is missing', async () => {
    const c = makeContext(undefined)
    const res = (await requireAnyScope('marketing:read', 'ai:read')(c, next)) as FakeJsonResponse
    expect(res.status).toBe(401)
    expect(nextCalled).toBe(0)
  })

  it('lets a super_admin through for any listed scope', async () => {
    findUniqueImpl = async () => ({ role: 'super_admin', adminScopes: [] })
    const c = makeContext({ userId: 'admin-1' })
    await requireAnyScope('marketing:read', 'ai:read')(c, next)
    expect(nextCalled).toBe(1)
  })

  it('lets a user holding any one of the listed scopes through', async () => {
    findUniqueImpl = async () => ({ role: 'user', adminScopes: ['marketing:read'] })
    const c = makeContext({ userId: 'user-1' })
    await requireAnyScope('analytics:read', 'marketing:read')(c, next)
    expect(nextCalled).toBe(1)
  })

  it('lets the legacy umbrella analytics:read through any analytics gate', async () => {
    findUniqueImpl = async () => ({ role: 'user', adminScopes: ['analytics:read'] })
    const c = makeContext({ userId: 'user-1' })
    await requireAnyScope('analytics:read', 'ai:read')(c, next)
    expect(nextCalled).toBe(1)
  })

  it('forbids a user holding none of the listed scopes', async () => {
    findUniqueImpl = async () => ({ role: 'user', adminScopes: ['marketing:read'] })
    const c = makeContext({ userId: 'user-1' })
    const res = (await requireAnyScope('ai:read')(c, next)) as FakeJsonResponse
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('forbidden')
    expect(nextCalled).toBe(0)
  })
})

describe('requireAnyAdmin', () => {
  it('returns 401 when auth is missing', async () => {
    const c = makeContext(undefined)
    const res = (await requireAnyAdmin(c, next)) as FakeJsonResponse
    expect(res.status).toBe(401)
    expect(nextCalled).toBe(0)
  })

  it('lets a super_admin through', async () => {
    findUniqueImpl = async () => ({ role: 'super_admin', adminScopes: [] })
    const c = makeContext({ userId: 'admin-1' })
    await requireAnyAdmin(c, next)
    expect(nextCalled).toBe(1)
  })

  it('lets a user with at least one scope through', async () => {
    findUniqueImpl = async () => ({ role: 'user', adminScopes: ['creators:read'] })
    const c = makeContext({ userId: 'user-1' })
    await requireAnyAdmin(c, next)
    expect(nextCalled).toBe(1)
  })

  it('forbids a plain user with no scopes', async () => {
    findUniqueImpl = async () => ({ role: 'user', adminScopes: [] })
    const c = makeContext({ userId: 'user-1' })
    const res = (await requireAnyAdmin(c, next)) as FakeJsonResponse
    expect(res.status).toBe(403)
    expect(nextCalled).toBe(0)
  })
})
