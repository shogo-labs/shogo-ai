// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Authorization, plan gating and period handling for
// GET /workspaces/:id/analytics/channels in src/routes/scoped-analytics.ts.
// The aggregation itself is covered by conversation-channel-breakdown.integration.test.ts.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

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
          .filter((m) => (args.where.OR ? args.where.OR.some((o: any) => o.workspaceId === m.workspaceId) : !args.where.workspaceId || args.where.workspaceId === m.workspaceId))
          .map((m) => ({ role: m.role, workspaceId: m.workspaceId, projectId: null, isBillingAdmin: false })),
      findFirst: async (args: any) =>
        members.find((m) => m.userId === args.where.userId && m.workspaceId === args.where.workspaceId) ?? null,
    },
    project: { findUnique: async () => null },
  },
}))

let isBusiness = true
mock.module('../services/billing.service', () => ({ isBusinessOrHigherPlan: async () => isBusiness }))
mock.module('../services/analytics.service', () => ({}))

// Mirrors the real helper closely enough to read the span back out of the call.
const SPAN_DAYS: Record<string, number> = { '1d': 1, '7d': 7, '30d': 30, '90d': 90, '1y': 365, mtd: 17, last_month: 30, all: 730 }
const engagementWindow = mock((period: string) => {
  const to = new Date('2026-10-17T00:00:00.000Z')
  return { from: new Date(to.getTime() - (SPAN_DAYS[period] ?? 30) * 86_400_000), to }
})
mock.module('../services/engagement-analytics.service', () => ({
  engagementWindow,
  getTeamWork: mock(async () => ({})),
  getEngagementStats: mock(async () => ({})),
}))

const getChannelBreakdown = mock(async (..._: any[]): Promise<any> => ({
  workspaceId: 'ws_1',
  window: { from: '2026-10-10T00:00:00.000Z', to: '2026-10-17T00:00:00.000Z' },
  totals: { channels: 1, activeUsers: 2, messages: 4, humanMessages: 3, agentMessages: 1, bridgedMessages: 0, agentMentions: 1, bridgedShare: 0, messagesPerActiveUser: 1.5 },
  channels: [{ conversationId: 'conv_1', name: 'general', provider: 'shogo', bridged: false, messages: 4 }],
}))
mock.module('../services/conversation-metrics', () => ({ getChannelBreakdown }))

const { scopedAnalyticsRoutes } = await import('../routes/scoped-analytics')

const WS = 'ws_1'

async function get(path: string) {
  const res = await scopedAnalyticsRoutes().fetch(new Request(`http://test${path}`))
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any }
}

beforeEach(() => {
  members = [
    { userId: 'user_1', workspaceId: WS, role: 'member' },
    { userId: 'admin_1', workspaceId: WS, role: 'admin' },
    { userId: 'owner_1', workspaceId: WS, role: 'owner' },
  ]
  isBusiness = true
  currentUserId = 'admin_1'
  delete process.env.SHOGO_LOCAL_MODE
  getChannelBreakdown.mockClear()
})

const path = (qs = '') => `/workspaces/${WS}/analytics/channels${qs}`

describe('GET /workspaces/:id/analytics/channels', () => {
  test('an admin gets the per-channel breakdown for the requested period', async () => {
    const { status, body } = await get(path('?period=7d'))
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.data.period).toBe('7d')
    expect(body.data.channels).toHaveLength(1)
    expect(body.data.totals).toMatchObject({ channels: 1, activeUsers: 2 })

    const [workspaceId, window] = getChannelBreakdown.mock.calls[0]
    expect(workspaceId).toBe(WS)
    // 7d means the API resolved a real window, not the period string.
    const span = Date.parse(window.to.toISOString()) - Date.parse(window.from.toISOString())
    expect(Math.round(span / 86_400_000)).toBe(7)
  })

  test('owners see it too', async () => {
    currentUserId = 'owner_1'
    expect((await get(path())).status).toBe(200)
  })

  test('members without analytics:read are refused', async () => {
    currentUserId = 'user_1'
    const { status } = await get(path())
    expect(status).toBe(403)
    expect(getChannelBreakdown).not.toHaveBeenCalled()
  })

  test('non-members are refused', async () => {
    currentUserId = 'stranger'
    expect((await get(path())).status).toBe(403)
    expect(getChannelBreakdown).not.toHaveBeenCalled()
  })

  test('is gated to the Business plan', async () => {
    isBusiness = false
    const { status, body } = await get(path())
    expect(status).toBe(403)
    expect(body.error.code).toBe('plan_required')
    expect(getChannelBreakdown).not.toHaveBeenCalled()
  })

  test('an unknown period falls back to 30d', async () => {
    await get(path('?period=forever'))
    const window = getChannelBreakdown.mock.calls[0][1]
    const span = Date.parse(window.to.toISOString()) - Date.parse(window.from.toISOString())
    expect(Math.round(span / 86_400_000)).toBe(30)
  })

  test('accepts the all-time period', async () => {
    const { status } = await get(path('?period=all'))
    expect(status).toBe(200)
    expect(getChannelBreakdown).toHaveBeenCalledTimes(1)
  })

  test('service failures surface as analytics_failed', async () => {
    getChannelBreakdown.mockImplementationOnce(async () => { throw new Error('boom') })
    const { status, body } = await get(path())
    expect(status).toBe(500)
    expect(body.error.code).toBe('analytics_failed')
  })
})
