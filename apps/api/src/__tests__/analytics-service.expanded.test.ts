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
  apiKeys: any[]
  appInstalls: any[]
  deviceVersionEvents: any[]
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
  apiKeys: [],
  appInstalls: [],
  deviceVersionEvents: [],
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
    if (k === 'NOT') {
      if (matchWhere(row, v)) return false
      continue
    }
    const rv = row[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if ('endsWith' in v && !(typeof rv === 'string' && rv.toLowerCase().endsWith(String(v.endsWith).toLowerCase()))) return false
      if ('contains' in v && !(typeof rv === 'string' && rv.toLowerCase().includes(String(v.contains).toLowerCase()))) return false
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
  apiKey: makeModel(store.apiKeys),
  appInstall: makeModel(store.appInstalls),
  deviceVersionEvent: makeModel(store.deviceVersionEvents),
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
  mockPrisma.apiKey = makeModel(store.apiKeys)
  mockPrisma.appInstall = makeModel(store.appInstalls)
  mockPrisma.deviceVersionEvent = makeModel(store.deviceVersionEvents)
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
  store.apiKeys.length = 0
  store.appInstalls.length = 0
  store.deviceVersionEvents.length = 0
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
    store.members.push({ id: 'm-1', workspaceId: 'w-1', projectId: null })
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

  test('the Total Users tile leaves internal accounts out (SHO-258 §7)', async () => {
    // The headline number the card was opened about: Shogo, the test domain and
    // every Odin domain are internal and must not be counted as users.
    store.users.push(
      { id: 'u-real', email: 'real@example.com', role: 'user' },
      { id: 'u-shogo', email: 'dev@shogo.ai', role: 'user' },
      { id: 'u-test', email: 'qa@test.shogo.ai', role: 'user' },
      { id: 'u-odin-ai', email: 'russell@getodin.ai', role: 'user' },
      { id: 'u-odin-io', email: 'someone@getodin.io', role: 'user' },
      { id: 'u-admin', email: 'ops@elsewhere.com', role: 'super_admin' },
    )
    rebuildModels()
    const out = await analytics.getOverviewStats()
    expect((out as any).totalUsers).toBe(1)
  })
})

// =========================================================================
// getGrowthTimeSeries
// =========================================================================

describe('getGrowthTimeSeries', () => {
  test('workspace scope returns projects + members series', async () => {
    store.projects.push({ id: 'p-1', workspaceId: 'w-1', createdAt: new Date() })
    store.members.push({ id: 'm-1', workspaceId: 'w-1', projectId: null, createdAt: new Date() })
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

  test('the platform growth curve leaves internal accounts out (SHO-258 §7)', async () => {
    const now = new Date()
    store.users.push(
      { id: 'u-real', email: 'real@example.com', role: 'user', createdAt: now },
      { id: 'u-shogo', email: 'dev@shogo.ai', role: 'user', createdAt: now },
      { id: 'u-odin', email: 'russell@getodin.ai', role: 'user', createdAt: now },
    )
    rebuildModels()
    const out = (await analytics.getGrowthTimeSeries()) as Array<Record<string, unknown>>
    const totalUsersPoints = out.reduce((s, p) => s + Number(p.users ?? 0), 0)
    expect(totalUsersPoints).toBe(1)
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
// getDesktopInstalls
// =========================================================================

describe('getDesktopInstalls', () => {
  test('deduplicates devices, excludes revoked/non-device keys, and aggregates activity', async () => {
    const now = Date.now()
    store.apiKeys.push(
      {
        kind: 'device',
        revokedAt: null,
        deviceId: 'desktop-1',
        devicePlatform: 'darwin',
        deviceAppVersion: '1.2.19',
        lastSeenAt: new Date(now - 10 * 24 * 60 * 60 * 1000),
        createdAt: new Date(now - 40 * 24 * 60 * 60 * 1000),
        userId: 'user-old',
      },
      {
        kind: 'device',
        revokedAt: null,
        deviceId: 'desktop-1',
        devicePlatform: 'darwin',
        deviceAppVersion: '1.2.20',
        lastSeenAt: new Date(now - 60 * 60 * 1000),
        createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000),
        userId: 'user-current',
      },
      {
        kind: 'device',
        revokedAt: null,
        deviceId: 'desktop-2',
        devicePlatform: 'win32',
        deviceAppVersion: '1.2.19',
        lastSeenAt: new Date(now - 8 * 24 * 60 * 60 * 1000),
        createdAt: new Date(now - 40 * 24 * 60 * 60 * 1000),
        userId: 'user-two',
      },
      {
        kind: 'device',
        revokedAt: null,
        deviceId: 'desktop-3',
        devicePlatform: null,
        deviceAppVersion: null,
        lastSeenAt: new Date(now - 40 * 24 * 60 * 60 * 1000),
        createdAt: new Date(now - 5 * 24 * 60 * 60 * 1000),
        userId: 'user-three',
      },
      {
        kind: 'device',
        revokedAt: new Date(),
        deviceId: 'revoked',
        devicePlatform: 'darwin',
        deviceAppVersion: '1.2.20',
        lastSeenAt: new Date(),
        createdAt: new Date(),
        userId: 'revoked-user',
      },
      {
        kind: 'user',
        revokedAt: null,
        deviceId: 'manual-key',
        devicePlatform: 'darwin',
        deviceAppVersion: '1.2.20',
        lastSeenAt: new Date(),
        createdAt: new Date(),
        userId: 'manual-user',
      },
    )
    rebuildModels()

    const out = await analytics.getDesktopInstalls()

    expect(out.totalDevices).toBe(3)
    expect(out.active).toEqual({ d1: 1, d7: 1, d30: 2 })
    expect(out.newLast30d).toBe(2)
    expect(out.distinctUsers).toBe(4)
    expect(out.byVersion).toEqual([
      { version: '1.2.19', count: 1, activeD7: 0 },
      { version: '1.2.20', count: 1, activeD7: 1 },
      { version: 'unknown', count: 1, activeD7: 0 },
    ])
    expect(out.byPlatform).toEqual([
      { platform: 'darwin', count: 1 },
      { platform: 'unknown', count: 1 },
      { platform: 'win32', count: 1 },
    ])
  })
})

describe('getAppInstalls', () => {
  test('aggregates desktop, iOS, and Android segments and unions users', async () => {
    const now = Date.now()
    store.apiKeys.push({
      kind: 'device',
      revokedAt: null,
      deviceId: 'desktop-1',
      devicePlatform: 'darwin',
      deviceAppVersion: '2.0.0',
      lastSeenAt: new Date(now - 60 * 60 * 1000),
      createdAt: new Date(now - 5 * 24 * 60 * 60 * 1000),
      userId: 'shared-user',
    })
    store.appInstalls.push(
      {
        deviceId: 'ios-1',
        platform: 'ios',
        appVersion: '3.0.0',
        osVersion: '18.6',
        lastSeenAt: new Date(now - 2 * 60 * 60 * 1000),
        firstSeenAt: new Date(now - 3 * 24 * 60 * 60 * 1000),
        userId: 'shared-user',
      },
      {
        deviceId: 'ios-2',
        platform: 'ios',
        appVersion: '2.9.0',
        osVersion: '17.5',
        lastSeenAt: new Date(now - 8 * 24 * 60 * 60 * 1000),
        firstSeenAt: new Date(now - 40 * 24 * 60 * 60 * 1000),
        userId: 'ios-user',
      },
      {
        deviceId: 'android-1',
        platform: 'android',
        appVersion: '3.0.0',
        osVersion: '15',
        lastSeenAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
        firstSeenAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
        userId: 'android-user',
      },
    )
    rebuildModels()

    const out = await analytics.getAppInstalls()

    expect(out.desktop.totalDevices).toBe(1)
    expect(out.ios.totalDevices).toBe(2)
    expect(out.ios.active).toEqual({ d1: 1, d7: 1, d30: 2 })
    expect(out.android.totalDevices).toBe(1)
    expect(out.totals).toMatchObject({
      totalDevices: 4,
      active: { d1: 2, d7: 3, d30: 4 },
      newLast30d: 3,
      distinctUsers: 3,
    })
    expect(out.ios.byPlatform).toEqual([
      { platform: '17.5', count: 1 },
      { platform: '18.6', count: 1 },
    ])
  })
})

// =========================================================================
// Install identity: one OS per platform spelling, CLI kept out of Desktop
// =========================================================================

describe('aggregateInstalls — platform + version normalisation', () => {
  const day = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)

  test('collapses the darwin/win32 spellings into one OS and keeps the newest version reported', async () => {
    const hour = (n: number) => new Date(Date.now() - n * 60 * 60 * 1000)
    store.apiKeys.push(
      // The production mislabel: an older-version row whose lastSeenAt was
      // bumped by a caller that sends no version.
      { kind: 'device', revokedAt: null, deviceId: 'd1', devicePlatform: 'darwin-arm64', deviceAppVersion: '2.3.5', lastSeenAt: day(2), createdAt: day(10), userId: 'u1' },
      { kind: 'device', revokedAt: null, deviceId: 'd1', devicePlatform: 'darwin', deviceAppVersion: '2.2.27', lastSeenAt: hour(1), createdAt: day(40), userId: 'u1' },
      { kind: 'device', revokedAt: null, deviceId: 'd2', devicePlatform: 'darwin-x64', deviceAppVersion: '2.3.6', lastSeenAt: day(1), createdAt: day(5), userId: 'u2' },
      { kind: 'device', revokedAt: null, deviceId: 'd3', devicePlatform: 'win32', deviceAppVersion: '2.3.6', lastSeenAt: day(3), createdAt: day(20), userId: 'u3' },
      { kind: 'device', revokedAt: null, deviceId: 'd4', devicePlatform: 'win32-x64', deviceAppVersion: '2.3.5', lastSeenAt: day(9), createdAt: day(20), userId: 'u4' },
    )
    rebuildModels()

    const out = await analytics.getDesktopInstalls()

    // 4 distinct devices, 3 macOS spellings collapse into 2 devices.
    expect(out.totalDevices).toBe(4)
    const osDevices = (os: string) =>
      out.byOs.filter((row) => row.os === os).reduce((sum, row) => sum + row.devices, 0)
    expect(osDevices('macos')).toBe(2)
    expect(osDevices('windows')).toBe(2)
    expect(osDevices('linux')).toBe(0)
    expect(out.byOs.some((row) => (row.os as string) === 'darwin')).toBe(false)

    // d1 shows 2.3.5, never the older 2.2.27 row that was seen most recently.
    expect(out.byVersion).toEqual([
      { version: '2.3.5', count: 2, activeD7: 1 },
      { version: '2.3.6', count: 2, activeD7: 2 },
    ])
    const v236 = out.versions.find((row) => row.version === '2.3.6')
    expect(v236).toMatchObject({ channel: 'stable', devices: 2, os: { macos: 1, windows: 1, linux: 0 } })
  })

  test('CLI device keys get their own segment and never count as desktops', async () => {
    store.apiKeys.push(
      { kind: 'device', revokedAt: null, deviceId: 'desk-1', devicePlatform: 'win32', deviceAppVersion: '2.3.6', lastSeenAt: day(1), createdAt: day(5), userId: 'u1' },
      { kind: 'device', revokedAt: null, deviceId: 'cli-1', devicePlatform: 'linux-x64', deviceAppVersion: 'shogo-cli/unknown', lastSeenAt: day(1), createdAt: day(5), userId: 'u2' },
      { kind: 'device', revokedAt: null, deviceId: 'cli-2', devicePlatform: 'darwin', deviceAppVersion: 'shogo-cli/unknown', lastSeenAt: day(1), createdAt: day(5), userId: 'u3' },
    )
    rebuildModels()

    const out = await analytics.getAppInstalls()

    expect(out.desktop.totalDevices).toBe(1)
    expect(out.desktop.versions.map((row) => row.version)).toEqual(['2.3.6'])
    expect(out.desktop.versions[0].os.macos).toBe(0)
    expect(out.desktop.byOs.find((row) => row.os === 'macos')).toBeUndefined()

    expect(out.cli.totalDevices).toBe(2)
    expect(out.cli.versions.map((row) => row.version)).toEqual(['shogo-cli/unknown'])
    expect(out.cli.onLatest).toBeNull()

    // CLI is a separate segment, never part of the desktop/mobile totals.
    expect(out.totals.totalDevices).toBe(1)
  })

  test('splits beta from stable and computes the on-latest percentage', async () => {
    const previous = process.env.APP_VERSION
    process.env.APP_VERSION = '2.3.6'
    try {
      store.apiKeys.push(
        { kind: 'device', revokedAt: null, deviceId: 'd1', devicePlatform: 'darwin', deviceAppVersion: '2.3.6', lastSeenAt: day(1), createdAt: day(9), userId: 'u1' },
        { kind: 'device', revokedAt: null, deviceId: 'd2', devicePlatform: 'win32', deviceAppVersion: '2.3.6', lastSeenAt: day(2), createdAt: day(9), userId: 'u2' },
        { kind: 'device', revokedAt: null, deviceId: 'd3', devicePlatform: 'darwin-arm64', deviceAppVersion: '2.3.6-beta.20261020t083308', lastSeenAt: day(1), createdAt: day(4), userId: 'u3' },
        { kind: 'device', revokedAt: null, deviceId: 'd4', devicePlatform: 'linux-x64', deviceAppVersion: '2.2.27', lastSeenAt: day(20), createdAt: day(60), userId: 'u4' },
      )
      rebuildModels()

      const out = await analytics.getDesktopInstalls()

      expect(out.onLatest).toEqual({ version: '2.3.6', devices: 2, pct: 50, source: 'deployed' })
      expect(out.versions.map((row) => `${row.version}|${row.channel}|${row.devices}`)).toEqual([
        '2.3.6|stable|2',
        '2.3.6-beta.20261020t083308|beta|1',
        '2.2.27|stable|1',
      ])
      // beta is its own row, not folded into the stable 2.3.6 bucket
      expect(out.versions.find((row) => row.channel === 'beta')?.devices).toBe(1)
    } finally {
      if (previous === undefined) delete process.env.APP_VERSION
      else process.env.APP_VERSION = previous
    }
  })

  test('falls back to the newest stable version seen when the deployment pins no tag', async () => {
    const previous = process.env.APP_VERSION
    const previousShogo = process.env.SHOGO_APP_VERSION
    delete process.env.APP_VERSION
    delete process.env.SHOGO_APP_VERSION
    try {
      store.apiKeys.push(
        { kind: 'device', revokedAt: null, deviceId: 'd1', devicePlatform: 'darwin', deviceAppVersion: '2.3.5', lastSeenAt: day(1), createdAt: day(9), userId: 'u1' },
        { kind: 'device', revokedAt: null, deviceId: 'd2', devicePlatform: 'win32', deviceAppVersion: '2.3.6', lastSeenAt: day(1), createdAt: day(9), userId: 'u2' },
        { kind: 'device', revokedAt: null, deviceId: 'd3', devicePlatform: 'linux', deviceAppVersion: '2.4.0-beta.1', lastSeenAt: day(1), createdAt: day(9), userId: 'u3' },
      )
      rebuildModels()

      const out = await analytics.getDesktopInstalls()
      expect(out.onLatest).toEqual({ version: '2.3.6', devices: 1, pct: 33, source: 'inferred' })
    } finally {
      if (previous !== undefined) process.env.APP_VERSION = previous
      if (previousShogo !== undefined) process.env.SHOGO_APP_VERSION = previousShogo
    }
  })

  test('keeps the legacy byVersion/byPlatform fields for existing consumers', async () => {
    store.apiKeys.push(
      { kind: 'device', revokedAt: null, deviceId: 'd1', devicePlatform: 'darwin', deviceAppVersion: '2.0.0', lastSeenAt: day(1), createdAt: day(5), userId: 'u1' },
    )
    rebuildModels()

    const out = await analytics.getDesktopInstalls()
    expect(out.byVersion).toEqual([{ version: '2.0.0', count: 1, activeD7: 1 }])
    expect(out.byPlatform).toEqual([{ platform: 'darwin', count: 1 }])
    expect(out.distinctUsers).toBe(1)
  })
})

// =========================================================================
// SHO-126 — the current version is the newest version event, not api_keys
// =========================================================================

describe('current version from device_version_events', () => {
  const day = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)
  const hour = (n: number) => new Date(Date.now() - n * 60 * 60 * 1000)
  const event = (deviceId: string, version: string, firstSeenAt: Date, lastSeenAt: Date) => ({
    deviceId, version, channel: 'stable', os: 'macos', client: 'desktop', firstSeenAt, lastSeenAt,
  })

  test('a deliberate downgrade is counted on the lower version', async () => {
    // One machine, two keys (device keys are minted per workspace): the older
    // one still holds the version it moved off, so semver-first picks 2.3.6
    // forever. The event history says it now runs 2.2.27.
    store.apiKeys.push(
      { kind: 'device', revokedAt: null, deviceId: 'd1', devicePlatform: 'darwin-arm64', deviceAppVersion: '2.3.6', lastSeenAt: day(6), createdAt: day(40), userId: 'u1' },
      { kind: 'device', revokedAt: null, deviceId: 'd1', devicePlatform: 'darwin-arm64', deviceAppVersion: '2.2.27', lastSeenAt: hour(1), createdAt: day(35), userId: 'u1' },
    )
    store.deviceVersionEvents.push(
      event('d1', '2.3.6', day(20), day(6)),
      event('d1', '2.2.27', day(4), hour(1)),
    )
    rebuildModels()

    const out = await analytics.getDesktopInstalls()

    expect(out.byVersion).toEqual([{ version: '2.2.27', count: 1, activeD7: 1 }])
    expect(out.versions).toHaveLength(1)
    expect(out.versions[0]).toMatchObject({
      version: '2.2.27',
      devices: 1,
      os: { macos: 1, windows: 0, linux: 0, unknown: 0 },
    })
    // ...and the second workspace's stale 2.3.6 key is nowhere in the number.
    expect(out.versions.some((row) => row.version === '2.3.6')).toBe(false)
  })

  test('a version-less touch on an older key cannot relabel the device', async () => {
    // The SHO-114 mislabel, from the other side: the newest key row says 2.2.27
    // because a touch rewrote it, but the device last reported 2.3.6.
    store.apiKeys.push(
      { kind: 'device', revokedAt: null, deviceId: 'd1', devicePlatform: 'darwin', deviceAppVersion: '2.2.27', lastSeenAt: hour(1), createdAt: day(90), userId: 'u1' },
      { kind: 'device', revokedAt: null, deviceId: 'd1', devicePlatform: 'darwin', deviceAppVersion: '2.3.6', lastSeenAt: day(3), createdAt: day(12), userId: 'u1' },
    )
    store.deviceVersionEvents.push(
      event('d1', '2.2.27', day(30), day(30)),
      event('d1', '2.3.6', day(3), day(3)),
    )
    rebuildModels()

    const out = await analytics.getDesktopInstalls()
    expect(out.byVersion).toEqual([{ version: '2.3.6', count: 1, activeD7: 1 }])
  })

  test('a device with no event row still resolves its version from api_keys', async () => {
    // Pre-migration row, or a backfill that had no version to copy.
    store.apiKeys.push(
      { kind: 'device', revokedAt: null, deviceId: 'd1', devicePlatform: 'win32', deviceAppVersion: '1.12.7', lastSeenAt: day(2), createdAt: day(40), userId: 'u1' },
    )
    rebuildModels()

    const out = await analytics.getDesktopInstalls()
    expect(out.byVersion).toEqual([{ version: '1.12.7', count: 1, activeD7: 1 }])
  })

  test('a device with neither a version nor an event stays `unknown`', async () => {
    store.apiKeys.push(
      { kind: 'device', revokedAt: null, deviceId: 'd1', devicePlatform: 'darwin', deviceAppVersion: null, lastSeenAt: day(1), createdAt: day(5), userId: 'u1' },
      { kind: 'device', revokedAt: null, deviceId: 'd2', devicePlatform: 'win32', deviceAppVersion: '2.3.6', lastSeenAt: day(1), createdAt: day(5), userId: 'u2' },
    )
    store.deviceVersionEvents.push(event('d2', '2.3.6', day(2), day(1)))
    rebuildModels()

    const out = await analytics.getDesktopInstalls()
    expect(out.byVersion).toEqual([
      { version: '2.3.6', count: 1, activeD7: 1 },
      { version: 'unknown', count: 1, activeD7: 1 },
    ])
  })

  test('the downgraded version drives the CLI/desktop split and the device list', async () => {
    // The stale workspace key still reports `shogo-cli/1.4.0`; the history says
    // the machine is a desktop on 2.2.27, so it must not land in the CLI segment.
    store.apiKeys.push(
      { kind: 'device', revokedAt: null, deviceId: 'd1', devicePlatform: 'linux-x64', deviceAppVersion: 'shogo-cli/1.4.0', lastSeenAt: day(8), createdAt: day(40), userId: 'u1' },
      { kind: 'device', revokedAt: null, deviceId: 'd1', devicePlatform: 'linux-x64', deviceAppVersion: 'shogo-cli/1.4.0', lastSeenAt: hour(2), createdAt: day(30), userId: 'u1' },
    )
    store.deviceVersionEvents.push(
      event('d1', '2.3.6', day(20), day(8)),
      event('d1', '2.2.27', day(4), hour(2)),
    )
    rebuildModels()

    const installs = await analytics.getAppInstalls()
    expect(installs.cli.totalDevices).toBe(0)
    expect(installs.desktop.byVersion).toEqual([{ version: '2.2.27', count: 1, activeD7: 1 }])

    const devices = await analytics.getActiveDevices({ includeDormant: true, days: 30 })
    expect(devices.devices).toHaveLength(1)
    expect(devices.devices[0]).toMatchObject({ client: 'desktop', version: '2.2.27', channel: 'stable' })

    const versions = await analytics.getAppVersions({ days: 30 })
    expect(versions.desktop.byVersion).toEqual([{ version: '2.2.27', count: 1, activeD7: 1 }])
    expect(versions.cli.totalDevices).toBe(0)
  })
})

// =========================================================================
// getAppVersions — OS×version matrix + adoption series
// =========================================================================

describe('getAppVersions', () => {
  test('returns the matrix, the deployed tag and a per-day adoption series', async () => {
    const previous = process.env.APP_VERSION
    process.env.APP_VERSION = '2.3.6'
    try {
      const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)
      store.apiKeys.push(
        { kind: 'device', revokedAt: null, deviceId: 'd1', devicePlatform: 'darwin-arm64', deviceAppVersion: '2.3.6', lastSeenAt: daysAgo(0), createdAt: daysAgo(1), userId: 'u1' },
        { kind: 'device', revokedAt: null, deviceId: 'd2', devicePlatform: 'win32', deviceAppVersion: '2.2.27', lastSeenAt: daysAgo(1), createdAt: daysAgo(30), userId: 'u2' },
        { kind: 'device', revokedAt: null, deviceId: 'cli-1', devicePlatform: 'linux-x64', deviceAppVersion: 'shogo-cli/unknown', lastSeenAt: daysAgo(0), createdAt: daysAgo(0), userId: 'u3' },
      )
      store.deviceVersionEvents.push(
        { deviceId: 'd1', version: '2.3.6', channel: 'stable', os: 'macos', client: 'desktop', firstSeenAt: daysAgo(1), lastSeenAt: daysAgo(0) },
        { deviceId: 'd2', version: '2.2.27', channel: 'stable', os: 'windows', client: 'desktop', firstSeenAt: daysAgo(30), lastSeenAt: daysAgo(1) },
      )
      rebuildModels()

      const out = await analytics.getAppVersions({ days: 7 })

      expect(out.deployedVersion).toBe('2.3.6')
      expect(out.windowDays).toBe(7)
      expect(out.desktop.totalDevices).toBe(2)
      expect(out.cli.totalDevices).toBe(1)
      expect(out.desktop.onLatest).toMatchObject({ version: '2.3.6', devices: 1, pct: 50, source: 'deployed' })

      // Adoption is per (day, version), oldest devices still on 2.2.27 counted.
      const today = new Date().toISOString().split('T')[0]
      const todayStable = out.adoption.find((point) => point.date === today && point.version === '2.3.6')
      expect(todayStable).toMatchObject({ channel: 'stable', devices: 1 })
      expect(out.adoption.length).toBeGreaterThan(0)
    } finally {
      if (previous === undefined) delete process.env.APP_VERSION
      else process.env.APP_VERSION = previous
    }
  })

  test('clamps the window and never returns a negative day count', async () => {
    const out = await analytics.getAppVersions({ days: -5 })
    expect(out.windowDays).toBe(1)
    expect(out.desktop.totalDevices).toBe(0)
    expect(out.adoption).toEqual([])
  })
})

// =========================================================================
// getActiveDevices — which machines are alive, not just how many
// =========================================================================

describe('getActiveDevices', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000)

  function seed() {
    store.apiKeys.push(
      // Heartbeat 2 minutes ago — online.
      { kind: 'device', revokedAt: null, deviceId: 'mac-live', devicePlatform: 'darwin-arm64', deviceAppVersion: '2.3.6', lastSeenAt: minutesAgo(2), createdAt: daysAgo(40), userId: 'u1' },
      // Seen this morning but not in the last 15 minutes.
      { kind: 'device', revokedAt: null, deviceId: 'win-live', devicePlatform: 'win32-x64', deviceAppVersion: '2.2.27', lastSeenAt: daysAgo(3), createdAt: daysAgo(60), userId: 'u2' },
      // 90 days idle — a stale key, not a running machine.
      { kind: 'device', revokedAt: null, deviceId: 'stale', devicePlatform: 'darwin-x64', deviceAppVersion: '1.12.7', lastSeenAt: daysAgo(90), createdAt: daysAgo(120), userId: 'u3' },
      // CLI key must not be counted as a desktop device.
      { kind: 'device', revokedAt: null, deviceId: 'cli-1', devicePlatform: 'linux-x64', deviceAppVersion: 'shogo-cli/1.4.0', lastSeenAt: minutesAgo(1), createdAt: daysAgo(2), userId: 'u4' },
      // Revoked keys are not devices any more.
      { kind: 'device', revokedAt: daysAgo(1), deviceId: 'revoked', devicePlatform: 'win32', deviceAppVersion: '2.3.6', lastSeenAt: daysAgo(1), createdAt: daysAgo(5), userId: 'u5' },
    )
    rebuildModels()
  }

  test('lists active devices with an online flag and hides dormant keys', async () => {
    seed()
    const out = await analytics.getActiveDevices()

    expect(out.onlineWindowMinutes).toBe(15)
    expect(out.windowDays).toBe(30)
    // 4 unrevoked devices (3 desktop + 1 cli); the revoked key is excluded entirely.
    expect(out.totals.devices).toBe(4)
    expect(out.totals.online).toBe(2)
    expect(out.totals.dormant).toBe(1)
    // Only the 3 seen inside the window are listed by default.
    expect(out.devices).toHaveLength(3)
    expect(out.devices.map((d) => d.osLabel).sort()).toEqual(['Linux', 'Windows', 'macOS'])
    // Online devices first.
    expect(out.devices[0].online).toBe(true)
  })

  test('includeDormant surfaces stale keys with their idle age', async () => {
    seed()
    const out = await analytics.getActiveDevices({ includeDormant: true, days: 30 })

    expect(out.totals.dormant).toBe(1)
    const stale = out.devices.find((d) => d.version === '1.12.7')
    expect(stale).toBeDefined()
    expect(stale!.online).toBe(false)
    expect(stale!.idleHours).toBeGreaterThan(24 * 80)
    expect(out.devices.length).toBe(4)
  })

  test('the raw device id never leaves the server', async () => {
    seed()
    const out = await analytics.getActiveDevices({ includeDormant: true })
    for (const row of out.devices) {
      expect(row.id).toMatch(/^[0-9a-f]{10}$/)
      expect(['mac-live', 'win-live', 'stale', 'cli-1']).not.toContain(row.id)
    }
  })

  test('client filter separates CLI from desktop', async () => {
    seed()
    const desktops = await analytics.getActiveDevices({ client: 'desktop' })
    const clis = await analytics.getActiveDevices({ client: 'cli' })

    expect(desktops.devices.every((d) => d.client === 'desktop')).toBe(true)
    expect(clis.devices).toHaveLength(1)
    expect(clis.devices[0].version).toBe('shogo-cli/1.4.0')
  })

  test('a device that reported no version still resolves one from its keys', async () => {
    store.apiKeys.push({
      kind: 'device',
      revokedAt: null,
      deviceId: 'mixed',
      devicePlatform: null,
      deviceAppVersion: null,
      lastSeenAt: minutesAgo(1),
      createdAt: daysAgo(4),
      userId: 'u6',
    })
    rebuildModels()
    const out = await analytics.getActiveDevices()
    expect(out.devices).toHaveLength(1)
    expect(out.devices[0].version).toBe('unknown')
    expect(out.devices[0].os).toBe('unknown')
  })

  test('clamps the window and the limit', async () => {
    const out = await analytics.getActiveDevices({ days: -5, limit: 0 })
    expect(out.windowDays).toBe(1)
    expect(out.devices).toEqual([])
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
        sawPreview: 2,
        hitCap: 3,
        avgMinToFirstProject: 12.3,
        avgMinToFirstMessage: 33.7,
      },
    ])
    const out = await analytics.getUserFunnel()
    expect(out.signups).toBe(10)
    expect(out.engaged).toBe(2)
    // The two activation steps behind the numbers (SHO-258 §7).
    expect(out.sawPreview).toBe(2)
    expect(out.hitCap).toBe(3)
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
