// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The records behind "what did this person send?" (SHO-199).
 *
 * Prisma is mocked with fixtures so the assertions can be about the two things
 * that matter: only the person's own messages come back (never agent output,
 * replies or wake notes), and paging across the two sources cannot repeat or
 * lose a row.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const fx = {
  team: [] as any[],
  agent: [] as any[],
  conversations: [] as any[],
  members: [] as any[],
  threadRoots: [] as any[],
  cards: [] as any[],
  users: [] as any[],
  projects: [] as any[],
  unattributed: 0,
}
const calls: Record<string, any[]> = {}
const record = (name: string, args: any) => {
  ;(calls[name] ||= []).push(args)
}

/** Apply the subset of Prisma filtering this service relies on. */
function applyWhere(rows: any[], where: any, key: 'createdAt' | 'at' = 'createdAt') {
  return rows.filter((row) => {
    if (where.authorUserId && row.authorUserId !== where.authorUserId) return false
    if (where.role && row.role !== where.role) return false
    const from = where.createdAt?.gte
    const to = where.createdAt?.lte
    if (from && row[key] < from) return false
    if (to && row[key] > to) return false
    const cursor = where.OR?.find((clause: any) => clause.createdAt?.lt)
    const tieBreak = where.OR?.find((clause: any) => clause.id?.lt)
    if (cursor) {
      const cut = cursor.createdAt.lt as Date
      if (!(row[key] < cut || (row[key].getTime() === cut.getTime() && tieBreak && row.id < tieBreak.id.lt))) {
        return false
      }
    }
    return true
  })
}

const page = (rows: any[], take: number) =>
  [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)).slice(0, take)

mock.module('../../lib/prisma', () => ({
  prisma: {
    conversationMessage: {
      findMany: async (a: any) => {
        record('team', a)
        if (a.select?.authorType) return fx.threadRoots
        return page(applyWhere(fx.team, a.where), a.take)
      },
    },
    chatMessage: {
      findMany: async (a: any) => {
        record('agent', a)
        return page(applyWhere(fx.agent, a.where), a.take)
      },
      count: async (a: any) => (record('count', a), fx.unattributed),
    },
    conversation: { findMany: async (a: any) => (record('conversation', a), fx.conversations) },
    conversationMember: { findMany: async (a: any) => (record('member', a), fx.members) },
    workItem: { findMany: async (a: any) => (record('card', a), fx.cards) },
    user: { findMany: async (a: any) => (record('user', a), fx.users) },
    project: { findMany: async (a: any) => (record('project', a), fx.projects) },
  },
}))

const svc = await import('../member-messages.service')

const WS = 'ws-1'
const at = (minute: number) => new Date(`2026-07-01T10:${String(minute).padStart(2, '0')}:00Z`)

const teamMessage = (over: any = {}) => ({
  id: 'tm-1',
  authorUserId: 'alice',
  createdAt: at(10),
  conversationId: 'conv-1',
  threadRootId: null,
  text: 'hello channel',
  mentions: [],
  ...over,
})

const agentMessage = (over: any = {}) => ({
  id: 'am-1',
  role: 'user',
  authorUserId: 'alice',
  createdAt: at(20),
  content: 'add the export button',
  sessionId: 'sess-1',
  session: {
    id: 'sess-1',
    name: 'Export work',
    inferredName: null,
    createdByUserId: 'alice',
    // A project chat is contextType + contextId; ChatSession has no projectId.
    contextType: 'project',
    contextId: 'proj-1',
  },
  ...over,
})

beforeEach(() => {
  fx.team = []
  fx.agent = []
  fx.conversations = [{ id: 'conv-1', kind: 'public', name: 'shogo-dev' }]
  fx.members = []
  fx.threadRoots = []
  fx.cards = []
  fx.users = []
  fx.projects = []
  fx.unattributed = 0
  for (const key of Object.keys(calls)) delete calls[key]
})

describe('getMemberMessages', () => {
  test('reads only what the person sent, from team chat and agent chats', async () => {
    fx.team = [teamMessage()]
    fx.agent = [agentMessage()]

    const out = await svc.getMemberMessages(WS, 'alice', {})

    expect(out.items.map((i) => [i.source, i.id])).toEqual([
      ['agent_chat', 'am-1'],
      ['team_chat', 'tm-1'],
    ])
    // Their text and the ids needed to dig further.
    expect(out.items[0]).toMatchObject({
      text: 'add the export button',
      audience: 'agent',
      chatSession: { id: 'sess-1', name: 'Export work', projectId: 'proj-1' },
    })
    expect(out.items[1]).toMatchObject({
      conversation: { id: 'conv-1', kind: 'public', name: 'shogo-dev' },
      audience: 'channel',
    })

    // Both queries are pinned to this workspace and this person.
    const teamWhere = calls.team.find((c: any) => c.where.authorType)!.where
    expect(teamWhere).toMatchObject({ workspaceId: WS, authorType: 'user', authorUserId: 'alice', deletedAt: null })
    const agentWhere = calls.agent[0].where
    expect(agentWhere.role).toBe('user')
    expect(agentWhere.AND[1].OR[0]).toEqual({ authorUserId: 'alice' })
    // Agent output, replies and project-call relays never appear.
    expect(agentWhere.agent).toEqual({ not: expect.anything() })
  })

  test('reports the project from the session context, and nothing for a workspace chat', async () => {
    fx.agent = [
      agentMessage(),
      agentMessage({
        id: 'am-2',
        createdAt: at(5),
        session: {
          id: 'sess-2',
          name: null,
          inferredName: 'Workspace chat',
          createdByUserId: 'alice',
          contextType: 'workspace',
          contextId: null,
        },
      }),
    ]

    const out = await svc.getMemberMessages(WS, 'alice', { source: 'agent_chat' })

    expect(out.items.find((i) => i.id === 'am-1')?.chatSession).toMatchObject({ projectId: 'proj-1' })
    // A workspace-scoped session is not a project chat, and it falls back to
    // the inferred name when that is all the session has.
    expect(out.items.find((i) => i.id === 'am-2')?.chatSession).toMatchObject({
      name: 'Workspace chat',
      projectId: null,
    })
  })

  test('a DM with a person is a message to a person; one tagging an agent is not', async () => {
    fx.team = [
      teamMessage({ id: 'tm-dm', conversationId: 'dm-1', text: 'thanks!' }),
      teamMessage({ id: 'tm-agent', createdAt: at(5), text: '@Planner break this down', mentions: [{ targetType: 'agent' }] }),
    ]
    fx.conversations = [
      { id: 'conv-1', kind: 'public', name: 'shogo-dev' },
      { id: 'dm-1', kind: 'dm', name: null },
    ]
    fx.members = [
      { conversationId: 'dm-1', memberType: 'user', userId: 'alice' },
      { conversationId: 'dm-1', memberType: 'user', userId: 'bob' },
    ]

    const out = await svc.getMemberMessages(WS, 'alice', {})

    expect(out.items.find((i) => i.id === 'tm-dm')?.audience).toBe('person')
    expect(out.items.find((i) => i.id === 'tm-agent')?.audience).toBe('agent')
  })

  test('audience=agent keeps the team-chat message that tagged an agent', async () => {
    fx.team = [
      teamMessage({ id: 'tm-agent', text: '@Planner break this down', mentions: [{ targetType: 'agent' }] }),
      teamMessage({ id: 'tm-person', createdAt: at(5), text: 'standup notes', mentions: [{ targetType: 'user' }] }),
    ]
    fx.agent = [agentMessage()]

    const out = await svc.getMemberMessages(WS, 'alice', { audience: 'agent' })

    // Both the agent-chat prompt and the team-chat post aimed at an agent.
    expect(out.items.map((i) => i.id).sort()).toEqual(['am-1', 'tm-agent'])
    expect(out.items.every((i) => i.audience === 'agent')).toBe(true)
  })

  test('audience=person skips agent chats entirely', async () => {
    fx.team = [teamMessage({ id: 'tm-person', mentions: [{ targetType: 'user' }] })]
    fx.agent = [agentMessage()]

    const out = await svc.getMemberMessages(WS, 'alice', { audience: 'person' })

    expect(out.items.map((i) => i.id)).toEqual(['tm-person'])
    expect(calls.agent).toBeUndefined()
  })

  test('source narrows to one place, and the window is applied on both sides', async () => {
    fx.team = [teamMessage()]
    fx.agent = [agentMessage()]
    const since = new Date('2026-07-01T10:00:00Z')

    await svc.getMemberMessages(WS, 'alice', { source: 'team_chat', since })
    expect(calls.team[0].where.createdAt).toEqual({ gte: since })
    expect(calls.agent).toBeUndefined()

    delete calls.agent
    delete calls.team
    await svc.getMemberMessages(WS, 'alice', { source: 'agent_chat', since })
    expect(calls.team).toBeUndefined()
    expect(calls.agent[0].where.createdAt).toEqual({ gte: since })
  })

  test('pages with a cursor so the second page starts where the first ended', async () => {
    fx.team = [
      teamMessage({ id: 'tm-1', createdAt: at(10) }),
      teamMessage({ id: 'tm-2', createdAt: at(5) }),
    ]
    fx.agent = [
      agentMessage({ id: 'am-1', createdAt: at(20) }),
      agentMessage({ id: 'am-2', createdAt: at(1) }),
    ]

    const first = await svc.getMemberMessages(WS, 'alice', { limit: 2 })
    expect(first.items.map((i) => i.id)).toEqual(['am-1', 'tm-1'])
    expect(first.nextCursor).toBe(svc.encodeCursor(first.items[1]))

    const second = await svc.getMemberMessages(WS, 'alice', { limit: 2, cursor: first.nextCursor })
    expect(second.items.map((i) => i.id)).toEqual(['tm-2', 'am-2'])
    expect(second.nextCursor).toBeNull()
  })

  test('a card thread is named, so an exported message points at its card', async () => {
    fx.team = [teamMessage({ threadRootId: 'root-1' })]
    fx.threadRoots = [{ id: 'root-1', authorType: 'user' }]
    fx.cards = [{ key: 'SHO-7', threadRootMessageId: 'root-1' }]

    const out = await svc.getMemberMessages(WS, 'alice', {})

    expect(out.items[0]).toMatchObject({ workItemKey: 'SHO-7', threadRootId: 'root-1', audience: 'channel' })
  })

  test('a reply in an agent thread is counted as a message to that agent', async () => {
    fx.team = [teamMessage({ threadRootId: 'root-2', text: 'go ahead' })]
    fx.threadRoots = [{ id: 'root-2', authorType: 'agent' }]

    const out = await svc.getMemberMessages(WS, 'alice', {})

    expect(out.items[0].audience).toBe('agent')
  })

  test('reports prompts nobody can be credited for, and never on a team-chat export', async () => {
    fx.unattributed = 3
    expect((await svc.getMemberMessages(WS, 'alice', {})).unattributed).toBe(3)

    delete calls.count
    expect((await svc.getMemberMessages(WS, 'alice', { source: 'team_chat' })).unattributed).toBe(0)
    expect(calls.count).toBeUndefined()
  })

  test('mentions carry the person or project they name', async () => {
    fx.team = [
      teamMessage({
        mentions: [
          { targetType: 'user', targetUserId: 'bob', projectId: null },
          { targetType: 'agent', targetUserId: null, projectId: 'proj-2' },
        ],
      }),
    ]
    fx.users = [{ id: 'bob', name: 'Bob', email: 'bob@example.com' }]
    fx.projects = [{ id: 'proj-2', name: 'Website' }]

    const out = await svc.getMemberMessages(WS, 'alice', {})

    expect(out.items[0].mentions).toEqual([
      { type: 'user', id: 'bob', name: 'Bob' },
      { type: 'agent', id: 'proj-2', name: 'Website' },
    ])
    expect(out.items[0].audience).toBe('mixed')
  })

  test('a garbage cursor is ignored rather than throwing', async () => {
    fx.team = [teamMessage()]
    const out = await svc.getMemberMessages(WS, 'alice', { cursor: 'not-a-cursor' })
    expect(out.items).toHaveLength(1)
  })

  test('the limit is clamped, so one page cannot stream the workspace', async () => {
    fx.team = Array.from({ length: 5 }, (_, i) => teamMessage({ id: `tm-${i}`, createdAt: at(i) }))
    expect((await svc.getMemberMessages(WS, 'alice', { limit: 0 })).items.length).toBe(1)
    expect((await svc.getMemberMessages(WS, 'alice', { limit: 9999 })).items.length).toBe(5)
  })
})

describe('getAllMemberMessages (the CSV)', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      teamMessage({ id: `tm-${String(i).padStart(3, '0')}`, createdAt: new Date(at(0).getTime() - i * 1000) }),
    )

  test('follows the cursor past one page', async () => {
    fx.team = many(4)
    const all = await svc.getAllMemberMessages(WS, 'alice', {})
    expect(all.items).toHaveLength(4)
    expect(all.truncated).toBe(false)
  })

  test('stops at the row cap and says it was truncated rather than lying', async () => {
    fx.team = many(250)
    const capped = await svc.getAllMemberMessages(WS, 'alice', {}, 10)
    expect(capped.items).toHaveLength(10)
    expect(capped.truncated).toBe(true)
  })
})
