// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Authorization + parameter handling for the engagement / work-activity
// endpoints in src/routes/scoped-analytics.ts. The aggregation itself is
// covered by lib/__tests__/engagement-compute.test.ts and
// services/__tests__/engagement-analytics.service.test.ts.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

let currentUserId: string | null = 'user_1'
mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => { c.set('auth', { userId: currentUserId }); await next() },
  requireAuth: async (_c: any, next: any) => next(),
}))

let members: Array<{ userId: string; workspaceId: string; role: string }> = []
mock.module('../lib/prisma', () => ({
  prisma: {
    member: {
      findFirst: async (args: any) =>
        members.find((m) => m.userId === args.where.userId && m.workspaceId === args.where.workspaceId) ?? null,
    },
    project: { findUnique: async () => null },
  },
}))

let isBusiness = true
mock.module('../services/billing.service', () => ({ isBusinessOrHigherPlan: async () => isBusiness }))
mock.module('../services/analytics.service', () => ({}))

const engagementSpies = {
  getEngagementStats: mock(async (..._: any[]): Promise<any> => ({ k: 'engagement' })),
  getTeamWork: mock(async (..._: any[]): Promise<any> => ({ k: 'team-work' })),
}
mock.module('../services/engagement-analytics.service', () => engagementSpies)

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
  currentUserId = 'user_1'
  delete process.env.SHOGO_LOCAL_MODE
  for (const spy of Object.values(engagementSpies)) spy.mockClear()
})

describe('GET /me/analytics/engagement', () => {
  test('is scoped to the caller, defaults to 30d, and passes the timezone through', async () => {
    const { status, body } = await get('/me/analytics/engagement?tz=America/Los_Angeles')
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, data: { k: 'engagement' } })
    expect(engagementSpies.getEngagementStats).toHaveBeenCalledWith(
      { userId: 'user_1' },
      '30d',
      'America/Los_Angeles',
    )
  })

  test('accepts the all-time period and falls back to 30d for unknown ones', async () => {
    await get('/me/analytics/engagement?period=all')
    await get('/me/analytics/engagement?period=forever')
    expect(engagementSpies.getEngagementStats.mock.calls[0][1]).toBe('all')
    expect(engagementSpies.getEngagementStats.mock.calls[1][1]).toBe('30d')
  })

  test('ignores a userId query param so nobody can read someone else through /me', async () => {
    await get('/me/analytics/engagement?userId=admin_1')
    expect(engagementSpies.getEngagementStats.mock.calls[0][0]).toEqual({ userId: 'user_1' })
  })
})

describe('GET /workspaces/:id/analytics/engagement', () => {
  const path = (qs = '') => `/workspaces/${WS}/analytics/engagement${qs}`

  test('non-members are rejected', async () => {
    currentUserId = 'stranger'
    expect((await get(path())).status).toBe(403)
    expect(engagementSpies.getEngagementStats).not.toHaveBeenCalled()
  })

  test('a member sees only themselves', async () => {
    const { status } = await get(path())
    expect(status).toBe(200)
    expect(engagementSpies.getEngagementStats.mock.calls[0][0]).toEqual({ workspaceId: WS, userId: 'user_1' })
  })

  test('a member cannot request another member', async () => {
    const { status } = await get(path('?userId=admin_1'))
    expect(status).toBe(403)
    expect(engagementSpies.getEngagementStats).not.toHaveBeenCalled()
  })

  test('a member may request their own id explicitly', async () => {
    const { status } = await get(path('?userId=user_1'))
    expect(status).toBe(200)
  })

  test.each(['admin_1', 'owner_1'])('%s can view the whole workspace', async (who) => {
    currentUserId = who
    await get(path())
    expect(engagementSpies.getEngagementStats.mock.calls[0][0]).toEqual({ workspaceId: WS, userId: undefined })
  })

  test('an admin can drill into one member', async () => {
    currentUserId = 'admin_1'
    await get(path('?userId=user_1&period=7d'))
    const call = engagementSpies.getEngagementStats.mock.calls[0]
    expect(call[0]).toEqual({ workspaceId: WS, userId: 'user_1' })
    expect(call[1]).toBe('7d')
  })

  test('is available on non-Business plans', async () => {
    isBusiness = false
    currentUserId = 'admin_1'
    expect((await get(path())).status).toBe(200)
  })

  test('service failures surface as analytics_failed', async () => {
    engagementSpies.getEngagementStats.mockImplementationOnce(async () => { throw new Error('boom') })
    const { status, body } = await get(path())
    expect(status).toBe(500)
    expect(body.error.code).toBe('analytics_failed')
  })
})

describe('GET /workspaces/:id/analytics/team-work', () => {
  const path = (qs = '') => `/workspaces/${WS}/analytics/team-work${qs}`

  test('members cannot see the team table', async () => {
    const { status } = await get(path())
    expect(status).toBe(403)
    expect(engagementSpies.getTeamWork).not.toHaveBeenCalled()
  })

  test('admins get it on a Business plan', async () => {
    currentUserId = 'admin_1'
    const { status, body } = await get(path('?period=7d&tz=Europe/London'))
    expect(status).toBe(200)
    expect(body.data).toEqual({ k: 'team-work' })
    expect(engagementSpies.getTeamWork).toHaveBeenCalledWith(WS, '7d', 'Europe/London')
  })

  test('is gated to Business and higher', async () => {
    isBusiness = false
    currentUserId = 'owner_1'
    const { status, body } = await get(path())
    expect(status).toBe(403)
    expect(body.error.code).toBe('plan_required')
    expect(engagementSpies.getTeamWork).not.toHaveBeenCalled()
  })

  test('non-members are rejected', async () => {
    currentUserId = 'stranger'
    expect((await get(path())).status).toBe(403)
  })
})
