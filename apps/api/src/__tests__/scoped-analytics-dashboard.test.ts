// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// `GET /workspaces/:workspaceId/analytics/dashboard` — the one request the
// Analytics Usage tab opens with (SHO-140).
//
// The important property here is the plan gate: the dashboard carries the same
// `usage` breakdown and `chat` stats that `/analytics/usage` and
// `/analytics/chat` refuse below Business, so it has to refuse them too — a
// member on a non-Business plan must not be able to read the gated numbers by
// asking the combined endpoint.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

let currentUserId: string | null = 'user_1'
mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => { c.set('auth', { userId: currentUserId }); await next() },
  requireAuth: async (_c: any, next: any) => next(),
}))

let members: Array<{ userId: string; workspaceId: string; role: string }> = []
mock.module('../lib/prisma', () => ({
  prisma: {
    user: { findUnique: async () => ({ role: 'user' }) },
    member: {
      findMany: async (args: any) =>
        members
          .filter((m) => m.userId === args.where.userId)
          .map((m) => ({ role: m.role, workspaceId: m.workspaceId, projectId: null, isBillingAdmin: false })),
      findFirst: async (args: any) =>
        members.find((m) => m.userId === args.where.userId && m.workspaceId === args.where.workspaceId) ?? null,
    },
    project: { findUnique: async () => null },
  },
}))

let isBusiness = true
mock.module('../services/billing.service', () => ({ isBusinessOrHigherPlan: async () => isBusiness }))

const dashboardPayload = {
  window: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-22T00:00:00.000Z', period: '30d' },
  summary: { summaries: [], totals: { totalRequests: 0 }, total: 0, page: 1, limit: 50 },
  timeseries: { days: [], totals: {}, models: [], groupBy: 'model', metric: 'spend' },
  usage: { actionBreakdown: [], totalSpendUsd: 12.5 },
  logCount: 7,
}

const svcSpies = {
  getUsageDashboard: mock(async (..._: any[]): Promise<any> => ({ ...dashboardPayload })),
  getChatAnalytics: mock(async (..._: any[]): Promise<any> => ({ totalSessions: 3 })),
  getUsageAnalytics: mock(async (..._: any[]): Promise<any> => ({ actionBreakdown: [] })),
}
mock.module('../services/analytics.service', () => svcSpies)

mock.module('../services/engagement-analytics.service', () => ({
  getEngagementStats: async () => ({}),
  getTeamWork: async () => ({}),
}))

const { scopedAnalyticsRoutes } = await import('../routes/scoped-analytics')

const WS = 'ws_1'

async function call(path: string) {
  const res = await scopedAnalyticsRoutes().fetch(new Request(`http://test${path}`))
  const text = await res.clone().text()
  let body: any = {}
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

beforeEach(() => {
  members = [{ userId: 'user_1', workspaceId: WS, role: 'admin' }]
  isBusiness = true
  currentUserId = 'user_1'
  delete process.env.SHOGO_LOCAL_MODE
  for (const k of Object.keys(svcSpies)) (svcSpies as any)[k].mockClear()
})

afterEach(() => { delete process.env.SHOGO_LOCAL_MODE })

describe('GET /workspaces/:workspaceId/analytics/dashboard', () => {
  test('Business: returns the whole tab from one service call, chat included', async () => {
    const { status, body } = await call(`/workspaces/${WS}/analytics/dashboard?period=7d&groupBy=user&metric=tokens&page=2`)

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.data.summary).toEqual(dashboardPayload.summary)
    expect(body.data.timeseries).toEqual(dashboardPayload.timeseries)
    expect(body.data.usage).toEqual(dashboardPayload.usage)
    expect(body.data.logCount).toBe(7)
    expect(body.data.chat).toEqual({ totalSessions: 3 })

    expect(svcSpies.getUsageDashboard).toHaveBeenCalledTimes(1)
    const [scope, options] = svcSpies.getUsageDashboard.mock.calls[0] as any[]
    expect(scope).toEqual({ workspaceId: WS })
    expect(options).toMatchObject({ period: '7d', groupBy: 'user', metric: 'tokens', page: 2, limit: 50 })
    expect(svcSpies.getChatAnalytics).toHaveBeenCalledWith({ workspaceId: WS }, '7d')
  })

  test('below Business: the gated usage breakdown and chat stats come back null', async () => {
    isBusiness = false
    const { status, body } = await call(`/workspaces/${WS}/analytics/dashboard`)

    expect(status).toBe(200)
    // What everyone is entitled to is still there...
    expect(body.data.summary).toEqual(dashboardPayload.summary)
    expect(body.data.timeseries).toEqual(dashboardPayload.timeseries)
    expect(body.data.logCount).toBe(7)
    // ...and the Business-only parts are withheld, not merely hidden client-side.
    expect(body.data.usage).toBeNull()
    expect(body.data.chat).toBeNull()
    expect(svcSpies.getChatAnalytics).not.toHaveBeenCalled()
  })

  test('below Business the gated endpoints still 403, so the two agree', async () => {
    isBusiness = false
    const dashboard = await call(`/workspaces/${WS}/analytics/dashboard`)
    const usage = await call(`/workspaces/${WS}/analytics/usage`)

    expect(dashboard.status).toBe(200)
    expect(dashboard.body.data.usage).toBeNull()
    expect(usage.status).toBe(403)
    expect(usage.body.error.code).toBe('plan_required')
  })

  test('local mode has no plan, so the breakdown is always present', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    isBusiness = false
    const { status, body } = await call(`/workspaces/${WS}/analytics/dashboard`)

    expect(status).toBe(200)
    expect(body.data.usage).toEqual(dashboardPayload.usage)
    expect(body.data.chat).toEqual({ totalSessions: 3 })
  })

  test('a member is scoped to their own rows, and cannot name another member', async () => {
    members = [{ userId: 'user_1', workspaceId: WS, role: 'member' }]

    const own = await call(`/workspaces/${WS}/analytics/dashboard`)
    expect(own.status).toBe(200)
    expect((svcSpies.getUsageDashboard.mock.calls[0] as any[])[0]).toEqual({ workspaceId: WS, userId: 'user_1' })
    // Members have no chat analytics permission either: same Business gate.
    expect(own.body.data.chat).toEqual({ totalSessions: 3 })

    const other = await call(`/workspaces/${WS}/analytics/dashboard?userId=user_2`)
    expect(other.status).toBe(403)
    expect(other.body.error.code).toBe('forbidden')
  })

  test('a non-member gets 403 forbidden', async () => {
    members = []
    const { status, body } = await call(`/workspaces/${WS}/analytics/dashboard`)
    expect(status).toBe(403)
    expect(body.error.code).toBe('forbidden')
    expect(svcSpies.getUsageDashboard).not.toHaveBeenCalled()
  })

  test('a service failure is a 500 analytics_failed, not a half-rendered tab', async () => {
    svcSpies.getUsageDashboard.mockImplementationOnce(async () => { throw new Error('boom') })
    const { status, body } = await call(`/workspaces/${WS}/analytics/dashboard`)
    expect(status).toBe(500)
    expect(body.error.code).toBe('analytics_failed')
    expect(body.error.message).toBe('boom')
  })
})
