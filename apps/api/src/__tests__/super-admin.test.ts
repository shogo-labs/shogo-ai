// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Mock prisma BEFORE importing the middleware.
const findUniqueMock = mock(async (_args: any): Promise<any> => null)
mock.module('../lib/prisma', () => ({
  prisma: {
    user: { findUnique: findUniqueMock },
  },
}))

// Dynamic import AFTER mock.module — static imports are hoisted above
// mock.module() and would load the real prisma module.
const { requireSuperAdmin } = await import('../middleware/super-admin')

// Minimal Hono Context shim — the middleware only uses c.get('auth') and c.json.
type Auth = { userId?: string } | undefined
type JsonCall = { body: unknown; status: number }

function makeCtx(auth: Auth) {
  const calls: JsonCall[] = []
  const ctx = {
    get: (key: string) => (key === 'auth' ? auth : undefined),
    json: (body: unknown, status: number) => {
      calls.push({ body, status })
      return { __type: 'response', body, status }
    },
  }
  return { ctx: ctx as unknown as Parameters<typeof requireSuperAdmin>[0], calls }
}

beforeEach(() => {
  findUniqueMock.mockReset()
  findUniqueMock.mockImplementation(async () => null)
})

describe('requireSuperAdmin', () => {
  test('returns 401 with unauthorized code when no auth context is set', async () => {
    const { ctx, calls } = makeCtx(undefined)
    const nextCalled = mock(async () => {})

    await requireSuperAdmin(ctx, nextCalled)

    expect(calls).toHaveLength(1)
    expect(calls[0].status).toBe(401)
    expect(calls[0].body).toEqual({
      error: { code: 'unauthorized', message: 'Authentication required' },
    })
    expect(nextCalled).not.toHaveBeenCalled()
    expect(findUniqueMock).not.toHaveBeenCalled()
  })

  test('returns 401 when auth context exists but has no userId', async () => {
    const { ctx, calls } = makeCtx({})
    const nextCalled = mock(async () => {})

    await requireSuperAdmin(ctx, nextCalled)

    expect(calls[0].status).toBe(401)
    expect(nextCalled).not.toHaveBeenCalled()
    expect(findUniqueMock).not.toHaveBeenCalled()
  })

  test('queries prisma for the role of the authenticated user', async () => {
    findUniqueMock.mockImplementation(async () => ({ role: 'super_admin' }))
    const { ctx } = makeCtx({ userId: 'user_lookup' })
    const next = mock(async () => {})

    await requireSuperAdmin(ctx, next)

    expect(findUniqueMock).toHaveBeenCalledTimes(1)
    const args = findUniqueMock.mock.calls[0][0]
    expect(args).toEqual({
      where: { id: 'user_lookup' },
      select: { role: true },
    })
  })

  test('calls next() when the user has the super_admin role', async () => {
    findUniqueMock.mockImplementation(async () => ({ role: 'super_admin' }))
    const { ctx, calls } = makeCtx({ userId: 'user_admin' })
    const next = mock(async () => {})

    await requireSuperAdmin(ctx, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(0) // no json response — middleware passed through
  })

  test('returns 403 forbidden when the user has a non-admin role', async () => {
    findUniqueMock.mockImplementation(async () => ({ role: 'user' }))
    const { ctx, calls } = makeCtx({ userId: 'user_regular' })
    const next = mock(async () => {})

    await requireSuperAdmin(ctx, next)

    expect(calls).toHaveLength(1)
    expect(calls[0].status).toBe(403)
    expect(calls[0].body).toEqual({
      error: { code: 'forbidden', message: 'Super admin access required' },
    })
    expect(next).not.toHaveBeenCalled()
  })

  test('returns 403 for an admin role that is NOT exactly "super_admin"', async () => {
    // Guard against role-typo bypasses: "admin", "superadmin", etc. must be rejected.
    for (const role of ['admin', 'superadmin', 'SUPER_ADMIN', 'Super_Admin', '']) {
      findUniqueMock.mockImplementation(async () => ({ role }))
      const { ctx, calls } = makeCtx({ userId: 'user_x' })
      const next = mock(async () => {})

      await requireSuperAdmin(ctx, next)

      expect(calls[0].status).toBe(403)
      expect(next).not.toHaveBeenCalled()
    }
  })

  test('returns 403 when the user does not exist in the database', async () => {
    findUniqueMock.mockImplementation(async () => null)
    const { ctx, calls } = makeCtx({ userId: 'user_ghost' })
    const next = mock(async () => {})

    await requireSuperAdmin(ctx, next)

    expect(calls[0].status).toBe(403)
    expect(calls[0].body).toEqual({
      error: { code: 'forbidden', message: 'Super admin access required' },
    })
    expect(next).not.toHaveBeenCalled()
  })

  test('returns 403 when prisma returns a user object with no role field', async () => {
    findUniqueMock.mockImplementation(async () => ({ role: null }))
    const { ctx, calls } = makeCtx({ userId: 'user_no_role' })
    const next = mock(async () => {})

    await requireSuperAdmin(ctx, next)

    expect(calls[0].status).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  test('propagates prisma errors (does NOT silently allow access)', async () => {
    findUniqueMock.mockImplementation(async () => {
      throw new Error('db connection lost')
    })
    const { ctx, calls } = makeCtx({ userId: 'user_db_fail' })
    const next = mock(async () => {})

    await expect(requireSuperAdmin(ctx, next)).rejects.toThrow('db connection lost')
    expect(next).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  test('checks auth first — empty userId short-circuits before any DB query', async () => {
    const { ctx } = makeCtx({ userId: '' })
    const next = mock(async () => {})

    await requireSuperAdmin(ctx, next)

    // Empty string is falsy → unauthorized path, no DB hit.
    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })
})
