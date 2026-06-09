// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PATCH /api/admin/users/:id/admin-access — assigning granular admin scopes.
 * This action is super_admin-only (partial admins must not self-escalate) and
 * validates scope ids against the catalog.
 *
 * Run: bun test apps/api/src/__tests__/admin-user-access-route.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// Role of the *acting* (authenticated) user; toggled per test.
let actingRole = 'super_admin'
let actingScopes: string[] = []

const updateMock = mock(async (args: any) => ({
  id: args.where.id,
  role: 'user',
  adminScopes: args.data.adminScopes,
}))

const mockPrisma = {
  user: {
    findUnique: mock(async (args: any) => ({
      id: args.where.id,
      role: actingRole,
      adminScopes: actingScopes,
    })),
    update: updateMock,
  },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))

mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { userId: 'acting-user', isAuthenticated: true })
    await next()
  },
  requireAuth: async (_c: any, next: any) => {
    await next()
  },
}))

const { adminRoutes } = await import('../routes/admin')

function createApp() {
  const app = new Hono()
  app.route('/api/admin', adminRoutes())
  return app
}

function patch(scopes: unknown) {
  return createApp().request('/api/admin/users/target-1/admin-access', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scopes }),
  })
}

beforeEach(() => {
  actingRole = 'super_admin'
  actingScopes = []
  updateMock.mockClear()
})

describe('PATCH /api/admin/users/:id/admin-access', () => {
  test('super_admin can grant a valid scope', async () => {
    const res = await patch(['analytics:read'])
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.data.adminScopes).toEqual(['analytics:read'])
    expect(updateMock).toHaveBeenCalledTimes(1)
    expect(updateMock.mock.calls[0][0].data.adminScopes).toEqual(['analytics:read'])
  })

  test('super_admin can clear all scopes with an empty array', async () => {
    const res = await patch([])
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.adminScopes).toEqual([])
    expect(updateMock.mock.calls[0][0].data.adminScopes).toEqual([])
  })

  test('rejects unknown scope ids without mutating', async () => {
    const res = await patch(['foo:bar'])
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.error.code).toBe('invalid_scopes')
    expect(updateMock).not.toHaveBeenCalled()
  })

  test('rejects a non-array scopes payload', async () => {
    const res = await patch('analytics:read')
    expect(res.status).toBe(400)
    expect(updateMock).not.toHaveBeenCalled()
  })

  test('forbids a non-super-admin, even one holding scopes (no self-escalation)', async () => {
    actingRole = 'user'
    actingScopes = ['analytics:read']
    const res = await patch(['creators:read'])
    expect(res.status).toBe(403)
    expect(updateMock).not.toHaveBeenCalled()
  })
})
