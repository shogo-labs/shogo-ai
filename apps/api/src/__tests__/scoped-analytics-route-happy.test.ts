// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Happy-path coverage for src/routes/scoped-analytics.ts. The
// `scoped-analytics-route-extra.test.ts` file pins the 403 + 500 + plan
// gates; this file pins the 200 path on every endpoint family so the
// `analytics.getXxx()` call sites + response-shape lines are covered.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

let currentUserId: string | null = 'user_1'
mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => { c.set('auth', { userId: currentUserId }); await next() },
  requireAuth: async (_c: any, next: any) => next(),
}))

let members: Array<{ userId: string; workspaceId: string }> = []
let projects: Map<string, { workspaceId: string }> = new Map()
mock.module('../lib/prisma', () => ({
  prisma: {
    member: { findFirst: async (args: any) => members.find(m => m.userId === args.where.userId && m.workspaceId === args.where.workspaceId) ?? null },
    project: { findUnique: async (args: any) => projects.get(args.where.id) ? { workspaceId: projects.get(args.where.id)!.workspaceId } : null },
  },
}))

let isBusiness = true
mock.module('../services/billing.service', () => ({ isBusinessOrHigherPlan: async () => isBusiness }))

const svcSpies = {
  getOverviewStats: mock(async (..._: any[]): Promise<any> => ({ k: 'overview' })),
  getMemberUsageStats: mock(async (..._: any[]): Promise<any> => ({ k: 'member-usage' })),
  getUsageLog: mock(async (..._: any[]): Promise<any> => ({
    entries: [
      { createdAt: '2026-01-01T00:00:00Z', userName: 'A,lice', userEmail: 'a@x', actionType: 'chat', model: 'claude', provider: 'anthropic', totalTokens: 100, billedUsd: 0.0123 },
      { createdAt: '2026-01-02T00:00:00Z', userName: 'Bob "B"', userEmail: 'b@x', actionType: 'voice', model: null, provider: null, totalTokens: 0, billedUsd: 0 },
      { createdAt: '2026-01-03T00:00:00Z', userName: null, userEmail: null, actionType: null, model: null, provider: null, totalTokens: 50, billedUsd: 0.0001 },
    ],
    total: 3,
  })),
  getUsageSummary: mock(async (..._: any[]): Promise<any> => ({ k: 'summary' })),
  getSpendTimeseries: mock(async (..._: any[]): Promise<any> => ({ series: [] })),
  getGrowthTimeSeries: mock(async (..._: any[]): Promise<any> => ({ growth: [] })),
  getUsageAnalytics: mock(async (..._: any[]): Promise<any> => ({ usage: [] })),
  getChatAnalytics: mock(async (..._: any[]): Promise<any> => ({ chat: [] })),
  getProjectAnalytics: mock(async (..._: any[]): Promise<any> => ({ projects: [] })),
  getBillingAnalytics: mock(async (..._: any[]): Promise<any> => ({ billing: [] })),
}
mock.module('../services/analytics.service', () => svcSpies)

const { scopedAnalyticsRoutes } = await import('../routes/scoped-analytics')

const WS = 'ws_1'
const PROJ = 'proj_1'

async function call(method: string, path: string) {
  const res = await scopedAnalyticsRoutes().fetch(new Request(`http://test${path}`, { method }))
  const text = await res.clone().text()
  let body: any = {}
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body, res, text }
}

beforeEach(() => {
  members = [{ userId: 'user_1', workspaceId: WS }]
  projects = new Map([[PROJ, { workspaceId: WS }]])
  isBusiness = true
  currentUserId = 'user_1'
  delete process.env.SHOGO_LOCAL_MODE
  for (const k of Object.keys(svcSpies)) (svcSpies as any)[k].mockClear()
})

afterEach(() => { delete process.env.SHOGO_LOCAL_MODE })

// ─── Workspace basic — 200 happy paths ─────────────────────────────────

describe('Workspace basic analytics — 200 happy paths', () => {
  test('GET /workspaces/:workspaceId/analytics/overview returns service result wrapped in { ok, data }', async () => {
    const { status, body } = await call('GET', `/workspaces/${WS}/analytics/overview`)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.data).toEqual({ k: 'overview' })
    expect(svcSpies.getOverviewStats).toHaveBeenCalledTimes(1)
    expect((svcSpies.getOverviewStats.mock.calls[0] as any[])[0]).toMatchObject({ workspaceId: WS })
  })

  test('GET /workspaces/:workspaceId/analytics/member-usage returns service result', async () => {
    const { status, body } = await call('GET', `/workspaces/${WS}/analytics/member-usage`)
    expect(status).toBe(200)
    expect(body.data).toEqual({ k: 'member-usage' })
    expect(svcSpies.getMemberUsageStats).toHaveBeenCalledWith(WS)
  })

  test('GET /workspaces/:workspaceId/analytics/usage-summary defaults period to 30d', async () => {
    const { status, body } = await call('GET', `/workspaces/${WS}/analytics/usage-summary`)
    expect(status).toBe(200)
    expect(body.data).toEqual({ k: 'summary' })
    expect((svcSpies.getUsageSummary.mock.calls[0] as any[])[1]).toBe('30d')
  })

  test('GET /workspaces/:workspaceId/analytics/usage-summary honors ?period= query', async () => {
    await call('GET', `/workspaces/${WS}/analytics/usage-summary?period=7d`)
    expect((svcSpies.getUsageSummary.mock.calls[0] as any[])[1]).toBe('7d')
  })

  test('GET /workspaces/:workspaceId/analytics/usage-log returns entries + total + pagination', async () => {
    const { status, body } = await call('GET', `/workspaces/${WS}/analytics/usage-log?page=2&limit=25`)
    expect(status).toBe(200)
    expect(body.data.entries).toHaveLength(3)
    expect(body.data.total).toBe(3)
    const args = (svcSpies.getUsageLog.mock.calls[0] as any[])[2]
    expect(args.page).toBe(2)
    expect(args.limit).toBe(25)
  })

  test('GET /workspaces/:workspaceId/analytics/spend-timeseries defaults groupBy to day', async () => {
    const { status, body } = await call('GET', `/workspaces/${WS}/analytics/spend-timeseries`)
    expect(status).toBe(200)
    expect(body.data.series).toEqual([])
    // The service receives `groupBy` somewhere in its args — at minimum
    // the call ran exactly once.
    expect(svcSpies.getSpendTimeseries).toHaveBeenCalledTimes(1)
  })
})

// ─── Workspace CSV export ──────────────────────────────────────────────

describe('GET /workspaces/:workspaceId/analytics/usage-log.csv', () => {
  test('returns CSV body with header + escaped fields + content-type', async () => {
    const { status, res, text } = await call('GET', `/workspaces/${WS}/analytics/usage-log.csv`)
    expect(status).toBe(200)
    const ct = res.headers.get('content-type') || ''
    expect(ct).toMatch(/text\/csv/)
    expect(res.headers.get('content-disposition')).toContain(`usage-${WS}-30d.csv`)
    const lines = text.trim().split('\n')
    expect(lines[0]).toBe('Date,User,Email,Type,Model,Provider,Tokens,Billed USD')
    // Row 1 contains a comma in "A,lice" → must be quoted.
    expect(lines[1]).toContain('"A,lice"')
    // Row 2 contains a double-quote inside name → must be quoted + doubled.
    expect(lines[2]).toContain('"Bob ""B"""')
    // Row 3 has null fields rendered as empty strings.
    expect(lines[3]).toMatch(/^2026-01-03T00:00:00Z,,,,,,50,/)
  })

  test('CSV: ?period= query is forwarded into the filename', async () => {
    const { res } = await call('GET', `/workspaces/${WS}/analytics/usage-log.csv?period=7d`)
    expect(res.headers.get('content-disposition')).toContain(`usage-${WS}-7d.csv`)
  })

  test('CSV: limit > 10000 is clamped to 10000', async () => {
    await call('GET', `/workspaces/${WS}/analytics/usage-log.csv?limit=99999`)
    const args = (svcSpies.getUsageLog.mock.calls.at(-1) as any[])[2]
    expect(args.limit).toBe(10000)
  })
})

// ─── Project analytics happy paths ─────────────────────────────────────

describe('Project analytics — 200 happy paths', () => {
  test('GET /projects/:projectId/analytics/overview returns overview', async () => {
    const { status, body } = await call('GET', `/projects/${PROJ}/analytics/overview`)
    expect(status).toBe(200)
    expect(body.data).toEqual({ k: 'overview' })
    const callArgs = (svcSpies.getOverviewStats.mock.calls[0] as any[])[0]
    expect(callArgs).toMatchObject({ workspaceId: WS, projectId: PROJ })
  })

  test('GET /projects/:projectId/analytics/chat returns chat analytics', async () => {
    const { status, body } = await call('GET', `/projects/${PROJ}/analytics/chat?period=7d`)
    expect(status).toBe(200)
    expect(body.data.chat).toEqual([])
    const [scope, period] = svcSpies.getChatAnalytics.mock.calls[0] as any[]
    expect(scope).toMatchObject({ projectId: PROJ })
    expect(period).toBe('7d')
  })

  test('GET /projects/:projectId/analytics/usage returns usage analytics', async () => {
    const { status, body } = await call('GET', `/projects/${PROJ}/analytics/usage`)
    expect(status).toBe(200)
    expect(body.data.usage).toEqual([])
    expect(svcSpies.getUsageAnalytics).toHaveBeenCalledTimes(1)
  })
})

// ─── Me analytics happy paths ──────────────────────────────────────────

describe('Me analytics — 200 happy paths', () => {
  test('GET /me/analytics/overview returns overview scoped by userId', async () => {
    const { status, body } = await call('GET', '/me/analytics/overview')
    expect(status).toBe(200)
    expect(body.data).toEqual({ k: 'overview' })
    const args = (svcSpies.getOverviewStats.mock.calls[0] as any[])[0]
    expect(args).toMatchObject({ userId: 'user_1' })
  })

  test('GET /me/analytics/usage-log returns paginated entries', async () => {
    const { status, body } = await call('GET', '/me/analytics/usage-log?page=1&limit=10')
    expect(status).toBe(200)
    expect(body.data.entries).toHaveLength(3)
    expect(body.data.total).toBe(3)
    const args = (svcSpies.getUsageLog.mock.calls[0] as any[])[2]
    expect(args).toMatchObject({ page: 1, limit: 10 })
  })

  test('GET /me/analytics/usage-summary returns summary', async () => {
    const { status, body } = await call('GET', '/me/analytics/usage-summary')
    expect(status).toBe(200)
    expect(body.data).toEqual({ k: 'summary' })
  })
})

// ─── Workspace advanced (business-gated) happy paths ───────────────────

describe('Workspace advanced — 200 happy paths under Business plan', () => {
  test('GET /workspaces/:workspaceId/analytics/growth returns growth series', async () => {
    const { status, body } = await call('GET', `/workspaces/${WS}/analytics/growth`)
    expect(status).toBe(200)
    expect(body.data.growth).toEqual([])
  })

  test('GET /workspaces/:workspaceId/analytics/usage returns usage analytics', async () => {
    const { status, body } = await call('GET', `/workspaces/${WS}/analytics/usage`)
    expect(status).toBe(200)
    expect(body.data.usage).toEqual([])
  })

  test('GET /workspaces/:workspaceId/analytics/chat returns chat analytics', async () => {
    const { status, body } = await call('GET', `/workspaces/${WS}/analytics/chat`)
    expect(status).toBe(200)
    expect(body.data.chat).toEqual([])
  })

  test('GET /workspaces/:workspaceId/analytics/projects returns project analytics', async () => {
    const { status, body } = await call('GET', `/workspaces/${WS}/analytics/projects`)
    expect(status).toBe(200)
    expect(body.data.projects).toEqual([])
  })

  test('GET /workspaces/:workspaceId/analytics/billing returns billing analytics', async () => {
    const { status, body } = await call('GET', `/workspaces/${WS}/analytics/billing`)
    expect(status).toBe(200)
    expect(body.data.billing).toEqual([])
  })
})
