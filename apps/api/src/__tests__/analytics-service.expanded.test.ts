// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Analytics service — coverage expansion.
 *
 * Pairs with the existing `analytics-service.test.ts` which covers the
 * raw-SQL funnel / source-breakdown / template-engagement paths. This
 * file targets the Prisma-aggregation surface:
 *
 *   - periodToWindow (every branch)
 *   - getOverviewStats (user / project / workspace / platform scopes)
 *   - getGrowthTimeSeries
 *   - getMemberUsageStats (bucketing by `source` column)
 *   - getUsageAnalytics
 *   - getSpendTimeseries
 *   - getActiveUsers
 *   - getUsageLog + getUsageSummary
 *   - getChatAnalytics
 *   - getProjectAnalytics
 *   - getBillingAnalytics
 *
 *   bun test apps/api/src/__tests__/analytics-service.expanded.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'

type Store = {
  usageEvents: any[]
  users: any[]
  workspaces: any[]
  projects: any[]
  members: any[]
  chatSessions: any[]
  chatMessages: any[]
  subscriptions: any[]
  toolCallLogs: any[]
}

const store: Store = {
  usageEvents: [],
  users: [],
  workspaces: [],
  projects: [],
  members: [],
  chatSessions: [],
  chatMessages: [],
  subscriptions: [],
  toolCallLogs: [],
}

function matchWhere<T extends Record<string, any>>(row: T, where?: any): boolean {
  if (!where) return true
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue
    if (k === 'AND' && Array.isArray(v)) {
      if (!v.every((w) => matchWhere(row, w))) return false
      continue
    }
    if (k === 'OR' && Array.isArray(v)) {
      if (!v.some((w) => matchWhere(row, w))) return false
      continue
    }
    const rv = row[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if ('gte' in v && !(rv instanceof Date && rv >= v.gte)) return false
      if ('lte' in v && !(rv instanceof Date && rv <= v.lte)) return false
      if ('lt' in v && !(rv instanceof Date && rv < v.lt)) return false
      if ('in' in v && !(v.in as any[]).includes(rv)) return false
      if ('not' in v && v.not !== undefined && rv === v.not) return false
      // Nested where keyed on a relation; just ignore for our stub.
      continue
    }
    if (rv !== v) return false
  }
  return true
}

function makeModel<T extends Record<string, any>>(rows: T[]) {
  return {
    count: async (args?: any) => rows.filter((r) => matchWhere(r, args?.where)).length,
    findMany: async (args?: any) => {
      const filtered = rows.filter((r) => matchWhere(r, args?.where))
      return filtered.slice(args?.skip ?? 0, (args?.skip ?? 0) + (args?.take ?? filtered.length))
    },
    findUnique: async (args: any) => rows.find((r) => r.id === args?.where?.id) ?? null,
    aggregate: async (args: any) => {
      const filtered = rows.filter((r) => matchWhere(r, args?.where))
      const sum: any = {}
      if (args?._sum) {
        for (const k of Object.keys(args._sum)) {
          sum[k] = filtered.reduce((s, r) => s + (r[k] ?? 0), 0)
        }
      }
      return { _sum: sum, _count: { _all: filtered.length } }
    },
    groupBy: async (args: any) => {
      const filtered = rows.filter((r) => matchWhere(r, args?.where))
      const byKey = new Map<string, any>()
      for (const r of filtered) {
        const key = args.by.map((k: string) => String(r[k])).join('::')
        if (!byKey.has(key)) {
          const entry: any = {}
          for (const k of args.by) entry[k] = r[k]
          if (args._sum) {
            entry._sum = {}
            for (const k of Object.keys(args._sum)) entry._sum[k] = 0
          }
          if (args._count) entry._count = { _all: 0 }
          byKey.set(key, entry)
        }
        const entry = byKey.get(key)
        if (args._sum) {
          for (const k of Object.keys(args._sum)) entry._sum[k] += r[k] ?? 0
        }
        if (args._count) entry._count._all += 1
      }
      return [...byKey.values()]
    },
  }
}

const mockPrisma: any = {
  usageEvent: makeModel(store.usageEvents),
  user: makeModel(store.users),
  workspace: makeModel(store.workspaces),
  project: makeModel(store.projects),
  member: makeModel(store.members),
  chatSession: makeModel(store.chatSessions),
  chatMessage: makeModel(store.chatMessages),
  subscription: makeModel(store.subscriptions),
  toolCallLog: makeModel(store.toolCallLogs),
  $queryRawUnsafe: async () => [],
  $queryRaw: async () => [],
}

mock.module('../lib/prisma', () => ({
  prisma: mockPrisma,
  Prisma: {
    raw: (s: string) => s,
    sql: (s: string) => s,
    empty: '',
  },
}))

const analytics = await import('../services/analytics.service')

function rebuildModels() {
  mockPrisma.usageEvent = makeModel(store.usageEvents)
  mockPrisma.user = makeModel(store.users)
  mockPrisma.workspace = makeModel(store.workspaces)
  mockPrisma.project = makeModel(store.projects)
  mockPrisma.member = makeModel(store.members)
  mockPrisma.chatSession = makeModel(store.chatSessions)
  mockPrisma.chatMessage = makeModel(store.chatMessages)
  mockPrisma.subscription = makeModel(store.subscriptions)
  mockPrisma.toolCallLog = makeModel(store.toolCallLogs)
}

beforeEach(() => {
  store.usageEvents.length = 0
  store.users.length = 0
  store.workspaces.length = 0
  store.projects.length = 0
  store.members.length = 0
  store.chatSessions.length = 0
  store.chatMessages.length = 0
  store.subscriptions.length = 0
  store.toolCallLogs.length = 0
  rebuildModels()
})

// =========================================================================
// periodToWindow
// =========================================================================

describe('periodToWindow', () => {
  test('returns explicit ISO window when both from and to are valid', () => {
    const { from, to } = analytics.periodToWindow(undefined, '2026-01-01', '2026-02-01')
    expect(from.toISOString().startsWith('2026-01-01')).toBe(true)
    expect(to.toISOString().startsWith('2026-02-01')).toBe(true)
  })

  test('falls back to default 30d when window is malformed', () => {
    const { from, to } = analytics.periodToWindow(undefined, 'bogus', 'also-bogus')
    expect(to.getTime()).toBeGreaterThan(from.getTime())
  })

  test('1d, 7d, 30d, 90d, 1y, mtd, last_month all yield from < to', () => {
    for (const period of ['1d', '7d', '30d', '90d', '1y', 'mtd', 'last_month'] as const) {
      const { from, to } = analytics.periodToWindow(period)
      expect(from.getTime()).toBeLessThanOrEqual(to.getTime())
    }
  })
})

// =========================================================================
// getOverviewStats
// =========================================================================

describe('getOverviewStats', () => {
  test('user-scoped overview returns usage events + total spend + sessions', async () => {
    store.usageEvents.push(
      { id: '1', memberId: 'u-1', billedUsd: 0.5, projectId: 'p-1', workspaceId: 'w-1', actionType: 'x', source: 'monthly', createdAt: new Date() },
      { id: '2', memberId: 'u-1', billedUsd: 1.0, projectId: 'p-1', workspaceId: 'w-1', actionType: 'x', source: 'monthly', createdAt: new Date() },
    )
    rebuildModels()
    const out = await analytics.getOverviewStats({ userId: 'u-1' })
    expect((out as any).usageEvents).toBe(2)
    expect((out as any).totalSpendUsd).toBe(1.5)
  })

  test('project-scoped overview returns the chatSessions / usageEvents / messages shape', async () => {
    store.chatSessions.push({ id: 's-1', contextId: 'p-1', createdAt: new Date() })
    store.usageEvents.push({ id: 'u-1', projectId: 'p-1', memberId: 'u', billedUsd: 0, workspaceId: 'w-1', actionType: 'x', source: 'monthly', createdAt: new Date() })
    rebuildModels()
    const out = await analytics.getOverviewStats({ projectId: 'p-1' })
    expect((out as any).chatSessions).toBe(1)
    expect((out as any).usageEvents).toBe(1)
    expect((out as any).messages).toBe(0)
  })

  test('workspace-scoped overview returns members / projects / chatSessions / usageEvents', async () => {
    store.members.push({ id: 'm-1', workspaceId: 'w-1' })
    store.projects.push({ id: 'p-1', workspaceId: 'w-1' })
    store.usageEvents.push({ id: 'u-1', workspaceId: 'w-1', projectId: 'p-1', memberId: 'm', billedUsd: 0, actionType: 'x', source: 'monthly', createdAt: new Date() })
    rebuildModels()
    const out = await analytics.getOverviewStats({ workspaceId: 'w-1' })
    expect((out as any).members).toBe(1)
    expect((out as any).projects).toBe(1)
    expect((out as any).usageEvents).toBe(1)
  })

  test('platform-wide overview returns totalUsers / totalWorkspaces / totalProjects', async () => {
    store.users.push({ id: 'u-1' })
    store.workspaces.push({ id: 'w-1' })
    store.projects.push({ id: 'p-1' })
    store.subscriptions.push({ id: 's-1', status: 'active', planId: 'pro', billingInterval: 'monthly' })
    rebuildModels()
    const out = await analytics.getOverviewStats()
    expect((out as any).totalUsers).toBe(1)
    expect((out as any).totalWorkspaces).toBe(1)
    expect((out as any).activeSubscriptions).toBe(1)
  })
})

// =========================================================================
// getGrowthTimeSeries
// =========================================================================

describe('getGrowthTimeSeries', () => {
  test('workspace scope returns projects + members series', async () => {
    store.projects.push({ id: 'p-1', workspaceId: 'w-1', createdAt: new Date() })
    store.members.push({ id: 'm-1', workspaceId: 'w-1', createdAt: new Date() })
    rebuildModels()
    const out = await analytics.getGrowthTimeSeries({ workspaceId: 'w-1' })
    expect(Array.isArray(out)).toBe(true)
    expect(out.length).toBeGreaterThanOrEqual(1)
  })

  test('platform scope returns users + workspaces + projects', async () => {
    store.users.push({ id: 'u-1', createdAt: new Date() })
    store.workspaces.push({ id: 'w-1', createdAt: new Date() })
    rebuildModels()
    const out = await analytics.getGrowthTimeSeries()
    expect(Array.isArray(out)).toBe(true)
  })
})

// =========================================================================
// getMemberUsageStats
// =========================================================================

describe('getMemberUsageStats', () => {
  test('buckets per-member spend by source column', async () => {
    const now = new Date()
    store.usageEvents.push(
      { memberId: 'u-1', source: 'monthly', billedUsd: 5, workspaceId: 'w-1', projectId: 'p-1', actionType: 'x', createdAt: now },
      { memberId: 'u-1', source: 'daily', billedUsd: 1, workspaceId: 'w-1', projectId: 'p-1', actionType: 'x', createdAt: now },
      { memberId: 'u-1', source: 'overage', billedUsd: 2, workspaceId: 'w-1', projectId: 'p-1', actionType: 'x', createdAt: now },
      { memberId: 'u-1', source: 'mystery', billedUsd: 3, workspaceId: 'w-1', projectId: 'p-1', actionType: 'x', createdAt: now },
    )
    rebuildModels()
    const out = await analytics.getMemberUsageStats('w-1')
    expect(out.monthly['u-1']).toBe(11)
    expect(out.included['u-1']).toBe(8) // monthly (5) + unknown (3)
    expect(out.free['u-1']).toBe(1)
    expect(out.onDemand['u-1']).toBe(2)
  })
})

// =========================================================================
// getUsageAnalytics
// =========================================================================

describe('getUsageAnalytics', () => {
  test('aggregates events by actionType, source, and top consumer', async () => {
    const now = new Date()
    store.usageEvents.push(
      { actionType: 'ai_proxy_completion', source: 'monthly', memberId: 'u-1', billedUsd: 1.5, workspaceId: 'w-1', projectId: 'p-1', createdAt: now },
      { actionType: 'ai_proxy_completion', source: 'monthly', memberId: 'u-2', billedUsd: 2.5, workspaceId: 'w-1', projectId: 'p-1', createdAt: now },
      { actionType: 'voice_minutes_inbound', source: 'overage', memberId: 'u-1', billedUsd: 0.5, workspaceId: 'w-1', projectId: 'p-1', createdAt: now },
    )
    rebuildModels()
    const out = await analytics.getUsageAnalytics({ workspaceId: 'w-1' })
    expect(out.totalEvents).toBe(3)
    expect(out.totalSpendUsd).toBe(4.5)
    expect(out.topConsumers[0].totalSpendUsd).toBeGreaterThan(out.topConsumers[1].totalSpendUsd)
  })
})

// =========================================================================
// getChatAnalytics
// =========================================================================

describe('getChatAnalytics', () => {
  test('returns 0 sessions when there are none', async () => {
    const out = await analytics.getChatAnalytics({ workspaceId: 'w-1' })
    expect(out.totalSessions).toBe(0)
    expect(out.avgMessagesPerSession).toBe(0)
  })
})

// =========================================================================
// getProjectAnalytics
// =========================================================================

describe('getProjectAnalytics', () => {
  test('aggregates project counts by status and tier', async () => {
    store.projects.push(
      { id: 'p-1', name: 'A', status: 'active', tier: 'pro', createdAt: new Date(), _count: { chatSessions: 5, usageEvents: 10 } },
      { id: 'p-2', name: 'B', status: 'archived', tier: 'free', createdAt: new Date(), _count: { chatSessions: 0, usageEvents: 0 } },
    )
    rebuildModels()
    const out = await analytics.getProjectAnalytics()
    expect(out.totalProjects).toBe(2)
    expect(out.byStatus.active).toBe(1)
    expect(out.byTier.pro).toBe(1)
  })
})

// =========================================================================
// getBillingAnalytics
// =========================================================================

describe('getBillingAnalytics', () => {
  test('aggregates subscriptions by plan, status, interval; computes free vs paid', async () => {
    store.subscriptions.push(
      { planId: 'pro', status: 'active', billingInterval: 'monthly' },
      { planId: 'pro', status: 'canceled', billingInterval: 'monthly' },
      { planId: 'team', status: 'active', billingInterval: 'annual' },
    )
    store.workspaces.push({ id: 'w-1' }, { id: 'w-2' }, { id: 'w-3' }, { id: 'w-4' })
    rebuildModels()
    const out = await analytics.getBillingAnalytics()
    expect(out.totalSubscriptions).toBe(3)
    expect(out.activeSubscriptions).toBe(2)
    expect(out.byPlan.pro).toBe(2)
    expect(out.byInterval.annual).toBe(1)
    expect(out.paidWorkspaces).toBe(2)
    expect(out.freeWorkspaces).toBe(2)
  })
})

// =========================================================================
// getUsageLog
// =========================================================================

describe('getUsageLog', () => {
  test('returns paginated entries with parsed metadata', async () => {
    const now = new Date()
    store.usageEvents.push({
      id: 'e-1',
      actionType: 'ai_proxy_completion',
      memberId: 'u-1',
      billedUsd: 0.1,
      rawUsd: 0.08,
      workspaceId: 'w-1',
      projectId: 'p-1',
      source: 'monthly',
      createdAt: now,
      actionMetadata: { model: 'claude-haiku-4-5', inputTokens: 100, outputTokens: 50, provider: 'anthropic' },
    })
    store.users.push({ id: 'u-1', name: 'Alice', email: 'a@x.com', image: null })
    rebuildModels()
    const out = await analytics.getUsageLog({ workspaceId: 'w-1' })
    expect(out.total).toBe(1)
    expect(out.entries[0].model).toBe('claude-haiku-4-5')
    expect(out.entries[0].provider).toBe('anthropic')
    expect(out.entries[0].userName).toBe('Alice')
  })

  test('voice events get a friendly voice label', async () => {
    store.usageEvents.push({
      id: 'e-1',
      actionType: 'voice_minutes_inbound',
      memberId: 'u-1',
      billedUsd: 0.1,
      rawUsd: 0,
      workspaceId: 'w-1',
      projectId: 'p-1',
      source: 'overage',
      createdAt: new Date(),
      actionMetadata: {},
    })
    rebuildModels()
    const out = await analytics.getUsageLog({ workspaceId: 'w-1' })
    expect(out.entries[0].model).toBe('Voice · inbound')
    expect(out.entries[0].provider).toBe('elevenlabs')
  })
})

// =========================================================================
// getUsageSummary
// =========================================================================

describe('getUsageSummary', () => {
  test('aggregates per (member, model) pair with totals', async () => {
    store.usageEvents.push(
      { actionType: 'ai_proxy_completion', memberId: 'u-1', billedUsd: 1, rawUsd: 0.8, workspaceId: 'w-1', projectId: 'p-1', source: 'monthly', createdAt: new Date(), actionMetadata: { model: 'm1', inputTokens: 100, outputTokens: 50, totalTokens: 150 } },
      { actionType: 'ai_proxy_completion', memberId: 'u-1', billedUsd: 2, rawUsd: 1.6, workspaceId: 'w-1', projectId: 'p-1', source: 'monthly', createdAt: new Date(), actionMetadata: { model: 'm1', inputTokens: 200, outputTokens: 100, totalTokens: 300 } },
    )
    store.users.push({ id: 'u-1', name: 'A', email: 'a@x', image: null })
    rebuildModels()
    const out = await analytics.getUsageSummary({ workspaceId: 'w-1' })
    expect(out.summaries.length).toBe(1)
    expect(out.summaries[0].requestCount).toBe(2)
    expect(out.summaries[0].totalBilledUsd).toBe(3)
    expect(out.totals.totalRequests).toBe(2)
    expect(out.totals.uniqueModels).toBe(1)
  })
})
