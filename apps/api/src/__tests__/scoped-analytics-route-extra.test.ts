// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Supplemental tests for `src/routes/scoped-analytics.ts` beyond what
 * `scoped-analytics-route.test.ts` covers.
 *
 * The base suite exercises the happy paths and a representative subset
 * of guards. This file pins:
 *
 *   - requireBusinessPlan 403 path on EVERY business-gated endpoint
 *     (growth/usage/chat/projects/billing), since they all share the
 *     same middleware and a divergence is silent
 *   - workspace membership 403 path on every business-gated endpoint
 *     after the plan check passes
 *   - the catch branch → `analytics_failed` 500 on every endpoint
 *     family (workspace basic, workspace advanced, project, me) so an
 *     unhandled service error never escapes
 *   - usage-log query-param parsing edges: NaN values, missing values,
 *     limit clamp boundary at exactly 10000
 *   - LOCAL_MODE bypass on multiple endpoints (not just growth)
 *   - me endpoint NaN page/limit parsing
 *
 * These tests use the same mocking shape as the base suite (auth/prisma/
 * billing/analytics modules stubbed) — see notes at the top of
 * `scoped-analytics-route.test.ts` for the canonical pattern.
 */

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

let isBusiness = false
mock.module('../services/billing.service', () => ({ isBusinessOrHigherPlan: async () => isBusiness }))

const svcSpies = {
  getOverviewStats: mock(async (..._: any[]): Promise<any> => ({ k: 'overview' })),
  getMemberUsageStats: mock(async (..._: any[]): Promise<any> => ({ k: 'member-usage' })),
  getUsageLog: mock(async (..._: any[]): Promise<any> => ({ entries: [], total: 0 })),
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
  const body = await res.clone().json().catch(() => ({}))
  return { status: res.status, body, res }
}

beforeEach(() => {
  members = []
  projects = new Map()
  isBusiness = false
  currentUserId = 'user_1'
  delete process.env.SHOGO_LOCAL_MODE
  for (const k of Object.keys(svcSpies)) (svcSpies as any)[k].mockClear()
})

afterEach(() => { delete process.env.SHOGO_LOCAL_MODE })

const seedMember = (workspaceId = WS) => { members.push({ userId: 'user_1', workspaceId }) }
const seedProject = (id = PROJ, workspaceId = WS) => { projects.set(id, { workspaceId }) }

// ─── requireBusinessPlan 403 on every business-gated endpoint ──────────

describe('requireBusinessPlan: 403 plan_required on every gated endpoint', () => {
  const gated: Array<[string, string]> = [
    ['growth',   `/workspaces/${WS}/analytics/growth`],
    ['usage',    `/workspaces/${WS}/analytics/usage`],
    ['chat',     `/workspaces/${WS}/analytics/chat`],
    ['projects', `/workspaces/${WS}/analytics/projects`],
    ['billing',  `/workspaces/${WS}/analytics/billing`],
  ]
  for (const [name, path] of gated) {
    test(`${name}: 403 plan_required when isBusinessOrHigherPlan=false`, async () => {
      isBusiness = false
      seedMember()
      const { status, body } = await call('GET', path)
      expect(status).toBe(403)
      expect(body.error.code).toBe('plan_required')
    })
  }
})

// ─── workspace membership 403 on every business-gated endpoint ─────────

describe('workspace membership: 403 forbidden after plan check passes', () => {
  const gated: Array<[string, string]> = [
    ['growth',   `/workspaces/${WS}/analytics/growth`],
    ['usage',    `/workspaces/${WS}/analytics/usage`],
    ['chat',     `/workspaces/${WS}/analytics/chat`],
    ['projects', `/workspaces/${WS}/analytics/projects`],
    ['billing',  `/workspaces/${WS}/analytics/billing`],
  ]
  for (const [name, path] of gated) {
    test(`${name}: 403 forbidden when user is not a workspace member`, async () => {
      isBusiness = true
      // intentionally no seedMember()
      const { status, body } = await call('GET', path)
      expect(status).toBe(403)
      expect(body.error.code).toBe('forbidden')
    })
  }
})

// ─── 500 catch branch on every endpoint family ─────────────────────────

describe('catch branch: 500 analytics_failed propagates service error message', () => {
  test('workspace member-usage catch branch', async () => {
    seedMember()
    svcSpies.getMemberUsageStats.mockImplementationOnce(async () => { throw new Error('mu boom') })
    const { status, body } = await call('GET', `/workspaces/${WS}/analytics/member-usage`)
    expect(status).toBe(500)
    expect(body.error.code).toBe('analytics_failed')
    expect(body.error.message).toBe('mu boom')
  })

  test('workspace usage-log catch branch', async () => {
    seedMember()
    svcSpies.getUsageLog.mockImplementationOnce(async () => { throw new Error('ul boom') })
    const { status, body } = await call('GET', `/workspaces/${WS}/analytics/usage-log`)
    expect(status).toBe(500)
    expect(body.error.message).toBe('ul boom')
  })

  test('workspace usage-summary catch branch', async () => {
    seedMember()
    svcSpies.getUsageSummary.mockImplementationOnce(async () => { throw new Error('us boom') })
    const { status, body } = await call('GET', `/workspaces/${WS}/analytics/usage-summary`)
    expect(status).toBe(500)
    expect(body.error.message).toBe('us boom')
  })

  test('workspace growth catch branch (business-gated)', async () => {
    isBusiness = true
    seedMember()
    svcSpies.getGrowthTimeSeries.mockImplementationOnce(async () => { throw new Error('g boom') })
    const { status } = await call('GET', `/workspaces/${WS}/analytics/growth`)
    expect(status).toBe(500)
  })

  test('workspace usage (advanced) catch branch', async () => {
    isBusiness = true
    seedMember()
    svcSpies.getUsageAnalytics.mockImplementationOnce(async () => { throw new Error('ua boom') })
    const { status } = await call('GET', `/workspaces/${WS}/analytics/usage`)
    expect(status).toBe(500)
  })

  test('workspace chat (advanced) catch branch', async () => {
    isBusiness = true
    seedMember()
    svcSpies.getChatAnalytics.mockImplementationOnce(async () => { throw new Error('ca boom') })
    const { status } = await call('GET', `/workspaces/${WS}/analytics/chat`)
    expect(status).toBe(500)
  })

  test('workspace projects (advanced) catch branch', async () => {
    isBusiness = true
    seedMember()
    svcSpies.getProjectAnalytics.mockImplementationOnce(async () => { throw new Error('pa boom') })
    const { status } = await call('GET', `/workspaces/${WS}/analytics/projects`)
    expect(status).toBe(500)
  })

  test('workspace billing (advanced) catch branch', async () => {
    isBusiness = true
    seedMember()
    svcSpies.getBillingAnalytics.mockImplementationOnce(async () => { throw new Error('ba boom') })
    const { status } = await call('GET', `/workspaces/${WS}/analytics/billing`)
    expect(status).toBe(500)
  })

  test('project chat catch branch', async () => {
    seedMember()
    seedProject()
    svcSpies.getChatAnalytics.mockImplementationOnce(async () => { throw new Error('pchat boom') })
    const { status } = await call('GET', `/projects/${PROJ}/analytics/chat`)
    expect(status).toBe(500)
  })

  test('project usage catch branch', async () => {
    seedMember()
    seedProject()
    svcSpies.getUsageAnalytics.mockImplementationOnce(async () => { throw new Error('pusg boom') })
    const { status } = await call('GET', `/projects/${PROJ}/analytics/usage`)
    expect(status).toBe(500)
  })

  test('me usage-log catch branch', async () => {
    svcSpies.getUsageLog.mockImplementationOnce(async () => { throw new Error('me boom') })
    const { status } = await call('GET', `/me/analytics/usage-log`)
    expect(status).toBe(500)
  })

  test('me usage-summary catch branch', async () => {
    svcSpies.getUsageSummary.mockImplementationOnce(async () => { throw new Error('me-sum boom') })
    const { status } = await call('GET', `/me/analytics/usage-summary`)
    expect(status).toBe(500)
  })
})

// ─── LOCAL_MODE bypass on advanced endpoints other than growth ──────────

describe('SHOGO_LOCAL_MODE bypass on advanced endpoints', () => {
  for (const [name, path] of [
    ['usage',    `/workspaces/${WS}/analytics/usage`],
    ['chat',     `/workspaces/${WS}/analytics/chat`],
    ['projects', `/workspaces/${WS}/analytics/projects`],
    ['billing',  `/workspaces/${WS}/analytics/billing`],
  ] as const) {
    test(`${name}: LOCAL_MODE=1 skips plan check`, async () => {
      process.env.SHOGO_LOCAL_MODE = 'true'
      isBusiness = false
      seedMember()
      const { status } = await call('GET', path)
      expect(status).toBe(200)
    })
  }
})

// ─── usage-log query-param parsing edges ───────────────────────────────

describe('usage-log query parameter parsing edges', () => {
  test('non-numeric page/limit fall through parseInt → NaN reaches service unchanged', async () => {
    seedMember()
    await call('GET', `/workspaces/${WS}/analytics/usage-log?page=abc&limit=xyz`)
    const [, , opts] = svcSpies.getUsageLog.mock.calls[0]!
    expect(Number.isNaN(opts.page)).toBe(true)
    expect(Number.isNaN(opts.limit)).toBe(true)
  })

  test('userId & model are forwarded as undefined when not supplied', async () => {
    seedMember()
    await call('GET', `/workspaces/${WS}/analytics/usage-log`)
    const [, , opts] = svcSpies.getUsageLog.mock.calls[0]!
    expect(opts.userId).toBeUndefined()
    expect(opts.model).toBeUndefined()
  })
})

// ─── usage-log.csv edge — limit clamp boundary ─────────────────────────

describe('usage-log.csv limit clamp boundary', () => {
  test('limit=10000 (exact boundary) is forwarded unchanged', async () => {
    seedMember()
    await call('GET', `/workspaces/${WS}/analytics/usage-log.csv?limit=10000`)
    const [, , opts] = svcSpies.getUsageLog.mock.calls[0]!
    expect(opts.limit).toBe(10000)
  })

  test('limit=10001 clamps to 10000', async () => {
    seedMember()
    await call('GET', `/workspaces/${WS}/analytics/usage-log.csv?limit=10001`)
    const [, , opts] = svcSpies.getUsageLog.mock.calls[0]!
    expect(opts.limit).toBe(10000)
  })

  test('default limit (no query) is 5000', async () => {
    seedMember()
    await call('GET', `/workspaces/${WS}/analytics/usage-log.csv`)
    const [, , opts] = svcSpies.getUsageLog.mock.calls[0]!
    expect(opts.limit).toBe(5000)
  })
})

// ─── spend-timeseries query parsing edges ──────────────────────────────

describe('spend-timeseries query-param edges', () => {
  test('topN=abc → NaN forwarded to service (no fallback)', async () => {
    seedMember()
    await call('GET', `/workspaces/${WS}/analytics/spend-timeseries?topN=abc`)
    const [, , opts] = svcSpies.getSpendTimeseries.mock.calls[0]!
    expect(Number.isNaN(opts.topN)).toBe(true)
  })

  test('from/to forward when present', async () => {
    seedMember()
    await call('GET', `/workspaces/${WS}/analytics/spend-timeseries?from=2026-01-01&to=2026-01-31`)
    const [, , opts] = svcSpies.getSpendTimeseries.mock.calls[0]!
    expect(opts.fromIso).toBe('2026-01-01')
    expect(opts.toIso).toBe('2026-01-31')
  })

  test('from/to absent → undefined (not empty string)', async () => {
    seedMember()
    await call('GET', `/workspaces/${WS}/analytics/spend-timeseries`)
    const [, , opts] = svcSpies.getSpendTimeseries.mock.calls[0]!
    expect(opts.fromIso).toBeUndefined()
    expect(opts.toIso).toBeUndefined()
  })
})

// ─── me endpoints — parsing edges ──────────────────────────────────────

describe('/me endpoints — query-param parsing edges', () => {
  test('me usage-log page=abc & limit=xyz → NaN forwarded', async () => {
    await call('GET', `/me/analytics/usage-log?page=abc&limit=xyz`)
    const [, , opts] = svcSpies.getUsageLog.mock.calls[0]!
    expect(Number.isNaN(opts.page)).toBe(true)
    expect(Number.isNaN(opts.limit)).toBe(true)
  })

  test('me usage-log forwards model query param', async () => {
    await call('GET', `/me/analytics/usage-log?model=sonnet`)
    const [, , opts] = svcSpies.getUsageLog.mock.calls[0]!
    expect(opts.model).toBe('sonnet')
  })
})
