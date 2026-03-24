// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Analytics Routes Tests
 *
 * In-process Hono tests for the new admin analytics endpoints.
 * Mocks Prisma and auth middleware.
 *
 * Run: bun test apps/api/src/__tests__/analytics-routes.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

const mockPrisma = {
  $queryRawUnsafe: mock(() => Promise.resolve([])),
  user: {
    findMany: mock(() => Promise.resolve([])),
    count: mock(() => Promise.resolve(0)),
  },
  project: {
    groupBy: mock(() => Promise.resolve([])),
  },
  chatMessage: {
    groupBy: mock(() => Promise.resolve([])),
  },
  usageEvent: {
    groupBy: mock(() => Promise.resolve([])),
  },
  analyticsDigest: {
    findFirst: mock(() => Promise.resolve(null)),
    findMany: mock(() => Promise.resolve([])),
  },
}

const adminUser = { id: 'admin-1', email: 'admin@shogo.ai', role: 'super_admin' }
const regularUser = { id: 'user-1', email: 'user@example.com', role: 'user' }
let currentUser = adminUser

mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))

mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', currentUser)
    c.set('session', { id: 'sess-1' })
    await next()
  },
  requireAuth: async (_c: any, next: any) => { await next() },
}))

mock.module('../middleware/super-admin', () => ({
  requireSuperAdmin: async (c: any, next: any) => {
    const user = c.get('user')
    if (user?.role !== 'super_admin') {
      return c.json({ error: 'forbidden' }, 403)
    }
    await next()
  },
}))

const { adminRoutes } = await import('../routes/admin')

function createApp() {
  const app = new Hono()
  app.route('/api/admin', adminRoutes())
  return app
}

beforeEach(() => {
  currentUser = adminUser
  for (const key of Object.keys(mockPrisma)) {
    const val = (mockPrisma as any)[key]
    if (typeof val === 'function' && val.mockReset) val.mockReset()
    if (typeof val === 'object' && val !== null) {
      for (const method of Object.keys(val)) {
        if (typeof val[method]?.mockReset === 'function') val[method].mockReset()
      }
    }
  }
  // Default mock returns
  mockPrisma.$queryRawUnsafe.mockResolvedValue([{
    signups: 5, onboarded: 4, createdProject: 3,
    sentMessage: 2, engaged: 1, avgMinToFirstProject: 10, avgMinToFirstMessage: 20,
  }])
  mockPrisma.user.findMany.mockResolvedValue([])
  mockPrisma.user.count.mockResolvedValue(0)
  mockPrisma.analyticsDigest.findFirst.mockResolvedValue(null)
  mockPrisma.analyticsDigest.findMany.mockResolvedValue([])
})

describe('Admin analytics routes', () => {
  describe('GET /api/admin/analytics/funnel', () => {
    test('returns funnel data for admin', async () => {
      const app = createApp()
      const res = await app.request('/api/admin/analytics/funnel?period=30d')
      expect(res.status).toBe(200)
      const body = await res.json() as any
      expect(body.ok).toBe(true)
      expect(body.data.signups).toBe(5)
      expect(body.data.engaged).toBe(1)
    })

    test('rejects non-admin users', async () => {
      currentUser = regularUser
      const app = createApp()
      const res = await app.request('/api/admin/analytics/funnel')
      expect(res.status).toBe(403)
    })
  })

  describe('GET /api/admin/analytics/user-activity', () => {
    test('returns paginated user list', async () => {
      const app = createApp()
      mockPrisma.user.findMany.mockResolvedValueOnce([])
      mockPrisma.user.count.mockResolvedValueOnce(0)
      mockPrisma.project.groupBy.mockResolvedValueOnce([])
      mockPrisma.$queryRawUnsafe
        .mockResolvedValueOnce([]) // message counts
        .mockResolvedValueOnce([]) // session counts
        .mockResolvedValueOnce([]) // tool call counts
      mockPrisma.usageEvent.groupBy.mockResolvedValueOnce([])

      const res = await app.request('/api/admin/analytics/user-activity?page=1&limit=10')
      expect(res.status).toBe(200)
      const body = await res.json() as any
      expect(body.ok).toBe(true)
    })
  })

  describe('GET /api/admin/analytics/template-engagement', () => {
    test('returns template stats', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        { templateId: 'tpl-1', projects: 5, avgMessages: 3.5, totalToolCalls: 20, engagedUsers: 4, totalUsers: 5 },
      ])

      const app = createApp()
      const res = await app.request('/api/admin/analytics/template-engagement')
      expect(res.status).toBe(200)
      const body = await res.json() as any
      expect(body.ok).toBe(true)
      expect(body.data.templates).toBeArray()
    })
  })

  describe('GET /api/admin/analytics/source-breakdown', () => {
    test('returns source breakdown', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        { tag: 'direct', count: 5, withProject: 3, withMessage: 1 },
      ])

      const app = createApp()
      const res = await app.request('/api/admin/analytics/source-breakdown')
      expect(res.status).toBe(200)
      const body = await res.json() as any
      expect(body.ok).toBe(true)
      expect(body.data.sources).toBeArray()
    })
  })

  describe('GET /api/admin/analytics/ai-digest', () => {
    test('returns latest digest', async () => {
      mockPrisma.analyticsDigest.findFirst.mockResolvedValueOnce({
        id: 'digest-1',
        date: new Date('2026-03-23'),
        funnelSignups: 10,
        activeUsers: 5,
        aiInsights: { takeaways: ['Insight 1'] },
      })

      const app = createApp()
      const res = await app.request('/api/admin/analytics/ai-digest')
      expect(res.status).toBe(200)
      const body = await res.json() as any
      expect(body.ok).toBe(true)
      expect(body.data.funnelSignups).toBe(10)
    })

    test('returns null when no digest exists', async () => {
      const app = createApp()
      const res = await app.request('/api/admin/analytics/ai-digest')
      expect(res.status).toBe(200)
      const body = await res.json() as any
      expect(body.data).toBeNull()
    })
  })

  describe('GET /api/admin/analytics/ai-digest/list', () => {
    test('returns list of digests', async () => {
      mockPrisma.analyticsDigest.findMany.mockResolvedValueOnce([
        { id: 'd1', date: new Date('2026-03-23'), funnelSignups: 10, funnelEngaged: 3, activeUsers: 5, totalMessages: 20, messagesAnalyzed: 15, createdAt: new Date() },
        { id: 'd2', date: new Date('2026-03-22'), funnelSignups: 8, funnelEngaged: 2, activeUsers: 4, totalMessages: 15, messagesAnalyzed: 10, createdAt: new Date() },
      ])

      const app = createApp()
      const res = await app.request('/api/admin/analytics/ai-digest/list?limit=7')
      expect(res.status).toBe(200)
      const body = await res.json() as any
      expect(body.ok).toBe(true)
      expect(body.data).toHaveLength(2)
    })
  })
})
