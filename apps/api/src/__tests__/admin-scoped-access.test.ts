// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * End-to-end authorization matrix for the admin router.
 *
 * Uses the REAL requireSuperAdmin + requireAdminScope middleware (only auth +
 * prisma + the analytics service are mocked), so it verifies the actual
 * gating wired up in routes/admin.ts:
 *   - analytics usage endpoints  -> analytics:read
 *   - /creators                  -> creators:read | creators:write
 *   - /affiliates/*              -> creators:write
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
const marketingAdmin = { id: 'e', role: 'user', adminScopes: ['marketing:read'] }
const aiAdmin = { id: 'f', role: 'user', adminScopes: ['ai:read'] }
const creatorsWriteAdmin = { id: 'g', role: 'user', adminScopes: ['creators:write'] }

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
  // Returning null makes the content-application handler respond 404 (affiliate
  // not found) — which proves the request passed the creators:write gate rather
  // than being 403'd. Authorization, not handler logic, is what we assert here.
  affiliate: {
    findUnique: mock(async () => null),
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
  getUserFunnel: async () => ({}),
  getCreatorStats: async () => [],
  getCreatorProfileDetail: async () => ({ userId: 'x', listings: [], affiliate: null }),
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
const FUNNEL = '/api/admin/analytics/funnel'
const CREATORS = '/api/admin/creators'
const CREATOR_DETAIL = '/api/admin/creators/u_123'
const INFRA = '/api/admin/analytics/infra-current'
const HEARTBEATS = '/api/admin/heartbeats/overview'
const CONTENT_APPLICATION = '/api/admin/affiliates/aff_1/content-application'

/** POST an approve action to the (creators:write-gated) content-application route. */
function approveCreator(app: Hono) {
  return app.request(CONTENT_APPLICATION, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve' }),
  })
}

describe('admin scoped access matrix', () => {
  test('super_admin can reach analytics + creators endpoints', async () => {
    currentUser = superAdmin
    const app = createApp()
    expect((await app.request(OVERVIEW)).status).toBe(200)
    expect((await app.request(USAGE)).status).toBe(200)
    expect((await app.request(CREATORS)).status).toBe(200)
  })

  test('analytics:read umbrella sees both marketing + ai analytics but not creators or infra/heartbeats', async () => {
    currentUser = analyticsAdmin
    const app = createApp()
    expect((await app.request(OVERVIEW)).status).toBe(200)
    expect((await app.request(USAGE)).status).toBe(200)
    expect((await app.request(FUNNEL)).status).toBe(200)
    expect((await app.request(CREATORS)).status).toBe(403)
    expect((await app.request(CREATOR_DETAIL)).status).toBe(403)
    expect((await app.request(INFRA)).status).toBe(403)
    expect((await app.request(HEARTBEATS)).status).toBe(403)
  })

  test('marketing:read admin sees shared + marketing endpoints but not ai-only endpoints', async () => {
    currentUser = marketingAdmin
    const app = createApp()
    expect((await app.request(OVERVIEW)).status).toBe(200)
    expect((await app.request(FUNNEL)).status).toBe(200)
    expect((await app.request(USAGE)).status).toBe(403)
    expect((await app.request(CREATORS)).status).toBe(403)
    expect((await app.request(INFRA)).status).toBe(403)
  })

  test('ai:read admin sees shared + ai endpoints but not marketing-only endpoints', async () => {
    currentUser = aiAdmin
    const app = createApp()
    expect((await app.request(OVERVIEW)).status).toBe(200)
    expect((await app.request(USAGE)).status).toBe(200)
    expect((await app.request(FUNNEL)).status).toBe(403)
    expect((await app.request(CREATORS)).status).toBe(403)
    expect((await app.request(INFRA)).status).toBe(403)
  })

  test('creators:read admin sees creators list + detail but cannot approve creators', async () => {
    currentUser = creatorsAdmin
    const app = createApp()
    expect((await app.request(CREATORS)).status).toBe(200)
    expect((await app.request(CREATOR_DETAIL)).status).toBe(200)
    expect((await app.request(OVERVIEW)).status).toBe(403)
    expect((await app.request(USAGE)).status).toBe(403)
    expect((await app.request(INFRA)).status).toBe(403)
    // Read-only: the affiliate approval mutation is creators:write-gated.
    expect((await approveCreator(app)).status).toBe(403)
  })

  test('creators:write admin can view creators and approve them', async () => {
    currentUser = creatorsWriteAdmin
    const app = createApp()
    // Write holders can also view the creator surfaces (requireAnyScope).
    expect((await app.request(CREATORS)).status).toBe(200)
    expect((await app.request(CREATOR_DETAIL)).status).toBe(200)
    // 404 (affiliate not found) proves the request passed the gate, not 403.
    expect((await approveCreator(app)).status).toBe(404)
    // Still scoped: no analytics or infra access.
    expect((await app.request(OVERVIEW)).status).toBe(403)
    expect((await app.request(INFRA)).status).toBe(403)
  })

  test('marketing:read admin cannot approve creators', async () => {
    currentUser = marketingAdmin
    const app = createApp()
    expect((await approveCreator(app)).status).toBe(403)
  })

  test('super_admin can approve creators', async () => {
    currentUser = superAdmin
    const app = createApp()
    expect((await approveCreator(app)).status).toBe(404)
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
