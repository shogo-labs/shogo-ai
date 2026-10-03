// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Collection + attribution for services/engagement-analytics.service.ts.
// Prisma is mocked with fixtures; the where-clauses the service sends are
// asserted where scoping matters (workspace, user, the "system" member).

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const fx = {
  members: [] as any[],
  users: [] as any[],
  usage: [] as any[],
  tools: [] as any[],
  messages: [] as any[],
  approvalMessages: [] as any[],
  goalEvents: [] as any[],
  tasks: [] as any[],
  meetings: [] as any[],
}
const calls: Record<string, any[]> = {}
const record = (name: string, args: any) => {
  ;(calls[name] ||= []).push(args)
}

mock.module('../../lib/prisma', () => ({
  Prisma: {},
  prisma: {
    member: {
      findMany: async (a: any) => (record('member', a), fx.members),
      findFirst: async (a: any) => {
        record('memberFirst', a)
        const w = a.where
        if (w.userId) return fx.members.find((m) => m.userId === w.userId) ?? null
        const emails: string[] = w.user?.email?.in ?? []
        return fx.members.find((m) => emails.includes(m.user?.email)) ?? null
      },
    },
    user: { findMany: async (a: any) => (record('user', a), fx.users) },
    usageEvent: { findMany: async (a: any) => (record('usage', a), fx.usage) },
    toolCallLog: { findMany: async (a: any) => (record('tools', a), fx.tools) },
    conversationMessage: {
      // The service issues two queries: user-authored messages, then agent-authored approval cards.
      findMany: async (a: any) => {
        record('message', a)
        return a.where.authorType === 'agent' ? fx.approvalMessages : fx.messages
      },
    },
    goalEvent: { findMany: async (a: any) => (record('goalEvent', a), fx.goalEvents) },
    agentTask: { findMany: async (a: any) => (record('task', a), fx.tasks) },
    meeting: { findMany: async (a: any) => (record('meeting', a), fx.meetings) },
  },
}))
mock.module('../model-registry.service', () => ({
  resolveModelLabels: async (ids: string[]) => new Map(ids.map((id) => [id, id === 'm-uuid' ? 'Claude Sonnet' : id])),
}))
mock.module('../analytics.service', () => ({
  periodToWindow: (_p: any, fromIso?: string, toIso?: string) =>
    fromIso && toIso
      ? { from: new Date(fromIso), to: new Date(toIso) }
      : { from: new Date(Date.now() - 30 * 864e5), to: new Date() },
}))

const svc = await import('../engagement-analytics.service')

const WS = 'ws_1'
const range = { fromIso: '2026-07-01T00:00:00Z', toIso: '2026-07-07T23:59:59Z' }

const channelApproval = (over: Record<string, any> = {}, asString = false) => {
  const blocks = {
    messageKind: 'decision',
    type: 'approval_request',
    approval: {
      requestId: 'r1',
      projectId: 'p1',
      toolName: 'github_merge_pr',
      summary: 'Merge pull request #12',
      status: 'approved',
      decidedBy: { userId: 'alice', name: 'Alice' },
      decidedAt: '2026-07-03T10:00:00Z',
      ...over,
    },
  }
  return { blocks: asString ? JSON.stringify(blocks) : blocks }
}

beforeEach(() => {
  for (const k of Object.keys(fx) as (keyof typeof fx)[]) fx[k] = []
  for (const k of Object.keys(calls)) delete calls[k]
  delete process.env.SHOGO_LOCAL_MODE
})

describe('collection scoping', () => {
  test('a workspace scope queries that workspace and excludes the system member', async () => {
    await svc.getEngagementStats({ workspaceId: WS }, '30d', 'UTC', range)
    expect(calls.usage[0].where.workspaceId).toEqual({ in: [WS] })
    expect(calls.usage[0].where.memberId).toEqual({ not: 'system' })
    expect(calls.tools[0].where.userId).toEqual({ not: null })
    expect(calls.member).toBeUndefined()
  })

  test('a user scope narrows every query to that person', async () => {
    await svc.getEngagementStats({ workspaceId: WS, userId: 'alice' }, '30d', 'UTC', range)
    expect(calls.usage[0].where.memberId).toBe('alice')
    expect(calls.tools[0].where.userId).toBe('alice')
    expect(calls.message[0].where.authorUserId).toBe('alice')
    expect(calls.task[0].where.userId).toBe('alice')
    expect(calls.meeting[0].where.userId).toBe('alice')
  })

  test('a personal scope spans the workspaces the person belongs to', async () => {
    fx.members = [{ workspaceId: 'ws_a' }, { workspaceId: 'ws_b' }, { workspaceId: null }, { workspaceId: 'ws_a' }]
    await svc.getEngagementStats({ userId: 'alice' }, '30d', 'UTC', range)
    expect(calls.usage[0].where.workspaceId).toEqual({ in: ['ws_a', 'ws_b'] })
  })

  test('with no workspace and no user nothing is queried (never platform-wide)', async () => {
    const stats = await svc.getEngagementStats({}, '30d', 'UTC', range)
    expect(calls.usage).toBeUndefined()
    expect(stats.totals.agentRequests).toBe(0)
  })

  test('a person with no memberships gets an empty dashboard, not an error', async () => {
    fx.members = []
    const stats = await svc.getEngagementStats({ userId: 'alice' }, '30d', 'UTC', range)
    expect(stats.totals.activeDays).toBe(0)
    expect(stats.streak).toEqual({ current: 0, longest: 0 })
  })

  test('postgres filters approval cards by JSON path; sqlite by substring', async () => {
    await svc.getEngagementStats({ workspaceId: WS }, '30d', 'UTC', range)
    expect(calls.message[1].where.blocks).toEqual({ path: ['type'], equals: 'approval_request' })

    process.env.SHOGO_LOCAL_MODE = 'true'
    await svc.getEngagementStats({ workspaceId: WS }, '30d', 'UTC', range)
    expect(calls.message[3].where.blocks).toEqual({ contains: 'approval_request' })
  })
})

describe('approvals decided', () => {
  const stats = (user = 'alice') => svc.getEngagementStats({ workspaceId: WS, userId: user }, '30d', 'UTC', range)

  test('credits channel approvals to the person who decided (object and string storage)', async () => {
    fx.approvalMessages = [channelApproval(), channelApproval({ requestId: 'r2', status: 'denied' }, true)]
    const s = await stats()
    expect(s.totals).toMatchObject({ approvalsDecided: 2, approvalsApproved: 1, approvalsDenied: 1 })
    expect(s.recent.map((r) => r.label)).toContain('Merge pull request #12')
  })

  test('ignores pending, expired, undecided and unattributed cards', async () => {
    fx.approvalMessages = [
      channelApproval({ status: 'pending', decidedBy: undefined, decidedAt: undefined }),
      channelApproval({ status: 'expired' }),
      channelApproval({ decidedBy: { userId: null, name: 'Slack user' } }),
      channelApproval({ decidedAt: undefined }),
      { blocks: { messageKind: 'status', work: {} } },
      { blocks: 'not json{' },
    ]
    expect((await stats()).totals.approvalsDecided).toBe(0)
  })

  test('ignores approvals decided outside the window or by someone else', async () => {
    fx.approvalMessages = [
      channelApproval({ decidedAt: '2026-06-20T10:00:00Z' }),
      channelApproval({ decidedAt: '2026-07-20T10:00:00Z' }),
      channelApproval({ decidedBy: { userId: 'bob', name: 'Bob' } }),
    ]
    expect((await stats()).totals.approvalsDecided).toBe(0)
    expect((await stats('bob')).totals.approvalsDecided).toBe(1)
  })

  test('credits goal approvals only when the decider was recorded', async () => {
    fx.goalEvents = [
      { message: 'Ship the beta?', metadata: { decision: 'approved', resolvedAt: '2026-07-04T09:00:00Z', decidedByUserId: 'alice' } },
      { message: 'Legacy approval', metadata: { decision: 'approved', resolvedAt: '2026-07-04T09:00:00Z' } },
      { message: 'Still open', metadata: {} },
      { message: 'Declined one', metadata: JSON.stringify({ decision: 'declined', resolvedAt: '2026-07-05T09:00:00Z', decidedByUserId: 'alice' }) },
    ]
    const s = await stats()
    expect(s.totals).toMatchObject({ approvalsDecided: 2, approvalsApproved: 1, approvalsDenied: 1 })
  })

  test('approvals count toward active days and streaks', async () => {
    fx.approvalMessages = [
      channelApproval({ decidedAt: '2026-07-06T10:00:00Z' }),
      channelApproval({ decidedAt: '2026-07-07T10:00:00Z' }),
    ]
    const s = await stats()
    expect(s.totals.activeDays).toBe(2)
    expect(s.streak).toEqual({ current: 2, longest: 2 })
  })
})

describe('usage attribution', () => {
  test('reads tokens, model, project, cost and chat session from usage events', async () => {
    fx.usage = [
      {
        memberId: 'alice', projectId: 'p1', billedUsd: 0, rawUsd: 0.05, createdAt: new Date('2026-07-02T10:00:00Z'),
        actionMetadata: { totalTokens: 500, model: 'm-uuid', chatSessionId: 'sess-1' },
      },
      {
        memberId: 'alice', projectId: 'p2', billedUsd: 0.2, rawUsd: 0.1, createdAt: new Date('2026-07-02T11:00:00Z'),
        actionMetadata: JSON.stringify({ totalTokens: 250, model: 'm-uuid', chatSessionId: 'sess-1' }),
      },
    ]
    const s = await svc.getEngagementStats({ workspaceId: WS, userId: 'alice' }, '30d', 'UTC', range)
    expect(s.totals).toMatchObject({ tokens: 750, agentRequests: 2, sessions: 1, projectsTouched: 2 })
    expect(s.totals.spendUsd).toBeCloseTo(0.25, 5)
    // Model ids are mapped to labels before ranking.
    expect(s.modelShare).toEqual([{ model: 'Claude Sonnet', tokens: 750, pct: 100 }])
  })
})

describe('getTeamWork', () => {
  test('lists every member including idle ones and former members with activity', async () => {
    fx.members = [
      { userId: 'alice', role: 'admin', user: { name: 'Alice', email: 'a@x.co', image: null } },
      { userId: 'bob', role: 'member', user: { name: 'Bob', email: 'b@x.co', image: null } },
      { userId: 'idle', role: 'member', user: { name: 'Idle', email: 'i@x.co', image: null } },
    ]
    fx.users = [{ id: 'gone', name: 'Former', email: 'f@x.co', image: null }]
    fx.messages = [
      { authorUserId: 'alice', createdAt: new Date('2026-07-02T10:00:00Z') },
      { authorUserId: 'alice', createdAt: new Date('2026-07-03T10:00:00Z') },
      { authorUserId: 'bob', createdAt: new Date('2026-07-03T10:00:00Z') },
    ]
    fx.approvalMessages = [channelApproval({ decidedBy: { userId: 'bob', name: 'Bob' } })]
    fx.tasks = [
      { userId: 'gone', projectId: null, title: 'Legacy', status: 'completed', createdAt: new Date('2026-07-02T00:00:00Z'), startedAt: null, completedAt: new Date('2026-07-02T09:00:00Z'), resultSummary: null },
    ]

    const team = await svc.getTeamWork(WS, '30d', 'UTC', range)
    const byId = Object.fromEntries(team.rows.map((r) => [r.userId, r]))

    expect(Object.keys(byId).sort()).toEqual(['alice', 'bob', 'gone', 'idle'])
    expect(byId.alice.totals.messagesSent).toBe(2)
    expect(byId.bob.totals).toMatchObject({ messagesSent: 1, approvalsDecided: 1 })
    expect(byId.idle.totals.activeDays).toBe(0)
    expect(byId.gone).toMatchObject({ name: 'Former', role: null })
    expect(byId.gone.totals.tasksCompleted).toBe(1)
    expect(byId.alice.streak.longest).toBe(2)

    // Team totals equal the sum of the rows for additive fields.
    const sum = (k: 'messagesSent' | 'approvalsDecided' | 'tasksCompleted') =>
      team.rows.reduce((s, r) => s + r.totals[k], 0)
    expect(team.team.messagesSent).toBe(sum('messagesSent'))
    expect(team.team.approvalsDecided).toBe(sum('approvalsDecided'))
    expect(team.team.tasksCompleted).toBe(sum('tasksCompleted'))

    // Busiest by approvals + tasks + messages first; idle last.
    expect(team.rows[0].userId).toBe('alice')
    expect(team.rows[team.rows.length - 1].userId).toBe('idle')
  })
})

describe('engagementWindow', () => {
  test('all time is capped rather than unbounded', () => {
    const { from, to } = svc.engagementWindow('all')
    const days = Math.round((to.getTime() - from.getTime()) / 864e5)
    expect(days).toBe(svc.ALL_TIME_DAYS)
  })

  test('explicit from/to wins over the period', () => {
    const w = svc.engagementWindow('all', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')
    expect(w.from.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('findWorkspaceMember', () => {
  beforeEach(() => {
    fx.members = [{ userId: 'alice', role: 'admin', user: { name: 'Alice', email: 'Alice@Example.com' } }]
  })

  test('finds by user id', async () => {
    expect(await svc.findWorkspaceMember(WS, 'alice')).toEqual({ userId: 'alice', name: 'Alice', email: 'Alice@Example.com', role: 'admin' })
  })

  test('finds by email, trying the lowercased form too', async () => {
    fx.members = [{ userId: 'bob', role: 'member', user: { name: 'Bob', email: 'bob@example.com' } }]
    const hit = await svc.findWorkspaceMember(WS, 'BOB@Example.com')
    expect(hit?.userId).toBe('bob')
    expect(calls.memberFirst.at(-1).where.user.email.in).toEqual(['BOB@Example.com', 'bob@example.com'])
  })

  test('is scoped to the workspace and returns null for strangers or blank input', async () => {
    expect(await svc.findWorkspaceMember(WS, 'nobody@example.com')).toBeNull()
    expect(await svc.findWorkspaceMember(WS, '   ')).toBeNull()
    expect(calls.memberFirst.every((c: any) => c.where.workspaceId === WS)).toBe(true)
  })
})

describe('getMemberWorkActivity', () => {
  const alice = { userId: 'alice', name: 'Alice', email: 'a@x.co', role: 'member' }
  const now = new Date('2026-07-07T20:00:00Z')

  test('summarises one person for an agent to describe, without chart payloads', async () => {
    fx.approvalMessages = [channelApproval({ decidedAt: '2026-07-07T18:00:00Z' })]
    fx.messages = [{ authorUserId: 'alice', createdAt: new Date('2026-07-07T17:00:00Z') }]
    fx.tasks = [
      { userId: 'alice', projectId: 'p1', title: 'Fix totals', status: 'completed', createdAt: new Date('2026-07-07T15:00:00Z'), startedAt: new Date('2026-07-07T15:30:00Z'), completedAt: new Date('2026-07-07T16:00:00Z'), resultSummary: 'Merged' },
    ]

    const out = await svc.getMemberWorkActivity(WS, alice, { range: 'today', tz: 'UTC' }, now)

    expect(out.user).toEqual(alice)
    expect(out.window).toMatchObject({ tz: 'UTC', label: 'today', from: '2026-07-07T00:00:00.000Z' })
    expect(out.totals).toMatchObject({ approvalsDecided: 1, messagesSent: 1, tasksCompleted: 1 })
    expect(out.recent.map((r) => r.label)).toEqual(['Merge pull request #12', 'Fix totals'])
    expect(out).not.toHaveProperty('heatmap')
    expect(out).not.toHaveProperty('hourOfWeek')
    expect(out).not.toHaveProperty('daily')
    // Queries are narrowed to exactly that person in that workspace.
    expect(calls.usage.at(-1).where.memberId).toBe('alice')
    expect(calls.usage.at(-1).where.workspaceId).toEqual({ in: [WS] })
  })

  test('a quiet day is reported as zeros, not an error', async () => {
    const out = await svc.getMemberWorkActivity(WS, alice, { range: 'today', tz: 'UTC' }, now)
    expect(out.totals.activeDays).toBe(0)
    expect(out.totals.approvalsDecided).toBe(0)
    expect(out.recent).toEqual([])
  })
})
