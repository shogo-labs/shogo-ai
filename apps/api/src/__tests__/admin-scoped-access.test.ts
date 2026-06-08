// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * End-to-end authorization matrix for the admin router.
 *
 * Uses the REAL requireSuperAdmin + requireAdminScope middleware (only auth +
 * prisma + the analytics service are mocked), so it verifies the actual
 * gating wired up in routes/admin.ts:
 *   - analytics usage endpoints  -> analytics:read
 *   - /creators                  -> creators:read
 *   - infra + heartbeats         -> super_admin only
 *
 * Run: bun test apps/api/src/__tests__/admin-scoped-access.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const superAdmin = { id: 'a', role: 'super_admin', adminScopes: [] as string[] }
const analyticsAdmin = { id: 'b', role: 'user', adminScopes: ['analytics:read'] }
const creatorsAdmin = { id: 'c', role: 'user', adminScopes: ['creators:read'] }
const plainUser = { id: 'd', role: 'user', adminScopes: [] as string[] }

let currentUser: typeof superAdmin = superAdmin

const mockPrisma = {
  user: {
    findUnique: mock(async () => ({
      role: currentUser.role,
      adminScopes: currentUser.adminScopes,
    })),
  },
  infraSnapshot: {
    findFirst: mock(async () => null),
  },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))

mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { userId: currentUser.id, isAuthenticated: true })
    await next()
  },
  requireAuth: async (_c: any, next: any) => {
    await next()
  },
}))

// Stub the analytics service so authorized handlers return cleanly and this
// test stays focused on authorization, not aggregation logic.
mock.module('../services/analytics.service', () => ({
  getOverviewStats: async () => ({}),
  getUsageAnalytics: async () => ({}),
  getCreatorStats: async () => [],
}))

const { adminRoutes } = await import('../routes/admin')

function createApp() {
  const app = new Hono()
  app.route('/api/admin', adminRoutes())
  return app
}

beforeEach(() => {
  currentUser = superAdmin
})

const OVERVIEW = '/api/admin/analytics/overview'
const USAGE = '/api/admin/analytics/usage'
const CREATORS = '/api/admin/creators'
const INFRA = '/api/admin/analytics/infra-current'
const HEARTBEATS = '/api/admin/heartbeats/overview'

describe('admin scoped access matrix', () => {
  test('super_admin can reach analytics + creators endpoints', async () => {
    currentUser = superAdmin
    const app = createApp()
    expect((await app.request(OVERVIEW)).status).toBe(200)
    expect((await app.request(USAGE)).status).toBe(200)
    expect((await app.request(CREATORS)).status).toBe(200)
  })

  test('analytics:read admin sees analytics but not creators or infra/heartbeats', async () => {
    currentUser = analyticsAdmin
    const app = createApp()
    expect((await app.request(OVERVIEW)).status).toBe(200)
    expect((await app.request(USAGE)).status).toBe(200)
    expect((await app.request(CREATORS)).status).toBe(403)
    expect((await app.request(INFRA)).status).toBe(403)
    expect((await app.request(HEARTBEATS)).status).toBe(403)
  })

  test('creators:read admin sees creators but not analytics or infra', async () => {
    currentUser = creatorsAdmin
    const app = createApp()
    expect((await app.request(CREATORS)).status).toBe(200)
    expect((await app.request(OVERVIEW)).status).toBe(403)
    expect((await app.request(USAGE)).status).toBe(403)
    expect((await app.request(INFRA)).status).toBe(403)
  })

  test('a plain user is forbidden everywhere', async () => {
    currentUser = plainUser
    const app = createApp()
    expect((await app.request(OVERVIEW)).status).toBe(403)
    expect((await app.request(USAGE)).status).toBe(403)
    expect((await app.request(CREATORS)).status).toBe(403)
    expect((await app.request(INFRA)).status).toBe(403)
    expect((await app.request(HEARTBEATS)).status).toBe(403)
  })
})
