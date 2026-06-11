// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression test for the generated-router middleware-leakage bug.
 *
 * In production both the generated CRUD router (createAdminRoutes, gated by a
 * blanket super_admin via `use("*", …)`) and the hand-written adminRoutes()
 * (scope-gated) are mounted at the SAME /api/admin prefix. Hono folds the
 * generated router's wildcard middleware into the parent chain for that
 * prefix, so the blanket super_admin gate ALSO runs for the scope-delegated
 * analytics/creators routes — 403'ing partial admins before requireAdminScope
 * can run.
 *
 * The single-router tests (admin-scoped-access.test.ts) mount only
 * adminRoutes() and therefore never exercised this interaction. This test
 * reproduces the real wiring and asserts that:
 *   - requireSuperAdminUnlessScoped defers /creators + /analytics/* to the
 *     custom scope gate, so scoped admins get through;
 *   - infra + generated CRUD stay super_admin-only.
 *
 * Run: bun test apps/api/src/__tests__/admin-router-mount-leakage.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const superAdmin = { id: 'a', role: 'super_admin', adminScopes: [] as string[] }
const analyticsAdmin = { id: 'b', role: 'user', adminScopes: ['analytics:read'] }
const creatorsAdmin = { id: 'c', role: 'user', adminScopes: ['creators:read'] }
const bothAdmin = { id: 'e', role: 'user', adminScopes: ['analytics:read', 'creators:read'] }
const plainUser = { id: 'd', role: 'user', adminScopes: [] as string[] }

let currentUser: typeof superAdmin = superAdmin

const mockPrisma = {
  user: {
    findUnique: mock(async () => ({
      role: currentUser.role,
      adminScopes: currentUser.adminScopes,
    })),
    findMany: mock(async () => []),
    count: mock(async () => 0),
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

mock.module('../services/analytics.service', () => ({
  getOverviewStats: async () => ({}),
  getUsageAnalytics: async () => ({}),
  getCreatorStats: async () => [],
  getCreatorProfileDetail: async () => ({ userId: 'x', listings: [], affiliate: null }),
}))

const { authMiddleware, requireAuth } = await import('../middleware/auth')
const { requireSuperAdminUnlessScoped } = await import('../middleware/admin-access')
const { adminRoutes } = await import('../routes/admin')
const { createAdminRoutes } = await import('../generated/admin-routes')

// Mirror server.ts: generated CRUD router first (blanket super_admin via the
// scope-aware gate), then the hand-written scope-gated router, both at
// /api/admin.
function createApp() {
  const app = new Hono()
  app.route(
    '/api/admin',
    createAdminRoutes({
      prisma: mockPrisma,
      middleware: [authMiddleware, requireAuth, requireSuperAdminUnlessScoped],
    }),
  )
  app.route('/api/admin', adminRoutes())
  return app
}

beforeEach(() => {
  currentUser = superAdmin
})

const OVERVIEW = '/api/admin/analytics/overview'
const USAGE = '/api/admin/analytics/usage'
const CREATORS = '/api/admin/creators'
const CREATOR_DETAIL = '/api/admin/creators/u_123'
const INFRA = '/api/admin/analytics/infra-current'
const USERS_CRUD = '/api/admin/users'

describe('admin router mount leakage (both routers at /api/admin)', () => {
  test('super_admin reaches scoped routes AND generated CRUD', async () => {
    currentUser = superAdmin
    const app = createApp()
    expect((await app.request(OVERVIEW)).status).toBe(200)
    expect((await app.request(CREATORS)).status).toBe(200)
    expect((await app.request(USERS_CRUD)).status).toBe(200)
  })

  test('admin with BOTH scopes reaches analytics + creators (the reported bug)', async () => {
    currentUser = bothAdmin
    const app = createApp()
    expect((await app.request(OVERVIEW)).status).toBe(200)
    expect((await app.request(USAGE)).status).toBe(200)
    expect((await app.request(CREATORS)).status).toBe(200)
    expect((await app.request(CREATOR_DETAIL)).status).toBe(200)
    // ...but is still blocked from super-admin-only surfaces.
    expect((await app.request(INFRA)).status).toBe(403)
    expect((await app.request(USERS_CRUD)).status).toBe(403)
  })

  test('analytics:read admin: analytics 200, creators 403, generated CRUD 403', async () => {
    currentUser = analyticsAdmin
    const app = createApp()
    expect((await app.request(OVERVIEW)).status).toBe(200)
    expect((await app.request(CREATORS)).status).toBe(403)
    expect((await app.request(CREATOR_DETAIL)).status).toBe(403)
    expect((await app.request(INFRA)).status).toBe(403)
    expect((await app.request(USERS_CRUD)).status).toBe(403)
  })

  test('creators:read admin: creators list + detail 200, analytics 403, generated CRUD 403', async () => {
    currentUser = creatorsAdmin
    const app = createApp()
    expect((await app.request(CREATORS)).status).toBe(200)
    expect((await app.request(CREATOR_DETAIL)).status).toBe(200)
    expect((await app.request(OVERVIEW)).status).toBe(403)
    expect((await app.request(USERS_CRUD)).status).toBe(403)
  })

  test('plain user is forbidden everywhere', async () => {
    currentUser = plainUser
    const app = createApp()
    expect((await app.request(OVERVIEW)).status).toBe(403)
    expect((await app.request(CREATORS)).status).toBe(403)
    expect((await app.request(CREATOR_DETAIL)).status).toBe(403)
    expect((await app.request(INFRA)).status).toBe(403)
    expect((await app.request(USERS_CRUD)).status).toBe(403)
  })
})
