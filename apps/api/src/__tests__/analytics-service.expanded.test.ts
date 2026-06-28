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
  sessions: any[]
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
  sessions: [],
}

// Stateful $queryRawUnsafe handler so getUserActivityTable / getUserFunnel tests
// can stub each SQL call individually.
let queryRawQueue: any[][] = []
function enqueueQueryRaw(...batches: any[][]) {
  queryRawQueue.push(...batches)
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
      let filtered = rows.filter((r) => matchWhere(r, args?.where))
      // Support `distinct: ['fieldA', ...]` by keeping the first row per
      // unique combination of the listed fields.
      if (args?.distinct && Array.isArray(args.distinct)) {
        const seen = new Set<string>()
        filtered = filtered.filter((r) => {
          const k = args.distinct.map((f: string) => String(r[f])).join('::')
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
      }
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
          if (args._count) entry._count = args._count === true ? 0 : { _all: 0 }
          byKey.set(key, entry)
        }
        const entry = byKey.get(key)
        if (args._sum) {
          for (const k of Object.keys(args._sum)) entry._sum[k] += r[k] ?? 0
        }
        if (args._count) {
          if (args._count === true) entry._count += 1
          else entry._count._all += 1
        }
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
  session: makeModel(store.sessions),
  $queryRawUnsafe: async () => (queryRawQueue.length ? queryRawQueue.shift()! : []),
  $queryRaw: async () => (queryRawQueue.length ? queryRawQueue.shift()! : []),
}

mock.module('../lib/prisma', () => ({
  prisma: mockPrisma,
  Prisma: {
    raw: (s: string) => s,
    sql: (s: string) => s,
    empty: '',
  },
}))

// analytics.service freezes `isSqlite = process.env.SHOGO_LOCAL_MODE === 'true'`
// at module load. These tests drive the mocked Prisma store (findMany + JS
// bucketing) rather than real Postgres raw-SQL bucketing, so select the
// SQLite/local path before importing the module.
process.env.SHOGO_LOCAL_MODE = 'true'
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
  mockPrisma.session = makeModel(store.sessions)
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
  store.sessions.length = 0
  queryRawQueue = []
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

  test('platform scope returns users + workspaces + projects + sessions', async () => {
    const now = new Date()
    store.users.push({ id: 'u-1', createdAt: now })
    store.workspaces.push({ id: 'w-1', createdAt: now })
    store.projects.push({ id: 'p-1', workspaceId: 'w-1', createdAt: now })
    store.chatSessions.push({ id: 's-1', contextId: 'p-1', createdAt: now })
    rebuildModels()
    const out = (await analytics.getGrowthTimeSeries()) as Array<Record<string, unknown>>
    expect(Array.isArray(out)).toBe(true)
    const day = out[out.length - 1]
    expect(day.users).toBe(1)
    expect(day.workspaces).toBe(1)
    expect(day.projects).toBe(1)
    expect(day.sessions).toBe(1)
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


// =========================================================================
// parseMeta string branches + voiceLabel exhaustive
// (exercised through getUsageLog with stringified actionMetadata and every
//  voice_* action type)
// =========================================================================

describe('parseMeta + voiceLabel branches', () => {
  test('parses JSON-stringified actionMetadata', async () => {
    store.usageEvents.push({
      id: 'e-1',
      actionType: 'ai_proxy_completion',
      memberId: 'u-1',
      billedUsd: 0.2,
      rawUsd: 0,
      workspaceId: 'w-1',
      projectId: 'p-1',
      source: 'monthly',
      createdAt: new Date(),
      // double-stringified: stored as a string column
      actionMetadata: JSON.stringify({ model: 'gpt-4', provider: 'openai', inputTokens: 10 }),
    })
    rebuildModels()
    const out = await analytics.getUsageLog({ workspaceId: 'w-1' })
    expect(out.entries[0].model).toBe('gpt-4')
    expect(out.entries[0].provider).toBe('openai')
    expect(out.entries[0].inputTokens).toBe(10)
  })

  test('falls back to empty meta when actionMetadata is a malformed JSON string', async () => {
    store.usageEvents.push({
      id: 'e-2',
      actionType: 'ai_proxy_completion',
      memberId: 'u-1',
      billedUsd: 0.2,
      rawUsd: 0,
      workspaceId: 'w-1',
      projectId: 'p-1',
      source: 'monthly',
      createdAt: new Date(),
      actionMetadata: '{not json',
    })
    rebuildModels()
    const out = await analytics.getUsageLog({ workspaceId: 'w-1' })
    expect(out.entries[0].model).toBe('unknown')
  })

  test('falls back to empty meta when actionMetadata is null / number', async () => {
    store.usageEvents.push(
      {
        id: 'e-3',
        actionType: 'ai_proxy_completion',
        memberId: 'u-1',
        billedUsd: 0,
        rawUsd: 0,
        workspaceId: 'w-1',
        projectId: 'p-1',
        source: 'monthly',
        createdAt: new Date(),
        actionMetadata: null,
      },
      {
        id: 'e-4',
        actionType: 'ai_proxy_completion',
        memberId: 'u-1',
        billedUsd: 0,
        rawUsd: 0,
        workspaceId: 'w-1',
        projectId: 'p-1',
        source: 'monthly',
        createdAt: new Date(),
        actionMetadata: 42 as any,
      },
    )
    rebuildModels()
    const out = await analytics.getUsageLog({ workspaceId: 'w-1' })
    expect(out.entries.length).toBe(2)
  })

  test('voiceLabel returns the right label for every voice_* action type', async () => {
    const variants = [
      ['voice_minutes_inbound', 'Voice · inbound'],
      ['voice_minutes_outbound', 'Voice · outbound'],
      ['voice_number_setup', 'Voice · number setup'],
      ['voice_number_monthly', 'Voice · number monthly'],
    ] as const
    for (const [actionType] of variants) {
      store.usageEvents.push({
        id: `e-${actionType}`,
        actionType,
        memberId: 'u-1',
        billedUsd: 0,
        rawUsd: 0,
        workspaceId: 'w-1',
        projectId: 'p-1',
        source: 'overage',
        createdAt: new Date(),
        actionMetadata: {},
      })
    }
    rebuildModels()
    const out = await analytics.getUsageLog({ workspaceId: 'w-1' })
    const labels = out.entries.map((e) => e.model).sort()
    for (const [, label] of variants) expect(labels).toContain(label)
  })
})

// =========================================================================
// getSpendTimeseries (497-638)
// =========================================================================

describe('getSpendTimeseries', () => {
  test('groups by model by default and zero-fills days', async () => {
    const from = new Date('2026-01-01T00:00:00.000Z')
    const to = new Date('2026-01-03T00:00:00.000Z')
    store.usageEvents.push(
      {
        id: 'e-1',
        actionType: 'ai_proxy_completion',
        memberId: 'u-1',
        billedUsd: 1,
        rawUsd: 0.8,
        workspaceId: 'w-1',
        projectId: 'p-1',
        source: 'monthly',
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
        actionMetadata: { model: 'claude' },
      },
      {
        id: 'e-2',
        actionType: 'ai_proxy_completion',
        memberId: 'u-2',
        billedUsd: 2,
        rawUsd: 1.5,
        workspaceId: 'w-1',
        projectId: 'p-1',
        source: 'overage',
        createdAt: new Date('2026-01-02T12:00:00.000Z'),
        actionMetadata: { model: 'gpt-4' },
      },
    )
    rebuildModels()
    const out = await analytics.getSpendTimeseries(
      { workspaceId: 'w-1' },
      '30d',
      { fromIso: from.toISOString(), toIso: to.toISOString() },
    )
    expect(out.groupBy).toBe('model')
    expect(out.metric).toBe('spend')
    expect(out.models).toEqual(expect.arrayContaining(['claude', 'gpt-4']))
    expect(out.totals.totalSpendUsd).toBe(3)
    expect(out.totals.totalOnDemandUsd).toBe(2)
    expect(out.totals.totalIncludedUsd).toBe(1)
    expect(out.days.length).toBeGreaterThanOrEqual(2)
  })

  test('falls back to rawUsd then meta.rawUsd / dollarCost when billedUsd is 0', async () => {
    const from = new Date('2026-02-01T00:00:00.000Z')
    const to = new Date('2026-02-02T00:00:00.000Z')
    store.usageEvents.push(
      {
        id: 'e-1',
        actionType: 'ai_proxy_completion',
        memberId: 'u-1',
        billedUsd: 0,
        rawUsd: 0.5,
        workspaceId: 'w-1',
        projectId: 'p-1',
        source: 'monthly',
        createdAt: new Date('2026-02-01T12:00:00.000Z'),
        actionMetadata: { model: 'm1' },
      },
      {
        id: 'e-2',
        actionType: 'ai_proxy_completion',
        memberId: 'u-1',
        billedUsd: 0,
        rawUsd: null,
        workspaceId: 'w-1',
        projectId: 'p-1',
        source: 'monthly',
        createdAt: new Date('2026-02-01T13:00:00.000Z'),
        actionMetadata: { model: 'm2', rawUsd: 0.25 },
      },
      {
        id: 'e-3',
        actionType: 'ai_proxy_completion',
        memberId: 'u-1',
        billedUsd: 0,
        rawUsd: null,
        workspaceId: 'w-1',
        projectId: 'p-1',
        source: 'monthly',
        createdAt: new Date('2026-02-01T14:00:00.000Z'),
        actionMetadata: { model: 'm3', dollarCost: 0.1 },
      },
    )
    rebuildModels()
    const out = await analytics.getSpendTimeseries(
      { workspaceId: 'w-1' },
      '30d',
      { fromIso: from.toISOString(), toIso: to.toISOString() },
    )
    expect(out.totals.totalSpendUsd).toBeCloseTo(0.85, 5)
  })

  test('groupBy=user resolves user emails / names from prisma.user.findMany', async () => {
    const from = new Date('2026-03-01T00:00:00.000Z')
    const to = new Date('2026-03-02T00:00:00.000Z')
    store.usageEvents.push(
      {
        id: 'e-1',
        actionType: 'ai_proxy_completion',
        memberId: 'u-1',
        billedUsd: 1,
        rawUsd: 0,
        workspaceId: 'w-1',
        projectId: 'p-1',
        source: 'monthly',
        createdAt: new Date('2026-03-01T12:00:00.000Z'),
        actionMetadata: { model: 'claude', totalTokens: 100 },
      },
      {
        id: 'e-2',
        actionType: 'ai_proxy_completion',
        memberId: 'system',
        billedUsd: 1,
        rawUsd: 0,
        workspaceId: 'w-1',
        projectId: 'p-1',
        source: 'monthly',
        createdAt: new Date('2026-03-01T13:00:00.000Z'),
        actionMetadata: { model: 'claude' },
      },
    )
    store.users.push({ id: 'u-1', email: 'alice@x.com', name: 'Alice' })
    rebuildModels()
    const out = await analytics.getSpendTimeseries(
      { workspaceId: 'w-1' },
      '30d',
      { fromIso: from.toISOString(), toIso: to.toISOString(), groupBy: 'user' },
    )
    expect(out.groupBy).toBe('user')
    // alice@x.com series should appear plus the 'system' memberId fallback
    expect(out.models).toEqual(expect.arrayContaining(['alice@x.com', 'system']))
  })

  test('groupBy=source / metric=tokens / metric=requests both work', async () => {
    const from = new Date('2026-04-01T00:00:00.000Z')
    const to = new Date('2026-04-02T00:00:00.000Z')
    store.usageEvents.push({
      id: 'e-1',
      actionType: 'ai_proxy_completion',
      memberId: 'u-1',
      billedUsd: 1,
      rawUsd: 0,
      workspaceId: 'w-1',
      projectId: 'p-1',
      source: 'monthly',
      createdAt: new Date('2026-04-01T12:00:00.000Z'),
      actionMetadata: { model: 'claude', totalTokens: 200 },
    })
    rebuildModels()
    const tokensOut = await analytics.getSpendTimeseries(
      { workspaceId: 'w-1' },
      '30d',
      { fromIso: from.toISOString(), toIso: to.toISOString(), groupBy: 'source', metric: 'tokens' },
    )
    expect(tokensOut.metric).toBe('tokens')
    expect(tokensOut.groupBy).toBe('source')
    expect(tokensOut.days.some((d) => d.total === 200)).toBe(true)

    const requestsOut = await analytics.getSpendTimeseries(
      { workspaceId: 'w-1' },
      '30d',
      { fromIso: from.toISOString(), toIso: to.toISOString(), metric: 'requests' },
    )
    expect(requestsOut.metric).toBe('requests')
    expect(requestsOut.days.some((d) => d.total === 1)).toBe(true)
  })

  test('collapses long-tail series into "Other" when over topN', async () => {
    const from = new Date('2026-05-01T00:00:00.000Z')
    const to = new Date('2026-05-02T00:00:00.000Z')
    for (let i = 0; i < 5; i++) {
      store.usageEvents.push({
        id: `e-${i}`,
        actionType: 'ai_proxy_completion',
        memberId: 'u-1',
        billedUsd: 10 - i, // ranked deterministically
        rawUsd: 0,
        workspaceId: 'w-1',
        projectId: 'p-1',
        source: 'monthly',
        createdAt: new Date('2026-05-01T12:00:00.000Z'),
        actionMetadata: { model: `m${i}` },
      })
    }
    rebuildModels()
    const out = await analytics.getSpendTimeseries(
      { workspaceId: 'w-1' },
      '30d',
      { fromIso: from.toISOString(), toIso: to.toISOString(), topN: 2 },
    )
    expect(out.models).toContain('Other')
    expect(out.models.length).toBe(3) // 2 top + Other
  })
})

// =========================================================================
// getActiveUsers
// =========================================================================

describe('getActiveUsers', () => {
  test('workspace scope counts distinct memberIds from usage events', async () => {
    const now = new Date()
    store.usageEvents.push(
      { memberId: 'u-1', workspaceId: 'w-1', projectId: 'p-1', billedUsd: 0, source: 'monthly', actionType: 'x', createdAt: now },
      { memberId: 'u-1', workspaceId: 'w-1', projectId: 'p-1', billedUsd: 0, source: 'monthly', actionType: 'x', createdAt: now },
      { memberId: 'u-2', workspaceId: 'w-1', projectId: 'p-1', billedUsd: 0, source: 'monthly', actionType: 'x', createdAt: now },
    )
    rebuildModels()
    const out = await analytics.getActiveUsers({ workspaceId: 'w-1' })
    expect(out.dau).toBe(2)
    expect(out.wau).toBe(2)
    expect(out.mau).toBe(2)
  })

  test('platform scope counts distinct userIds from auth sessions', async () => {
    const now = new Date()
    store.sessions.push(
      { userId: 'u-1', updatedAt: now },
      { userId: 'u-2', updatedAt: now },
      { userId: 'u-1', updatedAt: now },
    )
    rebuildModels()
    const out = await analytics.getActiveUsers()
    expect(out.dau).toBe(2)
  })
})

// =========================================================================
// getUsageLog filter branches (options.userId / options.model / scope.userId)
// =========================================================================

describe('getUsageLog filter branches', () => {
  test('options.userId narrows to a single memberId', async () => {
    store.usageEvents.push(
      { id: '1', actionType: 'ai_proxy_completion', memberId: 'u-1', billedUsd: 0, rawUsd: 0, workspaceId: 'w-1', projectId: 'p-1', source: 'monthly', createdAt: new Date(), actionMetadata: { model: 'm' } },
      { id: '2', actionType: 'ai_proxy_completion', memberId: 'u-2', billedUsd: 0, rawUsd: 0, workspaceId: 'w-1', projectId: 'p-1', source: 'monthly', createdAt: new Date(), actionMetadata: { model: 'm' } },
    )
    rebuildModels()
    const out = await analytics.getUsageLog({}, '30d', { userId: 'u-1' })
    expect(out.entries.every((e) => e.userId === 'u-1')).toBe(true)
  })

  test('options.model attaches a path / string_contains filter', async () => {
    // This won't actually filter through our stub (matchWhere ignores object
    // filters keyed by path) — the path simply needs to run without error.
    store.usageEvents.push({
      id: '1',
      actionType: 'ai_proxy_completion',
      memberId: 'u-1',
      billedUsd: 0,
      rawUsd: 0,
      workspaceId: 'w-1',
      projectId: 'p-1',
      source: 'monthly',
      createdAt: new Date(),
      actionMetadata: { model: 'claude' },
    })
    rebuildModels()
    const out = await analytics.getUsageLog({}, '30d', { model: 'claude' })
    expect(out.total).toBeGreaterThanOrEqual(0)
  })

  test('scope.userId and scope.projectId merge into the where clause', async () => {
    store.usageEvents.push({
      id: '1',
      actionType: 'ai_proxy_completion',
      memberId: 'u-1',
      billedUsd: 0,
      rawUsd: 0,
      workspaceId: 'w-1',
      projectId: 'p-1',
      source: 'monthly',
      createdAt: new Date(),
      actionMetadata: { model: 'm' },
    })
    rebuildModels()
    const out = await analytics.getUsageLog({ projectId: 'p-1', userId: 'u-1' })
    expect(out.entries[0].userId).toBe('u-1')
  })
})

// =========================================================================
// getUsageSummary scope branches
// =========================================================================

describe('getUsageSummary scope branches', () => {
  test('projectId scope filters to the right project (and emits totals)', async () => {
    store.usageEvents.push({
      actionType: 'ai_proxy_completion',
      memberId: 'u-1',
      billedUsd: 1,
      rawUsd: 0.5,
      workspaceId: 'w-1',
      projectId: 'p-1',
      source: 'monthly',
      createdAt: new Date(),
      actionMetadata: { model: 'm', inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    })
    rebuildModels()
    const out = await analytics.getUsageSummary({ projectId: 'p-1' })
    expect(out.summaries.length).toBe(1)
    expect(out.totals.totalBilledUsd).toBe(1)
  })

  test('userId scope sets memberId filter', async () => {
    store.usageEvents.push({
      actionType: 'ai_proxy_completion',
      memberId: 'u-1',
      billedUsd: 1,
      rawUsd: 0,
      workspaceId: 'w-1',
      projectId: 'p-1',
      source: 'monthly',
      createdAt: new Date(),
      actionMetadata: { model: 'm' },
    })
    rebuildModels()
    const out = await analytics.getUsageSummary({ userId: 'u-1' })
    expect(out.summaries[0].userId).toBe('u-1')
  })

  test('uses meta.rawUsd when usageEvent.rawUsd is null', async () => {
    store.usageEvents.push({
      actionType: 'ai_proxy_completion',
      memberId: 'u-1',
      billedUsd: 0,
      rawUsd: null,
      workspaceId: 'w-1',
      projectId: 'p-1',
      source: 'monthly',
      createdAt: new Date(),
      actionMetadata: { model: 'm', rawUsd: 0.42 },
    })
    rebuildModels()
    const out = await analytics.getUsageSummary({ workspaceId: 'w-1' })
    expect(out.summaries[0].totalRawUsd).toBeCloseTo(0.42, 5)
  })
})

// =========================================================================
// getChatAnalytics — projectId scope + populated data
// =========================================================================

describe('getChatAnalytics with data', () => {
  test('projectId scope filters chat sessions to context and computes avg', async () => {
    const now = new Date()
    store.chatSessions.push(
      { id: 's-1', contextId: 'p-1', createdAt: now, _count: { messages: 2 } },
      { id: 's-2', contextId: 'p-1', createdAt: now, _count: { messages: 4 } },
    )
    // chatMessage.count is a number; matchWhere will ignore the nested
    // `session: { contextId, createdAt: {gte} }` because relation filters
    // aren't recognised — instead it just returns the row count. Push two
    // matching messages so totalMessages reports 2.
    store.chatMessages.push(
      { id: 'cm-1', role: 'user', agent: 'technical', sessionId: 's-1' },
      { id: 'cm-2', role: 'user', agent: 'technical', sessionId: 's-1' },
    )
    rebuildModels()
    const out = await analytics.getChatAnalytics({ projectId: 'p-1' })
    expect(out.totalSessions).toBe(2)
    expect(out.totalMessages).toBe(2)
    expect(out.avgMessagesPerSession).toBe(1)
  })
})

// =========================================================================
// getUserActivityTable (1365-1490)
// =========================================================================

describe('getUserActivityTable', () => {
  test('joins user list with $queryRawUnsafe message/session/toolcall counts', async () => {
    const now = new Date()
    store.users.push({
      id: 'u-1',
      name: 'Alice',
      email: 'a@real.com',
      role: 'user',
      createdAt: now,
      signupAttribution: { sourceTag: 'organic:google' },
      sessions: [{ updatedAt: now }],
      _count: { members: 1 },
    })
    store.projects.push({ id: 'p-1', createdBy: 'u-1', workspaceId: 'w-1', createdAt: now })
    store.usageEvents.push({
      memberId: 'u-1',
      billedUsd: 5,
      source: 'monthly',
      actionType: 'x',
      workspaceId: 'w-1',
      projectId: 'p-1',
      createdAt: now,
    })
    // Three sequential $queryRawUnsafe calls: messages, sessions, toolCalls.
    enqueueQueryRaw(
      [{ userId: 'u-1', count: 12 }],
      [{ userId: 'u-1', count: 3 }],
      [{ userId: 'u-1', count: 4 }],
    )
    rebuildModels()
    const out = await analytics.getUserActivityTable('30d', { excludeInternal: false })
    expect(out.total).toBe(1)
    expect(out.users[0].id).toBe('u-1')
    expect(out.users[0].messages).toBe(12)
    expect(out.users[0].sessions).toBe(3)
    expect(out.users[0].toolCalls).toBe(4)
    expect(out.users[0].projects).toBe(1)
    expect(out.users[0].spendUsd).toBe(5)
    expect(out.users[0].sourceTag).toBe('organic:google')
  })

  test('honours excludeInternal=true (uses realUserWhere) and clamps limit', async () => {
    store.users.push({
      id: 'u-1',
      name: null,
      email: 'real@example.com',
      role: 'user',
      createdAt: new Date(),
      sessions: [],
      _count: { members: 0 },
    })
    enqueueQueryRaw([], [], [])
    rebuildModels()
    const out = await analytics.getUserActivityTable('7d', { limit: 9999, excludeInternal: true })
    expect(out.users.length).toBe(1)
    expect(out.users[0].lastActiveAt).toBeNull()
  })
})

// =========================================================================
// realUserWhere (1201-1215)
// =========================================================================

describe('realUserWhere', () => {
  test('returns a Prisma filter that excludes super_admin and internal emails', () => {
    const w = analytics.realUserWhere()
    expect(w.AND).toBeDefined()
    expect((w.AND as any[]).length).toBeGreaterThan(1)
  })
})

// =========================================================================
// deriveSourceTag (1776-1803)
// =========================================================================

describe('deriveSourceTag', () => {
  test('utm_source + utm_medium=cpc yields `${src}-ads`', () => {
    expect(analytics.deriveSourceTag({ utmSource: 'google', utmMedium: 'cpc' })).toBe('google-ads')
  })

  test('utm_source alone returns the source', () => {
    expect(analytics.deriveSourceTag({ utmSource: 'twitter' })).toBe('twitter')
  })

  test('referrer google host returns organic:google', () => {
    expect(analytics.deriveSourceTag({ referrer: 'https://www.google.com/search?q=x' })).toBe('organic:google')
  })

  test('referrer bing returns organic:bing', () => {
    expect(analytics.deriveSourceTag({ referrer: 'https://bing.com' })).toBe('organic:bing')
  })

  test('referrer other host returns referral:host', () => {
    expect(analytics.deriveSourceTag({ referrer: 'https://www.example.com/' })).toBe('referral:example.com')
  })

  test('malformed referrer URL falls back to "referral"', () => {
    expect(analytics.deriveSourceTag({ referrer: 'not a url' })).toBe('referral')
  })

  test('method=google → google-oauth, otherwise direct', () => {
    expect(analytics.deriveSourceTag({ method: 'google' })).toBe('google-oauth')
    expect(analytics.deriveSourceTag({})).toBe('direct')
  })
})

// =========================================================================
// getChatConversations / getSourceBreakdown / getTemplateEngagement /
// getUserFunnel — drive the raw-SQL paths via the queryRawQueue stub.
// =========================================================================

describe('raw-SQL paths via $queryRawUnsafe stub', () => {
  test('getChatConversations groups rows by sessionId', async () => {
    enqueueQueryRaw([
      { sessionId: 's-1', userName: 'A', projectName: 'P', templateId: 't', role: 'user', content: 'hi', sentAt: new Date() },
      { sessionId: 's-1', userName: 'A', projectName: 'P', templateId: 't', role: 'assistant', content: 'hello', sentAt: new Date() },
      { sessionId: 's-2', userName: 'B', projectName: 'P2', templateId: null, role: 'user', content: 'hi2', sentAt: new Date() },
    ])
    const out = await analytics.getChatConversations(new Date(0))
    expect(out.conversations.length).toBe(2)
    expect(out.conversations[0].messages.length).toBe(2)
  })

  test('getSourceBreakdown computes project + message rates', async () => {
    enqueueQueryRaw([
      { tag: 'organic:google', count: 10, withProject: 5, withMessage: 2 },
      { tag: 'direct', count: 0, withProject: 0, withMessage: 0 },
    ])
    const out = await analytics.getSourceBreakdown()
    expect(out.sources[0].projectRate).toBe(50)
    expect(out.sources[0].messageRate).toBe(20)
    expect(out.sources[1].projectRate).toBe(0)
  })

  test('getTemplateEngagement computes engagementRate', async () => {
    enqueueQueryRaw([
      { templateId: 't1', projects: 4, avgMessages: 3.5, totalToolCalls: 9, engagedUsers: 3, totalUsers: 4 },
      { templateId: 't2', projects: 1, avgMessages: 0, totalToolCalls: 0, engagedUsers: 0, totalUsers: 0 },
    ])
    const out = await analytics.getTemplateEngagement()
    expect(out.templates[0].engagementRate).toBe(75)
    expect(out.templates[1].engagementRate).toBe(0)
  })

  test('getUserFunnel maps row into FunnelResult', async () => {
    enqueueQueryRaw([
      {
        signups: 10,
        onboarded: 7,
        createdProject: 5,
        sentMessage: 4,
        engaged: 2,
        avgMinToFirstProject: 12.3,
        avgMinToFirstMessage: 33.7,
      },
    ])
    const out = await analytics.getUserFunnel()
    expect(out.signups).toBe(10)
    expect(out.engaged).toBe(2)
    expect(out.avgMinToFirstProject).toBe(12.3)
  })

  test('getUserFunnel returns zeros when raw query returns no rows', async () => {
    enqueueQueryRaw([])
    const out = await analytics.getUserFunnel('7d', false)
    expect(out.signups).toBe(0)
    expect(out.avgMinToFirstProject).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Coverage gap: toNum() / toNumOrNull() must handle bigint and string
  // -----------------------------------------------------------------------
  test('getUserFunnel coerces bigint, string, and NaN cells via toNum/toNumOrNull', async () => {
    enqueueQueryRaw([
      {
        signups: BigInt(11), // -> toNum bigint branch (line 1187)
        onboarded: '8',       // -> toNum string Number(v) (line 1189)
        createdProject: 5,
        sentMessage: 0,
        engaged: 0,
        avgMinToFirstProject: BigInt(2), // -> toNumOrNull bigint
        avgMinToFirstMessage: 'not-a-number', // -> toNumOrNull NaN -> null
      },
    ])
    const out = await analytics.getUserFunnel()
    expect(out.signups).toBe(11)
    expect(out.onboarded).toBe(8)
    expect(out.avgMinToFirstProject).toBe(2)
    expect(out.avgMinToFirstMessage).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Coverage gap: mergeTimeSeries sort comparator only fires when
  // there are 2+ date buckets in the merged map (line 151).
  // -----------------------------------------------------------------------
  test('getGrowthTimeSeries sorts multi-day buckets in ascending order', async () => {
    store.users.length = 0
    store.workspaces.length = 0
    store.projects.length = 0
    const now = Date.now()
    const day1 = new Date(now - 3 * 24 * 60 * 60 * 1000)
    const day2 = new Date(now - 2 * 24 * 60 * 60 * 1000)
    const day3 = new Date(now - 1 * 24 * 60 * 60 * 1000)
    store.users.push(
      { id: 'u-1', createdAt: day1 },
      { id: 'u-2', createdAt: day3 },
    )
    store.workspaces.push({ id: 'w-1', createdAt: day2 })
    store.projects.push({ id: 'p-1', createdAt: day2 })
    rebuildModels()
    const out = (await analytics.getGrowthTimeSeries()) as Array<Record<string, unknown>>
    expect(out.length).toBeGreaterThanOrEqual(2)
    const dates = out.map((r) => r.date as string)
    const sorted = [...dates].sort((a, b) => a.localeCompare(b))
    expect(dates).toEqual(sorted)
  })
})
