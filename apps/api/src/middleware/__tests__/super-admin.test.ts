// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

let findUniqueImpl: (args: { where: { id: string }; select: any }) => Promise<any> = async () =>
  null

mock.module('../../lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (args: any) => findUniqueImpl(args),
    },
  },
}))

const { requireSuperAdmin } = await import('../super-admin')

interface FakeJsonResponse {
  body: any
  status: number
}

function makeContext(auth: any) {
  const store: Record<string, any> = { auth }
  const ctx: any = {
    get: (k: string) => store[k],
    set: (k: string, v: any) => {
      store[k] = v
    },
    json: (body: any, status?: number): FakeJsonResponse => ({
      body,
      status: status ?? 200,
    }),
  }
  return ctx
}

let nextCalled = 0
const next = async () => {
  nextCalled += 1
}

beforeEach(() => {
  nextCalled = 0
  findUniqueImpl = async () => null
})

afterEach(() => {
  // nothing
})

describe('requireSuperAdmin', () => {
  it('returns 401 with unauthorized code when auth is missing', async () => {
    const c = makeContext(undefined)
    const res = (await requireSuperAdmin(c, next)) as FakeJsonResponse
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('unauthorized')
    expect(res.body.error.message).toBe('Authentication required')
    expect(nextCalled).toBe(0)
  })

  it('returns 401 when auth has no userId', async () => {
    const c = makeContext({})
    const res = (await requireSuperAdmin(c, next)) as FakeJsonResponse
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('unauthorized')
    expect(nextCalled).toBe(0)
  })

  it('returns 403 when user is not found in DB', async () => {
    findUniqueImpl = async () => null
    const c = makeContext({ userId: 'user-1' })
    const res = (await requireSuperAdmin(c, next)) as FakeJsonResponse
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('forbidden')
    expect(res.body.error.message).toBe('Super admin access required')
    expect(nextCalled).toBe(0)
  })

  it('returns 403 when user role is not super_admin', async () => {
    findUniqueImpl = async () => ({ role: 'user' })
    const c = makeContext({ userId: 'user-1' })
    const res = (await requireSuperAdmin(c, next)) as FakeJsonResponse
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('forbidden')
    expect(nextCalled).toBe(0)
  })

  it('returns 403 when user role is null', async () => {
    findUniqueImpl = async () => ({ role: null })
    const c = makeContext({ userId: 'user-1' })
    const res = (await requireSuperAdmin(c, next)) as FakeJsonResponse
    expect(res.status).toBe(403)
    expect(nextCalled).toBe(0)
  })

  it('returns 403 for an admin (not super_admin) — role names are exact', async () => {
    findUniqueImpl = async () => ({ role: 'admin' })
    const c = makeContext({ userId: 'user-1' })
    const res = (await requireSuperAdmin(c, next)) as FakeJsonResponse
    expect(res.status).toBe(403)
    expect(nextCalled).toBe(0)
  })

  it('calls next() when user role is super_admin', async () => {
    findUniqueImpl = async () => ({ role: 'super_admin' })
    const c = makeContext({ userId: 'user-1' })
    const result = await requireSuperAdmin(c, next)
    expect(result).toBeUndefined()
    expect(nextCalled).toBe(1)
  })

  it('queries prisma with the auth.userId and selects role only', async () => {
    let capturedArgs: any
    findUniqueImpl = async (args) => {
      capturedArgs = args
      return { role: 'super_admin' }
    }
    const c = makeContext({ userId: 'the-user-id' })
    await requireSuperAdmin(c, next)
    expect(capturedArgs.where).toEqual({ id: 'the-user-id' })
    expect(capturedArgs.select).toEqual({ role: true })
  })

  it('skips the DB lookup entirely when auth is missing (no leakage)', async () => {
    let dbCalled = false
    findUniqueImpl = async () => {
      dbCalled = true
      return null
    }
    const c = makeContext(undefined)
    await requireSuperAdmin(c, next)
    expect(dbCalled).toBe(false)
  })

  it('propagates DB errors (does not swallow)', async () => {
    findUniqueImpl = async () => {
      throw new Error('db unreachable')
    }
    const c = makeContext({ userId: 'user-1' })
    await expect(requireSuperAdmin(c, next)).rejects.toThrow('db unreachable')
    expect(nextCalled).toBe(0)
  })

  it('treats falsy userId values (empty string) as unauthorized', async () => {
    const c = makeContext({ userId: '' })
    const res = (await requireSuperAdmin(c, next)) as FakeJsonResponse
    expect(res.status).toBe(401)
    expect(nextCalled).toBe(0)
  })
})
