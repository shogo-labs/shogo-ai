// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Analytics service — Postgres branch coverage.
 *
 * Pairs with `src/__tests__/analytics-service.expanded.test.ts` which runs the
 * suite under SQLite mode (`SHOGO_LOCAL_MODE=true`). The `isSqlite` flag in
 * analytics.service.ts is captured once at module load, so we need a separate
 * test file (= separate Bun process via run-tests-isolated) where we flip the
 * env var *before* importing the SUT. That makes every raw-SQL branch take the
 * Postgres ternary side (`EXTRACT(EPOCH ...)`, `::int`, `= ANY($1::text[])`,
 * `RIGHT(...)`) instead of the SQLite side.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'

// CRITICAL: must run BEFORE the dynamic import below.
process.env.SHOGO_LOCAL_MODE = 'false'

const store = {
  users: [] as any[],
  workspaces: [] as any[],
  projects: [] as any[],
  members: [] as any[],
  chatSessions: [] as any[],
  chatMessages: [] as any[],
  usageEvents: [] as any[],
  subscriptions: [] as any[],
  toolCallLogs: [] as any[],
  sessions: [] as any[],
}

let rawQueue: any[][] = []
const rawCalls: { sql: string; args: any[] }[] = []
function enqueueRaw(...batches: any[][]) {
  rawQueue.push(...batches)
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
    const rv = (row as any)[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if ('gte' in (v as any) && !(rv instanceof Date && rv >= (v as any).gte)) return false
      if ('lte' in (v as any) && !(rv instanceof Date && rv <= (v as any).lte)) return false
      if ('lt' in (v as any) && !(rv instanceof Date && rv < (v as any).lt)) return false
      if ('in' in (v as any) && !((v as any).in as any[]).includes(rv)) return false
      if ('not' in (v as any) && (v as any).not !== undefined && rv === (v as any).not) return false
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
      if (args?.distinct && Array.isArray(args.distinct)) {
        const seen = new Set<string>()
        filtered = filtered.filter((r) => {
          const k = args.distinct.map((f: string) => String((r as any)[f])).join('::')
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
      }
      return filtered.slice(args?.skip ?? 0, (args?.skip ?? 0) + (args?.take ?? filtered.length))
    },
    aggregate: async (args: any) => {
      const filtered = rows.filter((r) => matchWhere(r, args?.where))
      const sum: any = {}
      if (args?._sum) {
        for (const k of Object.keys(args._sum)) {
          sum[k] = filtered.reduce((s, r) => s + ((r as any)[k] ?? 0), 0)
        }
      }
      return { _sum: sum, _count: { _all: filtered.length } }
    },
    groupBy: async (args: any) => {
      const filtered = rows.filter((r) => matchWhere(r, args?.where))
      const byKey = new Map<string, any>()
      for (const r of filtered) {
        const key = args.by.map((k: string) => String((r as any)[k])).join('::')
        if (!byKey.has(key)) {
          const entry: any = {}
          for (const k of args.by) entry[k] = (r as any)[k]
          if (args._sum) {
            entry._sum = {}
            for (const k of Object.keys(args._sum)) entry._sum[k] = 0
          }
          if (args._count) entry._count = args._count === true ? 0 : { _all: 0 }
          byKey.set(key, entry)
        }
        const entry = byKey.get(key)
        if (args._sum) {
          for (const k of Object.keys(args._sum)) entry._sum[k] += (r as any)[k] ?? 0
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
  $queryRawUnsafe: async (sql: string, ...args: any[]) => {
    rawCalls.push({ sql, args })
    return rawQueue.length ? rawQueue.shift()! : []
  },
  $queryRaw: async () => (rawQueue.length ? rawQueue.shift()! : []),
}

mock.module('../../lib/prisma', () => ({
  prisma: mockPrisma,
  Prisma: {
    raw: (s: string) => s,
    sql: (s: string) => s,
    empty: '',
  },
}))

const analytics = await import('../analytics.service')

function rebuild() {
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
  for (const k of Object.keys(store) as (keyof typeof store)[]) {
    store[k].length = 0
  }
  rawQueue = []
  rawCalls.length = 0
  rebuild()
})

describe('getUserFunnel (Postgres branch)', () => {
  test('emits Postgres SQL and maps the row', async () => {
    enqueueRaw([
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
    const out = await analytics.getUserFunnel('30d', true)
    expect(out.signups).toBe(10)
    expect(out.avgMinToFirstProject).toBe(12.3)
    expect(rawCalls[0].sql).toContain('EXTRACT(EPOCH FROM')
    expect(rawCalls[0].sql).not.toContain('julianday')
  })

  test('without excludeInternal omits the email filter', async () => {
    enqueueRaw([])
    await analytics.getUserFunnel('7d', false)
    expect(rawCalls[0].sql).not.toContain('NOT ILIKE')
  })

  test('with excludeInternal appends NOT ILIKE (Postgres)', async () => {
    enqueueRaw([])
    await analytics.getUserFunnel('7d', true)
    expect(rawCalls[0].sql).toContain('NOT ILIKE')
    expect(rawCalls[0].sql).not.toContain('NOT LIKE ')
  })

  test('returns zeros when raw query yields no rows', async () => {
    enqueueRaw([])
    const out = await analytics.getUserFunnel('30d', true)
    expect(out.signups).toBe(0)
    expect(out.avgMinToFirstProject).toBeNull()
  })
})

describe('getUserActivityTable (Postgres branch)', () => {
  test('uses = ANY($1::text[]) in every raw query', async () => {
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
      billedUsd: 7.5,
      source: 'monthly',
      actionType: 'x',
      workspaceId: 'w-1',
      projectId: 'p-1',
      createdAt: now,
    })
    enqueueRaw(
      [{ userId: 'u-1', count: 12 }],
      [{ userId: 'u-1', count: 3 }],
      [{ userId: 'u-1', count: 4 }],
    )
    rebuild()
    const out = await analytics.getUserActivityTable('30d', { excludeInternal: false })
    expect(out.users[0].messages).toBe(12)
    expect(out.users[0].sessions).toBe(3)
    expect(out.users[0].toolCalls).toBe(4)
    expect(out.users[0].projects).toBe(1)
    expect(out.users[0].spendUsd).toBe(7.5)
    expect(out.users[0].sourceTag).toBe('organic:google')
    for (const call of rawCalls) {
      expect(call.sql).toContain('= ANY($1::text[])')
    }
  })

  test('default options and lastActiveAt falls back to null', async () => {
    store.users.push({
      id: 'u-2',
      name: null,
      email: 'b@real.com',
      role: 'user',
      createdAt: new Date(),
      sessions: [],
      _count: { members: 0 },
    })
    enqueueRaw([], [], [])
    rebuild()
    const out = await analytics.getUserActivityTable()
    expect(out.users.length).toBe(1)
    expect(out.users[0].lastActiveAt).toBeNull()
    expect(out.users[0].messages).toBe(0)
  })
})

describe('getTemplateEngagement (Postgres branch)', () => {
  test('emits Postgres SQL and computes engagementRate', async () => {
    enqueueRaw([
      { templateId: 't1', projects: 4, avgMessages: 3.5, totalToolCalls: 9, engagedUsers: 3, totalUsers: 4 },
      { templateId: 't2', projects: 1, avgMessages: 0, totalToolCalls: 0, engagedUsers: 0, totalUsers: 0 },
    ])
    const out = await analytics.getTemplateEngagement(true)
    expect(out.templates[0].engagementRate).toBe(75)
    expect(out.templates[1].engagementRate).toBe(0)
    expect(rawCalls[0].sql).toContain('::int')
    expect(rawCalls[0].sql).toContain('NOT ILIKE')
  })

  test('excludeInternal=false omits the email filter', async () => {
    enqueueRaw([])
    const out = await analytics.getTemplateEngagement(false)
    expect(out.templates).toEqual([])
    expect(rawCalls[0].sql).not.toContain('NOT ILIKE')
  })
})

describe('getChatConversations (Postgres branch)', () => {
  test('emits RIGHT(...) for assistant truncation and groups by sessionId', async () => {
    const now = new Date()
    enqueueRaw([
      { sessionId: 's-1', userName: 'A', projectName: 'P', templateId: 't', role: 'user', content: 'hi', sentAt: now },
      { sessionId: 's-1', userName: 'A', projectName: 'P', templateId: 't', role: 'assistant', content: 'hello', sentAt: now },
      { sessionId: 's-2', userName: null, projectName: 'P2', templateId: null, role: 'user', content: 'hi2', sentAt: now },
    ])
    const out = await analytics.getChatConversations(new Date(0), true)
    expect(out.conversations.length).toBe(2)
    expect(out.conversations[0].messages.length).toBe(2)
    expect(rawCalls[0].sql).toContain('RIGHT(cm.')
    expect(rawCalls[0].sql).not.toContain('substr(cm.')
    expect(rawCalls[0].sql).toContain('NOT ILIKE')
  })

  test('excludeInternal=false drops the email filter', async () => {
    enqueueRaw([])
    const out = await analytics.getChatConversations(new Date(0), false)
    expect(out.conversations).toEqual([])
    expect(rawCalls[0].sql).not.toContain('NOT ILIKE')
  })
})

describe('getSourceBreakdown (Postgres branch)', () => {
  test('emits ::int and computes rates', async () => {
    enqueueRaw([
      { tag: 'organic:google', count: 10, withProject: 5, withMessage: 2 },
      { tag: 'direct', count: 0, withProject: 0, withMessage: 0 },
    ])
    const out = await analytics.getSourceBreakdown('30d', true)
    expect(out.sources[0].projectRate).toBe(50)
    expect(out.sources[0].messageRate).toBe(20)
    expect(out.sources[1].projectRate).toBe(0)
    expect(rawCalls[0].sql).toContain('::int')
    expect(rawCalls[0].sql).toContain('NOT ILIKE')
  })

  test('excludeInternal=false omits NOT ILIKE', async () => {
    enqueueRaw([])
    const out = await analytics.getSourceBreakdown('7d', false)
    expect(out.sources).toEqual([])
    expect(rawCalls[0].sql).not.toContain('NOT ILIKE')
  })
})

describe('Postgres-mode helper coverage', () => {
  test('realUserWhere on Postgres emits insensitive-mode email filters', () => {
    const w = analytics.realUserWhere() as any
    const inner = w.AND.find((c: any) => c.NOT?.email?.contains)
    expect(inner.NOT.email.mode).toBe('insensitive')
  })

  test('periodToWindow falls back to default 30d on unknown period', () => {
    const { from, to } = analytics.periodToWindow('unknown' as any)
    const span = to.getTime() - from.getTime()
    expect(span).toBeGreaterThan(29 * 24 * 60 * 60 * 1000)
    expect(span).toBeLessThan(31 * 24 * 60 * 60 * 1000)
  })
})
