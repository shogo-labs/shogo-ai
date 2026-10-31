// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GET /api/chat-messages/session/:sessionId/changes (SHO-260).
 *
 * The delta read a device makes when it already holds a chat: only rows whose
 * `updatedAt` moved since the cursor, plus the scope's total so a deletion is
 * detectable, plus `reset` whenever the client must reload the page instead.
 *
 * Run: bun test apps/api/src/routes/__tests__/chat-message-changes.test.ts
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { mock } from 'bun:test'

type Row = {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  parts: string | null
  createdAt: Date
  updatedAt: Date
  agent: string
}

const rows: Row[] = []
const sessions = new Map<string, { members: string[] }>()
let lastFindManyArgs: any = null
let reconcileCalls = 0

function matching(where: any): Row[] {
  return rows.filter((row) => {
    if (where.sessionId && row.sessionId !== where.sessionId) return false
    if (where.agent?.in && !where.agent.in.includes(row.agent)) return false
    if (where.agent && typeof where.agent === 'string' && row.agent !== where.agent) return false
    if (where.updatedAt?.gte && row.updatedAt < where.updatedAt.gte) return false
    return true
  })
}

const mockPrisma = {
  chatSession: {
    findUnique: async ({ where }: any) => {
      const session = sessions.get(where.id)
      return session
        ? {
            id: where.id,
            createdByUserId: null,
            contextType: 'project',
            projectId: 'p1',
            workspaceId: null,
            project: { id: 'p1', workspace: { members: session.members.map((userId) => ({ userId })) } },
            workspace: null,
          }
        : null
    },
  },
  chatMessage: {
    findMany: async (args: any) => {
      lastFindManyArgs = args
      const matched = matching(args.where)
      matched.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      return args.take ? matched.slice(0, args.take) : matched
    },
    count: async (args: any) => matching(args.where).length,
    findFirst: async (args: any) => {
      const matched = matching(args.where)
      if (!matched.length) return null
      matched.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      return args?.orderBy?.updatedAt === 'desc'
        ? matched[matched.length - 1]
        : matched[0]
    },
  },
}

mock.module('../../lib/prisma', () => ({ prisma: mockPrisma }))
// The real `authorizeChatSession` needs a full `Principal`; the membership rule
// is what this test needs, and it is the same rule the list route applies.
mock.module('../../generated/chat-session.hooks', () => ({
  CHAT_SESSION_SCOPE_SELECT: { id: true },
  authorizeChatSession: async (_ctx: any, session: any) => {
    const members = session?.project?.workspace?.members ?? []
    return members.some((m: any) => m.userId === 'u1')
      ? { ok: true }
      : { ok: false, error: { code: 'forbidden', message: 'Access denied to this chat session' } }
  },
}))
mock.module('../../services/agent-call-reconcile.service', () => ({
  reconcileCallReplyOnRead: async () => {
    reconcileCalls += 1
    return false
  },
}))

const { createChatMessageEditRoutes, CHAT_CHANGES_CAP } = await import('../chat-message-edits')

function buildApp(auth: any) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', auth)
    await next()
  })
  app.route('/api/chat-messages', createChatMessageEditRoutes())
  return app
}

const MEMBER = { userId: 'u1', isAuthenticated: true, tunnelAuthenticated: false }

async function get(path: string, auth: any = MEMBER) {
  const res = await buildApp(auth).request(path)
  return { status: res.status, body: (await res.json()) as any }
}

function row(over: Partial<Row> & { id: string }): Row {
  const at = over.createdAt ?? new Date('2026-10-30T10:00:00.000Z')
  return {
    sessionId: 's1',
    role: 'assistant',
    content: 'hi',
    parts: null,
    createdAt: at,
    updatedAt: at,
    agent: 'technical',
    ...over,
  } as Row
}

beforeEach(() => {
  rows.length = 0
  lastFindManyArgs = null
  reconcileCalls = 0
  sessions.clear()
  sessions.set('s1', { members: ['u1'] })
})

describe('GET /api/chat-messages/session/:id/changes', () => {
  test('401 when unauthenticated', async () => {
    const { status } = await get('/api/chat-messages/session/s1/changes?since=2026-10-30T00:00:00.000Z', {})
    expect(status).toBe(401)
  })

  test('404 for a session that does not exist', async () => {
    const { status } = await get('/api/chat-messages/session/nope/changes?since=2026-10-30T00:00:00.000Z')
    expect(status).toBe(404)
  })

  test('403 when the caller is not a member of the session’s workspace', async () => {
    sessions.set('s1', { members: ['someone-else'] })
    const { status } = await get('/api/chat-messages/session/s1/changes?since=2026-10-30T00:00:00.000Z')
    expect(status).toBe(403)
  })

  test('returns only rows changed since the cursor, plus total and cursor', async () => {
    rows.push(
      row({ id: 'old', createdAt: new Date('2026-10-30T09:00:00.000Z') }),
      row({
        id: 'changed',
        createdAt: new Date('2026-10-30T09:10:00.000Z'),
        updatedAt: new Date('2026-10-30T09:30:00.000Z'),
      }),
      row({ id: 'new', createdAt: new Date('2026-10-30T09:20:00.000Z') }),
    )

    const { status, body } = await get(
      '/api/chat-messages/session/s1/changes?agent=technical&since=2026-10-30T09:25:00.000Z',
    )

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.items.map((i: any) => i.id)).toEqual(['changed'])
    expect(body.total).toBe(3)
    expect(body.cursor).toBe('2026-10-30T09:30:00.000Z')
    expect(body.reset).toBe(false)
    // Oldest first and capped, so the client can merge without re-sorting.
    expect(lastFindManyArgs.orderBy).toEqual({ createdAt: 'asc' })
    expect(lastFindManyArgs.take).toBe(CHAT_CHANGES_CAP + 1)
  })

  test('a reply that grew in place comes back even though its createdAt is old', async () => {
    rows.push(
      row({
        id: 'grew',
        createdAt: new Date('2026-10-30T09:00:00.000Z'),
        updatedAt: new Date('2026-10-30T09:59:00.000Z'),
      }),
    )
    const { body } = await get('/api/chat-messages/session/s1/changes?since=2026-10-30T09:30:00.000Z')
    expect(body.items.map((i: any) => i.id)).toEqual(['grew'])
  })

  test('nothing changed returns an empty list and keeps the floor moving forward', async () => {
    // The client sends `cursor − 5 s` for clock skew, so echoing `since` would
    // walk its floor backwards on every quiet reopen (SHO-260). The scope's
    // newest row is the floor instead.
    rows.push(row({ id: 'quiet', createdAt: new Date('2026-10-30T08:00:00.000Z') }))
    const { body } = await get('/api/chat-messages/session/s1/changes?since=2026-10-30T09:00:00.000Z')
    expect(body.items).toEqual([])
    expect(body.total).toBe(1)
    expect(body.cursor).toBe('2026-10-30T08:00:00.000Z')
    expect(body.reset).toBe(false)
  })

  test('nothing changed in an empty scope answers no cursor, and the client keeps its own', async () => {
    // No rows means there is no floor to hand back; the client keeps the one it
    // sent, so a delta that carried nothing never moves it (SHO-260).
    const { body } = await get('/api/chat-messages/session/s1/changes?since=2026-10-30T09:00:00.000Z')
    expect(body.items).toEqual([])
    expect(body.cursor).toBeNull()
    expect(body.reset).toBe(false)
  })

  test('total drops after a truncate-from, which is how the client notices a delete', async () => {
    rows.push(
      row({ id: 'a', createdAt: new Date('2026-10-30T09:00:00.000Z') }),
      row({ id: 'b', createdAt: new Date('2026-10-30T09:01:00.000Z') }),
    )
    const before = await get('/api/chat-messages/session/s1/changes?since=2026-10-30T08:00:00.000Z')
    expect(before.body.total).toBe(2)

    rows.splice(1, 1)
    const after = await get('/api/chat-messages/session/s1/changes?since=2026-10-30T08:00:00.000Z')
    expect(after.body.total).toBe(1)
  })

  test('reset: true when the cap is hit (the client must reload the page)', async () => {
    const base = Date.now() - 60 * 60 * 1000
    for (let i = 0; i <= CHAT_CHANGES_CAP; i += 1) {
      rows.push(
        row({
          id: `m${i}`,
          createdAt: new Date(base + i * 1000),
          updatedAt: new Date(base + i * 1000),
        }),
      )
    }
    const since = new Date(base - 60 * 60 * 1000).toISOString()
    const { body } = await get(`/api/chat-messages/session/s1/changes?since=${since}`)
    expect(body.reset).toBe(true)
    expect(body.items).toHaveLength(CHAT_CHANGES_CAP)
    // The newest rows are the ones kept.
    expect(body.items[body.items.length - 1].id).toBe(`m${CHAT_CHANGES_CAP}`)
  })

  test('reset: true when the cursor does not parse', async () => {
    const { body } = await get('/api/chat-messages/session/s1/changes?since=not-a-date')
    expect(body.reset).toBe(true)
    expect(body.items).toEqual([])
  })

  test('reset: true when there is no cursor at all', async () => {
    const { body } = await get('/api/chat-messages/session/s1/changes')
    expect(body.reset).toBe(true)
  })

  test('reset: true when the cursor is more than 30 days old', async () => {
    const ancient = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    const { body } = await get(`/api/chat-messages/session/s1/changes?since=${ancient}`)
    expect(body.reset).toBe(true)
  })

  test('the technical filter includes project_call prompts, like the list does', async () => {
    rows.push(
      row({ id: 'call', agent: 'project_call', createdAt: new Date('2026-10-30T09:10:00.000Z') }),
      row({ id: 'voice', agent: 'voice', createdAt: new Date('2026-10-30T09:10:00.000Z') }),
    )
    const { body } = await get('/api/chat-messages/session/s1/changes?agent=technical&since=2026-10-30T09:00:00.000Z')
    expect(body.items.map((i: any) => i.id)).toEqual(['call'])
  })

  test('a tunnel-authenticated caller skips the membership check', async () => {
    sessions.set('s1', { members: [] })
    rows.push(row({ id: 'x', createdAt: new Date('2026-10-30T09:10:00.000Z') }))
    const { status, body } = await get('/api/chat-messages/session/s1/changes?since=2026-10-30T09:00:00.000Z', {
      userId: 'u-machine',
      isAuthenticated: true,
      tunnelAuthenticated: true,
    })
    expect(status).toBe(200)
    expect(body.items.map((i: any) => i.id)).toEqual(['x'])
  })

  test('an unknown agent value is a 400, same as the list route', async () => {
    const { status } = await get('/api/chat-messages/session/s1/changes?agent=other&since=2026-10-30T09:00:00.000Z')
    expect(status).toBe(400)
  })
})
