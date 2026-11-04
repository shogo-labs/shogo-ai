// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-311 acceptance 6 — the admin analytics endpoints are cached, and the key
 * covers every param that changes the answer.
 *
 * The admin dashboard fires 8–9 heavy requests on open and re-fires them on a
 * table page change. Without a cache each of those is a fresh window scan, and
 * they slow each other down. With the five-minute cache a repeat of the same
 * question must not reach the service at all — but a different `page`,
 * `period` or `excludeInternal` must.
 *
 * The service is mocked, so a case here fails only when the wrapper or its key
 * is wrong, never because a query got slow.
 *
 *   bun test apps/api/src/__tests__/admin-analytics-cache.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const adminUser = { id: 'admin-1', email: 'admin@shogo.ai', role: 'super_admin' }

mock.module('../lib/prisma', () => ({
  prisma: {
    user: { findUnique: async () => ({ role: 'super_admin', adminScopes: [] }) },
  },
}))

mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', adminUser)
    c.set('auth', { userId: adminUser.id, isAuthenticated: true })
    c.set('session', { id: 'sess-1' })
    await next()
  },
  requireAuth: async (_c: any, next: any) => {
    await next()
  },
}))

mock.module('../middleware/super-admin', () => ({
  requireSuperAdmin: async (_c: any, next: any) => {
    await next()
  },
}))

const svc = {
  getToolCallAnalytics: mock(async (..._: any[]): Promise<any> => ({ tools: [], totals: {} })),
  getUsageSummary: mock(async (..._: any[]): Promise<any> => ({ summaries: [], totals: {} })),
  getActiveUsersTimeseries: mock(async (..._: any[]): Promise<any> => []),
  getActivityTimeseries: mock(async (..._: any[]): Promise<any> => []),
  getWorkspaceActivityTable: mock(async (..._: any[]): Promise<any> => ({ workspaces: [] })),
  getUsageLog: mock(async (..._: any[]): Promise<any> => ({ entries: [] })),
}
mock.module('../services/analytics.service', () => svc)

const { adminRoutes } = await import('../routes/admin')
const { clearAnalyticsCache } = await import('../lib/analytics-cache')

function app() {
  const router = new Hono()
  router.route('/api/admin', adminRoutes())
  return router
}

beforeEach(() => {
  clearAnalyticsCache()
  for (const spy of Object.values(svc)) spy.mockClear()
})

async function get(path: string): Promise<void> {
  const res = await app().request(path)
  expect(res.status).toBe(200)
}

describe('admin analytics cache', () => {
  test('a repeated identical request does not reach the service', async () => {
    await get('/api/admin/analytics/tool-calls?period=30d&page=1&limit=10')
    await get('/api/admin/analytics/tool-calls?period=30d&page=1&limit=10')

    expect(svc.getToolCallAnalytics).toHaveBeenCalledTimes(1)
  })

  test('a different page misses, and the service sees the new page', async () => {
    await get('/api/admin/analytics/tool-calls?period=30d&page=1&limit=10')
    await get('/api/admin/analytics/tool-calls?period=30d&page=2&limit=10')

    expect(svc.getToolCallAnalytics).toHaveBeenCalledTimes(2)
    expect(svc.getToolCallAnalytics).toHaveBeenLastCalledWith(
      {},
      '30d',
      { excludeInternal: true, page: 2, limit: 10 },
    )
  })

  test('excludeInternal and period are part of the key', async () => {
    await get('/api/admin/analytics/usage-summary?period=30d')
    await get('/api/admin/analytics/usage-summary?period=30d&excludeInternal=false')
    await get('/api/admin/analytics/usage-summary?period=7d')

    expect(svc.getUsageSummary).toHaveBeenCalledTimes(3)
  })

  test('each panel has its own entry', async () => {
    await get('/api/admin/analytics/active-users-timeseries?period=30d')
    await get('/api/admin/analytics/activity-timeseries?period=30d')
    await get('/api/admin/analytics/active-users-timeseries?period=30d')

    expect(svc.getActiveUsersTimeseries).toHaveBeenCalledTimes(1)
    expect(svc.getActivityTimeseries).toHaveBeenCalledTimes(1)
  })

  test('the live usage log is never cached', async () => {
    await get('/api/admin/analytics/usage-log?period=30d&page=1')
    await get('/api/admin/analytics/usage-log?period=30d&page=1')

    expect(svc.getUsageLog).toHaveBeenCalledTimes(2)
  })

  test('workspace-activity keys on the page it rendered', async () => {
    await get('/api/admin/analytics/workspace-activity?period=30d&page=1&limit=20')
    await get('/api/admin/analytics/workspace-activity?period=30d&page=1&limit=20')
    await get('/api/admin/analytics/workspace-activity?period=30d&page=3&limit=20')

    expect(svc.getWorkspaceActivityTable).toHaveBeenCalledTimes(2)
  })
})
