// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const analyticsCalls: Array<[string, any[]]> = []
const scheduler = {
  paused: false,
  getStats: mock(() => ({ running: true, totalTicks: 3 })),
  getBreakerSnapshot: mock(() => [{ projectId: 'project-1', count: 2, backoffUntil: 123 }]),
  pause: mock(() => { scheduler.paused = true }),
  resume: mock(() => { scheduler.paused = false }),
  isPaused: mock(() => scheduler.paused),
  triggerNow: mock(async () => ({ ok: true })),
  clearFailures: mock(() => {}),
}

mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'user-1' })
    await next()
  },
  requireAuth: async (_c: any, next: any) => next(),
}))

mock.module('../middleware/super-admin', () => ({
  requireSuperAdmin: async (_c: any, next: any) => next(),
}))

mock.module('../services/analytics.service', () => {
  const record = (name: string, value: any) => mock(async (...args: any[]) => {
    analyticsCalls.push([name, args])
    return value
  })
  return {
    getOverviewStats: record('overview', { users: 1 }),
    getGrowthTimeSeries: record('growth', [{ day: '2026-01-01' }]),
    getUsageAnalytics: record('usage', { totalUsd: 2 }),
    getActiveUsers: record('activeUsers', { dau: 3 }),
    getChatAnalytics: record('chat', { messages: 4 }),
    getProjectAnalytics: record('projects', { total: 5 }),
    getBillingAnalytics: record('billing', { mrr: 6 }),
    getUsageLog: record('usageLog', { rows: [] }),
    getUsageSummary: record('usageSummary', { rows: [] }),
    getUserFunnel: record('funnel', { signups: 7 }),
    getUserActivityTable: record('userActivity', { users: [] }),
    getTemplateEngagement: record('templateEngagement', { templates: [] }),
    getSourceBreakdown: record('sourceBreakdown', { sources: [] }),
    deriveSourceTag: mock(() => 'google:cpc'),
  }
})

mock.module('../lib/admin-heartbeat', () => ({
  getActiveHeartbeatScheduler: mock(async () => scheduler),
  getSchedulerKind: mock(() => 'local'),
}))

mock.module('../lib/warm-pool-controller', () => ({
  getWarmPoolController: mock(() => ({
    getExtendedStatus: mock(async () => ({
      cluster: { nodes: 2 },
      enabled: true,
      available: 3,
      assigned: 1,
      targetSize: 4,
      gcStats: { scanned: 5 },
    })),
  })),
}))

mock.module('../lib/analytics-digest-collector', () => ({
  generateDigest: mock(async () => ({ id: 'generated-digest' })),
}))

const prisma = {
  infraSnapshot: {
    findFirst: mock(async () => ({ id: 'snapshot-1' })),
    findMany: mock(async () => [{ timestamp: new Date('2026-01-01T00:00:00Z') }]),
  },
  analyticsDigest: {
    findFirst: mock(async () => ({ id: 'digest-1' })),
    findMany: mock(async () => [{ id: 'digest-list-1' }]),
  },
  agentConfig: {
    count: mock(async () => 4),
    findUnique: mock(async () => ({
      id: 'config-1',
      projectId: 'project-1',
      heartbeatEnabled: false,
      heartbeatInterval: 300,
    })),
    findMany: mock(async () => [{
      id: 'config-1',
      projectId: 'project-1',
      heartbeatEnabled: true,
      heartbeatInterval: 300,
      nextHeartbeatAt: new Date('2026-01-01T00:00:00Z'),
      lastHeartbeatAt: null,
      quietHoursStart: null,
      quietHoursEnd: null,
      quietHoursTimezone: null,
      modelProvider: 'anthropic',
      modelName: 'claude',
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      project: {
        id: 'project-1',
        name: 'Project',
        workspaceId: 'workspace-1',
        workspace: { id: 'workspace-1', name: 'Workspace', slug: 'workspace' },
      },
    }]),
    update: mock(async ({ data }: any) => ({
      id: 'config-1',
      projectId: 'project-1',
      heartbeatEnabled: data.heartbeatEnabled ?? true,
      heartbeatInterval: data.heartbeatInterval ?? 300,
      nextHeartbeatAt: data.nextHeartbeatAt ?? null,
      lastHeartbeatAt: null,
      quietHoursStart: data.quietHoursStart ?? null,
      quietHoursEnd: data.quietHoursEnd ?? null,
      quietHoursTimezone: data.quietHoursTimezone ?? null,
      modelProvider: 'anthropic',
      modelName: 'claude',
    })),
  },
  project: {
    findMany: mock(async () => [{
      id: 'project-1',
      name: 'Project',
      workspace: { name: 'Workspace' },
    }]),
  },
  signupAttribution: {
    upsert: mock(async () => ({})),
  },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma }))

let adminRoutes: typeof import('../routes/admin').adminRoutes
let userAttributionRoute: typeof import('../routes/admin').userAttributionRoute

beforeEach(async () => {
  analyticsCalls.length = 0
  scheduler.paused = false
  for (const value of Object.values(scheduler)) {
    if (typeof value === 'function' && 'mockClear' in value) (value as any).mockClear()
  }
  const mod = await import('../routes/admin')
  adminRoutes = mod.adminRoutes
  userAttributionRoute = mod.userAttributionRoute
})

async function json(res: Response) {
  return res.json() as Promise<any>
}

describe('adminRoutes analytics endpoints', () => {
  test('returns success payloads for analytics endpoints and forwards query options', async () => {
    const app = adminRoutes()
    const paths = [
      '/analytics/overview',
      '/analytics/growth?period=7d',
      '/analytics/usage?period=24h',
      '/analytics/active-users?period=30d',
      '/analytics/chat?period=7d',
      '/analytics/projects',
      '/analytics/billing',
      '/analytics/usage-log?period=7d&page=2&limit=10&userId=u1&model=claude',
      '/analytics/usage-summary?period=24h',
      '/analytics/funnel?period=7d&excludeInternal=false',
      '/analytics/user-activity?period=7d&page=3&limit=5&sort=spend&excludeInternal=false',
      '/analytics/template-engagement?excludeInternal=false',
      '/analytics/source-breakdown?period=24h&excludeInternal=false',
    ]

    for (const path of paths) {
      const body = await json(await app.request(`http://api.test${path}`))
      expect(body.ok).toBe(true)
    }

    expect(analyticsCalls.map(([name]) => name)).toContain('usageLog')
    expect(analyticsCalls.find(([name]) => name === 'usageLog')?.[1][2]).toEqual({
      page: 2,
      limit: 10,
      userId: 'u1',
      model: 'claude',
    })
    expect(analyticsCalls.find(([name]) => name === 'funnel')?.[1]).toEqual(['7d', false])
  })

  test('returns errors from analytics handlers as 500 responses', async () => {
    const mod = await import('../services/analytics.service')
    ;(mod.getOverviewStats as any).mockImplementationOnce(async () => {
      throw new Error('boom')
    })

    const res = await adminRoutes().request('http://api.test/analytics/overview')
    const body = await json(res)

    expect(res.status).toBe(500)
    expect(body.error).toMatchObject({ code: 'analytics_failed', message: 'boom' })
  })
})

describe('adminRoutes infra and digest endpoints', () => {
  test('returns infra snapshots and digest data', async () => {
    const app = adminRoutes()

    expect(await json(await app.request('http://api.test/analytics/infra-current')))
      .toMatchObject({ ok: true, data: { snapshot: { id: 'snapshot-1' } } })
    expect(await json(await app.request('http://api.test/analytics/infra-history?period=6h')))
      .toMatchObject({ ok: true, data: [{ timestamp: expect.any(String) }] })
    expect(await json(await app.request('http://api.test/analytics/ai-digest?date=2026-01-01')))
      .toMatchObject({ ok: true, data: { id: 'digest-1' } })
    expect(await json(await app.request('http://api.test/analytics/ai-digest/list?limit=500')))
      .toMatchObject({ ok: true, data: [{ id: 'digest-list-1' }] })
    expect(await json(await app.request('http://api.test/analytics/ai-digest/generate', { method: 'POST' })))
      .toMatchObject({ ok: true, data: { id: 'generated-digest' } })

    expect(prisma.analyticsDigest.findMany.mock.calls[0][0].take).toBe(90)
  })
})

describe('adminRoutes heartbeat endpoints', () => {
  test('reports overview and list data with breaker enrichment', async () => {
    const app = adminRoutes()

    const overview = await json(await app.request('http://api.test/heartbeats/overview'))
    expect(overview).toMatchObject({
      ok: true,
      data: {
        kind: 'local',
        counts: { enabled: 4, total: 4, dueNow: 4, inBackoff: 1 },
        backoff: [{ projectId: 'project-1', projectName: 'Project', workspaceName: 'Workspace' }],
      },
    })

    const list = await json(await app.request(
      'http://api.test/heartbeats?page=2&pageSize=10&search=work&enabledOnly=true&dueWithinSec=60&inBackoff=true&sort=projectName',
    ))
    expect(list).toMatchObject({
      ok: true,
      data: {
        page: 2,
        pageSize: 10,
        total: 4,
        rows: [{ projectId: 'project-1', breaker: { count: 2, backoffUntil: 123 } }],
      },
    })
  })

  test('pauses, resumes, triggers, patches, and clears failures', async () => {
    const app = adminRoutes()

    expect(await json(await app.request('http://api.test/heartbeats/scheduler/pause', { method: 'POST' })))
      .toEqual({ ok: true, data: { paused: true } })
    expect(await json(await app.request('http://api.test/heartbeats/scheduler/resume', { method: 'POST' })))
      .toEqual({ ok: true, data: { paused: false } })
    expect(await json(await app.request('http://api.test/heartbeats/projects/project-1/trigger', { method: 'POST' })))
      .toEqual({ ok: true, data: { ok: true } })
    expect(await json(await app.request('http://api.test/heartbeats/projects/project-1/clear-failures', { method: 'POST' })))
      .toEqual({ ok: true })

    const invalid = await app.request('http://api.test/heartbeats/projects/project-1', {
      method: 'PATCH',
      body: JSON.stringify({ heartbeatInterval: 30 }),
      headers: { 'content-type': 'application/json' },
    })
    expect(invalid.status).toBe(400)

    const patched = await json(await app.request('http://api.test/heartbeats/projects/project-1', {
      method: 'PATCH',
      body: JSON.stringify({
        heartbeatEnabled: true,
        heartbeatInterval: 120,
        quietHoursStart: '',
        quietHoursEnd: '18:00',
        quietHoursTimezone: 'UTC',
      }),
      headers: { 'content-type': 'application/json' },
    }))
    expect(patched.ok).toBe(true)
    expect(prisma.agentConfig.update.mock.calls.at(-1)[0].data).toMatchObject({
      heartbeatEnabled: true,
      heartbeatInterval: 120,
      quietHoursStart: null,
      quietHoursEnd: '18:00',
      quietHoursTimezone: 'UTC',
    })
  })

  test('returns not_found for missing heartbeat config', async () => {
    prisma.agentConfig.findUnique.mockImplementationOnce(async () => null)

    const res = await adminRoutes().request('http://api.test/heartbeats/projects/missing/trigger', { method: 'POST' })
    const body = await json(res)

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('not_found')
  })
})

describe('userAttributionRoute', () => {
  test('upserts attribution for the authenticated user', async () => {
    const res = await userAttributionRoute().request('http://api.test/users/me/attribution', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'launch',
        referrer: 'https://example.com',
        landingPage: '/home',
        method: 'signup',
      }),
    })

    expect(await json(res)).toEqual({ ok: true })
    expect(prisma.signupAttribution.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      create: expect.objectContaining({
        userId: 'user-1',
        utmSource: 'google',
        utmMedium: 'cpc',
        sourceTag: 'google:cpc',
      }),
      update: {},
    })
  })
})
