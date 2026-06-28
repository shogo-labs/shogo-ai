// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/routes/scoped-analytics.ts` — workspace/project/me
 * analytics endpoints (delegates to analytics.service).
 *
 * Covers:
 *   - workspace basic endpoints (overview, member-usage, usage-log,
 *     usage-summary, spend-timeseries, usage-log.csv)
 *   - access guards (non-member → 403)
 *   - usage-log query param defaults & pass-through
 *   - usage-log.csv rendering (header + escaping + content-type)
 *   - workspace advanced endpoints with requireBusinessPlan middleware
 *     (plan_required when not business+; bypass via SHOGO_LOCAL_MODE)
 *   - project endpoints (checkProjectAccess: missing project / non-member /
 *     member resolves workspaceId)
 *   - me endpoints (use userId scope, no workspace check)
 *   - catch branch → analytics_failed 500
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// ─── Middleware mock ──────────────────────────────────────────────────

let currentUserId: string | null = 'user_1'
mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { userId: currentUserId })
    await next()
  },
  requireAuth: async (_c: any, next: any) => next(),
}))

// ─── Prisma mock ──────────────────────────────────────────────────────

let members: Array<{ userId: string; workspaceId: string; role?: string }> = []
let projects: Map<string, { workspaceId: string }> = new Map()

mock.module('../lib/prisma', () => ({
  prisma: {
    member: {
      findFirst: async (args: any) => {
        const w = args.where
        return (
          members.find(
            (m) => m.userId === w.userId && m.workspaceId === w.workspaceId,
          ) ?? null
        )
      },
    },
    project: {
      findUnique: async (args: any) => {
        const p = projects.get(args.where.id)
        return p ? { workspaceId: p.workspaceId } : null
      },
    },
  },
}))

// ─── billing.service mock ─────────────────────────────────────────────

let isBusiness = false
mock.module('../services/billing.service', () => ({
  isBusinessOrHigherPlan: async () => isBusiness,
}))

// ─── analytics.service mock ───────────────────────────────────────────

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

// ─── helpers ──────────────────────────────────────────────────────────

const WS = 'ws_1'
const PROJ = 'proj_1'

function makeApp() {
  return scopedAnalyticsRoutes()
}

async function call(method: string, path: string): Promise<{ status: number; body: any; res: Response }> {
  const res = await makeApp().fetch(new Request(`http://test${path}`, { method }))
  const json = await res.clone().json().catch(() => ({}))
  return { status: res.status, body: json, res }
}

beforeEach(() => {
  members = []
  projects = new Map()
  isBusiness = false
  currentUserId = 'user_1'
  delete process.env.SHOGO_LOCAL_MODE
  for (const k of Object.keys(svcSpies)) (svcSpies as any)[k].mockClear()
})

afterEach(() => {
  delete process.env.SHOGO_LOCAL_MODE
})

function seedMember(workspaceId = WS) {
  members.push({ userId: 'user_1', workspaceId })
}

function seedProject(projectId = PROJ, workspaceId = WS) {
  projects.set(projectId, { workspaceId })
}

// ──────────────────────────────────────────────────────────────────────
// workspace basic endpoints
// ──────────────────────────────────────────────────────────────────────

describe('workspace basic endpoints', () => {
  test('overview: 403 when not a member', async () => {
    const res = await call('GET', `/workspaces/${WS}/analytics/overview`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('forbidden')
  })

  test('overview: 200 when member', async () => {
    seedMember()
    const res = await call('GET', `/workspaces/${WS}/analytics/overview`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ k: 'overview' })
    expect(svcSpies.getOverviewStats).toHaveBeenCalledWith({ workspaceId: WS })
  })

  test('member-usage delegates to service', async () => {
    seedMember()
    const res = await call('GET', `/workspaces/${WS}/analytics/member-usage`)
    expect(res.status).toBe(200)
    expect(svcSpies.getMemberUsageStats).toHaveBeenCalledWith(WS)
  })

  test('usage-log: parses page/limit/userId/model query params', async () => {
    seedMember()
    await call(
      'GET',
      `/workspaces/${WS}/analytics/usage-log?period=7d&page=3&limit=20&userId=u9&model=sonnet`,
    )
    expect(svcSpies.getUsageLog).toHaveBeenCalledWith(
      { workspaceId: WS },
      '7d',
      { page: 3, limit: 20, userId: 'u9', model: 'sonnet' },
    )
  })

  test('usage-log: defaults page=1, limit=50, period=30d', async () => {
    seedMember()
    await call('GET', `/workspaces/${WS}/analytics/usage-log`)
    expect(svcSpies.getUsageLog).toHaveBeenCalledWith(
      { workspaceId: WS },
      '30d',
      { page: 1, limit: 50, userId: undefined, model: undefined },
    )
  })

  test('usage-summary forwards period', async () => {
    seedMember()
    await call('GET', `/workspaces/${WS}/analytics/usage-summary?period=90d`)
    expect(svcSpies.getUsageSummary).toHaveBeenCalledWith({ workspaceId: WS }, '90d', { page: 1, limit: 500 })
  })

  test('spend-timeseries: defaults groupBy=model, metric=spend, topN=8', async () => {
    seedMember()
    await call('GET', `/workspaces/${WS}/analytics/spend-timeseries`)
    expect(svcSpies.getSpendTimeseries).toHaveBeenCalledWith(
      { workspaceId: WS },
      '30d',
      { fromIso: undefined, toIso: undefined, groupBy: 'model', metric: 'spend', topN: 8 },
    )
  })

  test('spend-timeseries: parses from/to/groupBy/metric/topN', async () => {
    seedMember()
    await call(
      'GET',
      `/workspaces/${WS}/analytics/spend-timeseries?from=2025-01-01&to=2025-02-01&groupBy=user&metric=tokens&topN=15`,
    )
    expect(svcSpies.getSpendTimeseries).toHaveBeenCalledWith(
      { workspaceId: WS },
      '30d',
      { fromIso: '2025-01-01', toIso: '2025-02-01', groupBy: 'user', metric: 'tokens', topN: 15 },
    )
  })

  test('catch branch → 500 analytics_failed', async () => {
    seedMember()
    svcSpies.getOverviewStats.mockImplementationOnce(async () => {
      throw new Error('analytics db down')
    })
    const res = await call('GET', `/workspaces/${WS}/analytics/overview`)
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('analytics_failed')
    expect(res.body.error.message).toBe('analytics db down')
  })
})

// ──────────────────────────────────────────────────────────────────────
// usage-log.csv
// ──────────────────────────────────────────────────────────────────────

describe('usage-log.csv', () => {
  test('403 when not member', async () => {
    const res = await call('GET', `/workspaces/${WS}/analytics/usage-log.csv`)
    expect(res.status).toBe(403)
  })

  test('clamps limit at 10000', async () => {
    seedMember()
    svcSpies.getUsageLog.mockImplementationOnce(async () => ({ entries: [] }))
    await call('GET', `/workspaces/${WS}/analytics/usage-log.csv?limit=999999`)
    expect(svcSpies.getUsageLog.mock.calls[0][2].limit).toBe(10000)
  })

  test('returns CSV with header + content-type + content-disposition', async () => {
    seedMember()
    svcSpies.getUsageLog.mockImplementationOnce(async () => ({
      entries: [
        {
          createdAt: '2026-01-01T00:00:00Z',
          userName: 'Alice',
          userEmail: 'a@b.c',
          actionType: 'chat',
          model: 'sonnet',
          provider: 'anthropic',
          totalTokens: 1234,
          billedUsd: 0.0123,
        },
      ],
    }))
    const { res } = await call('GET', `/workspaces/${WS}/analytics/usage-log.csv`)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('content-disposition')).toContain(
      `attachment; filename="usage-${WS}-30d.csv"`,
    )
    const body = await res.text()
    expect(body.split('\n')[0]).toBe(
      'Date,User,Email,Type,Model,Provider,Tokens,Billed USD',
    )
    expect(body).toContain('Alice')
    expect(body).toContain('0.0123')
  })

  test('CSV escaping: quotes around values containing commas/newlines/quotes', async () => {
    seedMember()
    svcSpies.getUsageLog.mockImplementationOnce(async () => ({
      entries: [
        {
          createdAt: '2026-01-01',
          userName: 'Comma, Person',
          userEmail: null,
          actionType: 'has\nnewline',
          model: 'has"quote',
          provider: 'p',
          totalTokens: 1,
          billedUsd: 1,
        },
      ],
    }))
    const { res } = await call('GET', `/workspaces/${WS}/analytics/usage-log.csv`)
    const body = await res.text()
    expect(body).toContain('"Comma, Person"')
    expect(body).toContain('"has\nnewline"')
    expect(body).toContain('"has""quote"')
  })
})

// ──────────────────────────────────────────────────────────────────────
// advanced workspace endpoints (requireBusinessPlan)
// ──────────────────────────────────────────────────────────────────────

describe('advanced workspace endpoints', () => {
  test('growth: 403 plan_required when not business plan', async () => {
    seedMember()
    isBusiness = false
    const res = await call('GET', `/workspaces/${WS}/analytics/growth`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('plan_required')
  })

  test('growth: passes when business plan', async () => {
    seedMember()
    isBusiness = true
    const res = await call('GET', `/workspaces/${WS}/analytics/growth?period=7d`)
    expect(res.status).toBe(200)
    expect(svcSpies.getGrowthTimeSeries).toHaveBeenCalledWith({ workspaceId: WS }, '7d')
  })

  test('usage: passes when business plan, checks membership', async () => {
    isBusiness = true
    const res = await call('GET', `/workspaces/${WS}/analytics/usage`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('forbidden')
  })

  test('chat: business + member = 200', async () => {
    isBusiness = true
    seedMember()
    const res = await call('GET', `/workspaces/${WS}/analytics/chat?period=90d`)
    expect(res.status).toBe(200)
    expect(svcSpies.getChatAnalytics).toHaveBeenCalledWith({ workspaceId: WS }, '90d')
  })

  test('projects (workspace-scoped): 200 with project list', async () => {
    isBusiness = true
    seedMember()
    const res = await call('GET', `/workspaces/${WS}/analytics/projects`)
    expect(res.status).toBe(200)
    expect(svcSpies.getProjectAnalytics).toHaveBeenCalledWith({ workspaceId: WS })
  })

  test('billing: 200 with business plan', async () => {
    isBusiness = true
    seedMember()
    const res = await call('GET', `/workspaces/${WS}/analytics/billing`)
    expect(res.status).toBe(200)
    expect(svcSpies.getBillingAnalytics).toHaveBeenCalledWith({ workspaceId: WS })
  })
})

// ──────────────────────────────────────────────────────────────────────
// SHOGO_LOCAL_MODE bypass
// ──────────────────────────────────────────────────────────────────────

describe('SHOGO_LOCAL_MODE bypass', () => {
  test('LOCAL_MODE skips plan check entirely', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    // Re-import to capture the new env on module load
    const mod = await import(`../routes/scoped-analytics?t=${Date.now()}`)
    const app = mod.scopedAnalyticsRoutes() as any
    seedMember()
    isBusiness = false
    const res = await app.fetch(
      new Request(`http://test/workspaces/${WS}/analytics/growth`),
    )
    // Even without business plan, local mode lets the request proceed
    expect(res.status).toBe(200)
  })
})

// ──────────────────────────────────────────────────────────────────────
// project endpoints (checkProjectAccess)
// ──────────────────────────────────────────────────────────────────────

describe('project endpoints', () => {
  test('overview: 403 when project does not exist', async () => {
    const res = await call('GET', `/projects/${PROJ}/analytics/overview`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('forbidden')
    expect(res.body.error.message).toContain('project')
  })

  test('overview: 403 when project exists but user is not a member of workspace', async () => {
    seedProject()
    const res = await call('GET', `/projects/${PROJ}/analytics/overview`)
    expect(res.status).toBe(403)
  })

  test('overview: 200 with workspaceId resolved from project', async () => {
    seedProject()
    seedMember()
    const res = await call('GET', `/projects/${PROJ}/analytics/overview`)
    expect(res.status).toBe(200)
    expect(svcSpies.getOverviewStats).toHaveBeenCalledWith({
      workspaceId: WS,
      projectId: PROJ,
    })
  })

  test('chat: forwards period + scope to service', async () => {
    seedProject()
    seedMember()
    await call('GET', `/projects/${PROJ}/analytics/chat?period=7d`)
    expect(svcSpies.getChatAnalytics).toHaveBeenCalledWith(
      { workspaceId: WS, projectId: PROJ },
      '7d',
    )
  })

  test('usage: defaults period=30d', async () => {
    seedProject()
    seedMember()
    await call('GET', `/projects/${PROJ}/analytics/usage`)
    expect(svcSpies.getUsageAnalytics).toHaveBeenCalledWith(
      { workspaceId: WS, projectId: PROJ },
      '30d',
    )
  })

  test('catch branch on project endpoint → 500', async () => {
    seedProject()
    seedMember()
    svcSpies.getChatAnalytics.mockImplementationOnce(async () => {
      throw new Error('chat err')
    })
    const res = await call('GET', `/projects/${PROJ}/analytics/chat`)
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('analytics_failed')
  })
})

// ──────────────────────────────────────────────────────────────────────
// me endpoints
// ──────────────────────────────────────────────────────────────────────

describe('me endpoints', () => {
  test('overview: scopes by userId, no workspace check', async () => {
    const res = await call('GET', '/me/analytics/overview')
    expect(res.status).toBe(200)
    expect(svcSpies.getOverviewStats).toHaveBeenCalledWith({ userId: 'user_1' })
  })

  test('usage-log: parses page/limit/model query params', async () => {
    await call('GET', '/me/analytics/usage-log?period=7d&page=2&limit=25&model=opus')
    expect(svcSpies.getUsageLog).toHaveBeenCalledWith(
      { userId: 'user_1' },
      '7d',
      { page: 2, limit: 25, model: 'opus' },
    )
  })

  test('usage-log: defaults', async () => {
    await call('GET', '/me/analytics/usage-log')
    expect(svcSpies.getUsageLog).toHaveBeenCalledWith(
      { userId: 'user_1' },
      '30d',
      { page: 1, limit: 50, model: undefined },
    )
  })

  test('usage-summary forwards period', async () => {
    await call('GET', '/me/analytics/usage-summary?period=1y')
    expect(svcSpies.getUsageSummary).toHaveBeenCalledWith({ userId: 'user_1' }, '1y', { limit: 500 })
  })

  test('catch branch on me endpoint → 500', async () => {
    svcSpies.getOverviewStats.mockImplementationOnce(async () => {
      throw new Error('me err')
    })
    const res = await call('GET', '/me/analytics/overview')
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('analytics_failed')
  })
})
