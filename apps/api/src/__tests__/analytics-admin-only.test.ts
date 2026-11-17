// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace analytics are owner/admin only (SHO-404).
 *
 * Every workspace-wide analytics read — `/workspaces/:id/analytics/*`,
 * `/projects/:id/analytics/*` and `/workspaces/:id/cost-analytics/*` — must
 * answer a member or viewer with 403 `analytics_admin_only`, and must never
 * reach the service. `/me/analytics/*` stays open to everyone.
 *
 * The route list is read from the router source, not hand-written, so a new
 * analytics GET that ships without the guard fails this test.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let currentUserId: string | null = 'user_1'
mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => { c.set('auth', { userId: currentUserId }); await next() },
  requireAuth: async (_c: any, next: any) => next(),
}))

let members: Array<{ userId: string; workspaceId: string; role: string }> = []
const projects = new Map<string, { workspaceId: string }>([['proj_1', { workspaceId: 'ws_1' }]])

mock.module('../lib/prisma', () => ({
  prisma: {
    user: { findUnique: async () => ({ role: 'user' }) },
    member: {
      findMany: async (args: any) =>
        members
          .filter((m) => m.userId === args.where.userId)
          .filter((m) => (args.where.OR
            ? args.where.OR.some((o: any) => o.workspaceId === m.workspaceId)
            : !args.where.workspaceId || args.where.workspaceId === m.workspaceId))
          .map((m) => ({ role: m.role, workspaceId: m.workspaceId, projectId: null, isBillingAdmin: false })),
      findFirst: async (args: any) =>
        members.find((m) => m.userId === args.where.userId && m.workspaceId === args.where.workspaceId) ?? null,
    },
    project: {
      findUnique: async (args: any) => projects.get(args.where.id) ?? null,
    },
  },
}))

mock.module('../services/billing.service', () => ({ isBusinessOrHigherPlan: async () => true }))

const svcSpies = {
  getOverviewStats: mock(async (..._: any[]): Promise<any> => ({})),
  getMemberUsageStats: mock(async (..._: any[]): Promise<any> => ({})),
  getMemberInsights: mock(async (..._: any[]): Promise<any> => ({ rows: [], total: 0 })),
  getUsageLog: mock(async (..._: any[]): Promise<any> => ({ entries: [], total: 0 })),
  getUsageSummary: mock(async (..._: any[]): Promise<any> => ({})),
  getSpendTimeseries: mock(async (..._: any[]): Promise<any> => ({ series: [] })),
  getGrowthTimeSeries: mock(async (..._: any[]): Promise<any> => ({})),
  getUsageAnalytics: mock(async (..._: any[]): Promise<any> => ({})),
  getChatAnalytics: mock(async (..._: any[]): Promise<any> => ({})),
  getProjectAnalytics: mock(async (..._: any[]): Promise<any> => ({})),
  getBillingAnalytics: mock(async (..._: any[]): Promise<any> => ({})),
  getActivityTimeseries: mock(async (..._: any[]): Promise<any> => ({})),
  getActiveUsersTimeseries: mock(async (..._: any[]): Promise<any> => ({})),
  getQualityTimeseries: mock(async (..._: any[]): Promise<any> => ({})),
  getToolCallAnalytics: mock(async (..._: any[]): Promise<any> => ({})),
  getWorkspaceHeartbeats: mock(async (..._: any[]): Promise<any> => ({ agents: [] })),
  parseHeartbeatPeriod: (value: string | null) => value || '24h',
}
mock.module('../services/analytics.service', () => svcSpies)

mock.module('../services/engagement-analytics.service', () => ({
  getEngagementStats: mock(async (..._: any[]): Promise<any> => ({})),
  getTeamWork: mock(async (..._: any[]): Promise<any> => ({})),
  engagementWindow: () => ({ from: new Date(0), to: new Date(1) }),
}))

mock.module('../services/conversation-metrics', () => ({
  getChannelBreakdown: mock(async (..._: any[]): Promise<any> => ({ channels: [], totals: {} })),
}))

const costSpies = {
  getAgentCostBreakdown: mock(async (..._: any[]): Promise<any> => ({})),
  getCostRecommendations: mock(async (..._: any[]): Promise<any> => []),
  getCostTrends: mock(async (..._: any[]): Promise<any> => ({})),
  getBudgetAlerts: mock(async (..._: any[]): Promise<any> => []),
  getBudgetAlertUsage: mock(async (..._: any[]): Promise<any> => []),
  deriveActiveThrottleModel: () => null,
  getExperiments: mock(async (..._: any[]): Promise<any> => []),
  getExperiment: mock(async (..._: any[]): Promise<any> => null),
  summarizeExperiment: mock(async (..._: any[]): Promise<any> => null),
  getOptimizerInActionReport: mock(async (..._: any[]): Promise<any> => ({})),
  listAgentEvalSets: mock(async (..._: any[]): Promise<any> => []),
  listSubagentOverrides: mock(async (..._: any[]): Promise<any> => []),
  isCostPeriod: (v: string) => ['7d', '30d', '90d', '1y'].includes(v),
}
mock.module('../services/cost-analytics.service', () => costSpies)

const { scopedAnalyticsRoutes } = await import('../routes/scoped-analytics')
const { costAnalyticsRoutes } = await import('../routes/cost-analytics')

const WS = 'ws_1'
const PROJ = 'proj_1'

// ─── route discovery ──────────────────────────────────────────────────

const ROUTES_DIR = join(import.meta.dir, '..', 'routes')

/** Every GET path in a router file that reads workspace-wide analytics. */
function analyticsGetPaths(file: string): string[] {
  const source = readFileSync(join(ROUTES_DIR, file), 'utf8')
  const paths: string[] = []
  const re = /router\.get\(\s*'([^']+)'/g
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const path = m[1]
    if (path.startsWith('/me/')) continue
    if (!path.includes('/analytics/') && !path.includes('/cost-analytics/')) continue
    paths.push(path)
  }
  return paths
}

const workspacePaths = [
  ...analyticsGetPaths('scoped-analytics.ts'),
  ...analyticsGetPaths('cost-analytics.ts'),
]

/** Fill the route params with ids the mocks know about. */
function concrete(path: string): string {
  return path
    .replace(':workspaceId', WS)
    .replace(':projectId', PROJ)
    .replace(':experimentId', 'exp_1')
}

async function get(path: string) {
  const app = path.includes('/cost-analytics/') ? costAnalyticsRoutes() : scopedAnalyticsRoutes()
  const res = await app.fetch(new Request(`http://test${concrete(path)}`))
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any }
}

beforeEach(() => {
  members = []
  currentUserId = 'user_1'
  delete process.env.SHOGO_LOCAL_MODE
})

// ─── the sweep ────────────────────────────────────────────────────────

describe('every workspace analytics GET is admin-only', () => {
  test('the route list is not empty (the discovery regex still matches)', () => {
    expect(workspacePaths.length).toBeGreaterThan(20)
  })

  for (const path of workspacePaths) {
    test(`member is refused: GET ${path}`, async () => {
      members = [{ userId: 'user_1', workspaceId: WS, role: 'member' }]
      const { status, body } = await get(path)
      expect(status).toBe(403)
      expect(body.error?.code).toBe('analytics_admin_only')
    })

    test(`viewer is refused: GET ${path}`, async () => {
      members = [{ userId: 'user_1', workspaceId: WS, role: 'viewer' }]
      const { status, body } = await get(path)
      expect(status).toBe(403)
      expect(body.error?.code).toBe('analytics_admin_only')
    })

    test(`non-member is refused: GET ${path}`, async () => {
      members = []
      const { status, body } = await get(path)
      expect(status).toBe(403)
      // A project route resolves the project first, so a non-member is stopped
      // there; a workspace route has nothing to resolve and answers with the
      // analytics gate.
      expect(body.error?.code).toBe(
        path.startsWith('/projects/') ? 'forbidden' : 'analytics_admin_only',
      )
    })

    test(`admin is not blocked by the analytics gate: GET ${path}`, async () => {
      members = [{ userId: 'user_1', workspaceId: WS, role: 'admin' }]
      const { status, body } = await get(path)
      expect(body.error?.code).not.toBe('analytics_admin_only')
      expect(status).not.toBe(401)
    })
  }
})

describe('/me/analytics/* stays open to a member', () => {
  for (const path of ['/me/analytics/overview', '/me/analytics/usage-log', '/me/analytics/usage-summary', '/me/analytics/engagement']) {
    test(`member gets their own data: GET ${path}`, async () => {
      members = [{ userId: 'user_1', workspaceId: WS, role: 'member' }]
      const res = await scopedAnalyticsRoutes().fetch(new Request(`http://test${path}`))
      expect(res.status).toBe(200)
    })
  }
})
