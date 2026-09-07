// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * chat-session-fork route tests.
 *
 * Covers POST /api/chat-sessions/:id/fork:
 *   - 401 unauthenticated
 *   - 400 when messageId is missing
 *   - 404 when the session id is unknown
 *   - 403 when the caller is not a workspace member (project-scoped)
 *   - 404 when messageId doesn't belong to the session
 *   - 200 happy path: clones messages up to and including the target,
 *     excludes later messages, creates a new session with a "(fork)"
 *     name/inferredName, mirrors contextType/contextId/phase
 *   - workspace-scoped sessions: access via session.workspace.members
 *     (not just session.project.workspace.members), and attached
 *     projects are cloned onto the new session
 *   - tunnel-authenticated callers skip the membership check
 *
 * Run: bun test apps/api/src/routes/__tests__/chat-session-fork.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

type SessionFixture = {
  id: string
  name: string | null
  inferredName: string
  contextType: string
  contextId: string | null
  workspaceId: string | null
  phase: string | null
  projectWorkspaceMembers?: string[]
  directWorkspaceMembers?: string[]
  attachedProjects?: Array<{ projectId: string; attachMode: string }>
}

type MessageFixture = {
  id: string
  sessionId: string
  role: string
  content: string
  imageData: string | null
  parts: string | null
  agent: string
  model: string | null
  createdAt: Date
}

const sessionsById = new Map<string, SessionFixture>()
const messagesById = new Map<string, MessageFixture>()
let createdSessions: Array<{ id: string; data: any }> = []
let createdMessages: Array<any> = []
let createdSessionProjects: Array<any> = []
let nextId = 1

function freshId(prefix: string) {
  return `${prefix}-${nextId++}`
}

function shapeSession(s: SessionFixture) {
  return {
    id: s.id,
    name: s.name,
    inferredName: s.inferredName,
    contextType: s.contextType,
    contextId: s.contextId,
    workspaceId: s.workspaceId,
    phase: s.phase,
    project: s.projectWorkspaceMembers
      ? { workspace: { members: s.projectWorkspaceMembers.map((userId) => ({ userId })) } }
      : null,
    workspace: s.directWorkspaceMembers
      ? { members: s.directWorkspaceMembers.map((userId) => ({ userId })) }
      : null,
    attachedProjects: s.attachedProjects ?? [],
  }
}

const mockPrisma = {
  chatSession: {
    findUnique: mock(async (args: any) => {
      const fixture = sessionsById.get(args.where?.id)
      if (!fixture) return null
      return shapeSession(fixture)
    }),
    create: mock(async (args: any) => {
      const id = freshId('new-session')
      createdSessions.push({ id, data: args.data })
      return { id, ...args.data }
    }),
  },
  chatMessage: {
    findUnique: mock(async (args: any) => {
      const fixture = messagesById.get(args.where?.id)
      if (!fixture) return null
      return { ...fixture }
    }),
    findMany: mock(async (args: any) => {
      const sessionId = args.where?.sessionId
      const lte = args.where?.createdAt?.lte as Date | undefined
      const rows = [...messagesById.values()].filter(
        (m) => m.sessionId === sessionId && (!lte || m.createdAt.getTime() <= lte.getTime()),
      )
      rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      return rows
    }),
    createMany: mock(async (args: any) => {
      createdMessages.push(...args.data)
      return { count: args.data.length }
    }),
  },
  chatSessionProject: {
    createMany: mock(async (args: any) => {
      createdSessionProjects.push(...args.data)
      return { count: args.data.length }
    }),
  },
  $transaction: mock(async (fn: any) => fn(mockPrisma)),
}

mock.module('../../lib/prisma', () => ({ prisma: mockPrisma }))

const { createChatSessionForkRoutes } = await import('../chat-session-fork')

type AuthContext = {
  isAuthenticated?: boolean
  userId?: string
  tunnelAuthenticated?: boolean
}

function createApp(auth: AuthContext | null) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth)
    await next()
  })
  app.route('/api/chat-sessions', createChatSessionForkRoutes())
  return app
}

function seedProjectSession(opts: {
  id: string
  members: string[]
  name?: string | null
  inferredName?: string
  contextId?: string
  phase?: string | null
}) {
  sessionsById.set(opts.id, {
    id: opts.id,
    name: opts.name === undefined ? 'My chat' : opts.name,
    inferredName: opts.inferredName ?? 'My chat',
    contextType: 'project',
    contextId: opts.contextId ?? `proj-${opts.id}`,
    workspaceId: null,
    phase: opts.phase ?? null,
    projectWorkspaceMembers: opts.members,
  })
}

function seedWorkspaceSession(opts: {
  id: string
  members: string[]
  workspaceId: string
  attachedProjects?: Array<{ projectId: string; attachMode: string }>
}) {
  sessionsById.set(opts.id, {
    id: opts.id,
    name: 'Workspace chat',
    inferredName: 'Workspace chat',
    contextType: 'workspace',
    contextId: null,
    workspaceId: opts.workspaceId,
    phase: null,
    directWorkspaceMembers: opts.members,
    attachedProjects: opts.attachedProjects ?? [],
  })
}

function seedMessage(opts: { id: string; sessionId: string; content: string; createdAtMs: number }) {
  messagesById.set(opts.id, {
    id: opts.id,
    sessionId: opts.sessionId,
    role: 'user',
    content: opts.content,
    imageData: null,
    parts: null,
    agent: 'technical',
    model: null,
    createdAt: new Date(opts.createdAtMs),
  })
}

beforeEach(() => {
  sessionsById.clear()
  messagesById.clear()
  createdSessions = []
  createdMessages = []
  createdSessionProjects = []
  nextId = 1
  mockPrisma.chatSession.findUnique.mockClear()
  mockPrisma.chatSession.create.mockClear()
  mockPrisma.chatMessage.findUnique.mockClear()
  mockPrisma.chatMessage.findMany.mockClear()
  mockPrisma.chatMessage.createMany.mockClear()
  mockPrisma.chatSessionProject.createMany.mockClear()
  mockPrisma.$transaction.mockClear()
})

describe('POST /api/chat-sessions/:id/fork — auth + validation gates', () => {
  test('401 when unauthenticated', async () => {
    const app = createApp(null)
    const res = await app.request('/api/chat-sessions/s1/fork', {
      method: 'POST',
      body: JSON.stringify({ messageId: 'msg-1' }),
    })
    expect(res.status).toBe(401)
  })

  test('400 when messageId is missing', async () => {
    seedProjectSession({ id: 's1', members: ['u1'] })
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-sessions/s1/fork', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test('404 when session id is unknown', async () => {
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-sessions/ghost/fork', {
      method: 'POST',
      body: JSON.stringify({ messageId: 'msg-1' }),
    })
    expect(res.status).toBe(404)
  })

  test('403 when caller is not a workspace member', async () => {
    seedProjectSession({ id: 's1', members: ['owner-user'] })
    seedMessage({ id: 'msg-1', sessionId: 's1', content: 'hi', createdAtMs: 1000 })
    const app = createApp({ isAuthenticated: true, userId: 'intruder' })
    const res = await app.request('/api/chat-sessions/s1/fork', {
      method: 'POST',
      body: JSON.stringify({ messageId: 'msg-1' }),
    })
    expect(res.status).toBe(403)
  })

  test("404 when messageId doesn't belong to the session", async () => {
    seedProjectSession({ id: 's1', members: ['u1'] })
    seedProjectSession({ id: 's2', members: ['u1'] })
    seedMessage({ id: 'msg-other', sessionId: 's2', content: 'hi', createdAtMs: 1000 })
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-sessions/s1/fork', {
      method: 'POST',
      body: JSON.stringify({ messageId: 'msg-other' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/chat-sessions/:id/fork — happy path', () => {
  test('clones messages up to and including the target, excludes later messages', async () => {
    seedProjectSession({ id: 's1', members: ['u1'], name: 'Bug hunt', inferredName: 'Bug hunt', phase: 'build' })
    seedMessage({ id: 'msg-a', sessionId: 's1', content: 'first', createdAtMs: 1000 })
    seedMessage({ id: 'msg-b', sessionId: 's1', content: 'second (fork point)', createdAtMs: 2000 })
    seedMessage({ id: 'msg-c', sessionId: 's1', content: 'third (after fork point)', createdAtMs: 3000 })

    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-sessions/s1/fork', {
      method: 'POST',
      body: JSON.stringify({ messageId: 'msg-b' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { ok: boolean; sessionId: string; messageCount: number }
    expect(body.ok).toBe(true)
    expect(body.messageCount).toBe(2)

    // New session mirrors contextType/contextId/phase and gets a "(fork)" name.
    expect(createdSessions).toHaveLength(1)
    expect(createdSessions[0]!.data.name).toBe('Bug hunt (fork)')
    expect(createdSessions[0]!.data.inferredName).toBe('Bug hunt (fork)')
    expect(createdSessions[0]!.data.contextType).toBe('project')
    expect(createdSessions[0]!.data.contextId).toBe('proj-s1')
    expect(createdSessions[0]!.data.phase).toBe('build')

    // Only msg-a and msg-b were cloned — msg-c (after the fork point) is excluded.
    expect(createdMessages).toHaveLength(2)
    const contents = createdMessages.map((m) => m.content)
    expect(contents).toEqual(['first', 'second (fork point)'])
    // Cloned rows point at the new session, not the source.
    for (const m of createdMessages) {
      expect(m.sessionId).toBe(body.sessionId)
    }

    // Atomic via $transaction.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
  })

  test('a null session.name yields a null forked name (not "null (fork)")', async () => {
    seedProjectSession({ id: 's1', members: ['u1'], name: null, inferredName: 'Untitled' })
    seedMessage({ id: 'msg-a', sessionId: 's1', content: 'hi', createdAtMs: 1000 })
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-sessions/s1/fork', {
      method: 'POST',
      body: JSON.stringify({ messageId: 'msg-a' }),
    })
    expect(res.status).toBe(201)
    expect(createdSessions[0]!.data.name).toBeNull()
    expect(createdSessions[0]!.data.inferredName).toBe('Untitled (fork)')
  })

  test('forking the very first message clones exactly one message', async () => {
    seedProjectSession({ id: 's1', members: ['u1'] })
    seedMessage({ id: 'msg-a', sessionId: 's1', content: 'first', createdAtMs: 1000 })
    seedMessage({ id: 'msg-b', sessionId: 's1', content: 'second', createdAtMs: 2000 })
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-sessions/s1/fork', {
      method: 'POST',
      body: JSON.stringify({ messageId: 'msg-a' }),
    })
    const body = (await res.json()) as { messageCount: number }
    expect(body.messageCount).toBe(1)
    expect(createdMessages).toHaveLength(1)
    expect(createdMessages[0]!.content).toBe('first')
  })

  test('workspace-scoped sessions: access granted via session.workspace.members, attached projects cloned', async () => {
    seedWorkspaceSession({
      id: 'ws-session',
      members: ['u1'],
      workspaceId: 'ws-1',
      attachedProjects: [
        { projectId: 'proj-a', attachMode: 'readwrite' },
        { projectId: 'proj-b', attachMode: 'readonly' },
      ],
    })
    seedMessage({ id: 'msg-a', sessionId: 'ws-session', content: 'hi', createdAtMs: 1000 })
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-sessions/ws-session/fork', {
      method: 'POST',
      body: JSON.stringify({ messageId: 'msg-a' }),
    })
    expect(res.status).toBe(201)
    expect(createdSessions[0]!.data.workspaceId).toBe('ws-1')
    expect(createdSessions[0]!.data.contextId).toBeNull()
    expect(createdSessionProjects).toHaveLength(2)
    expect(createdSessionProjects.map((p) => p.projectId).sort()).toEqual(['proj-a', 'proj-b'])
    for (const p of createdSessionProjects) {
      expect(p.sessionId).toBe(createdSessions[0]!.id)
    }
  })

  test('tunnel-authenticated callers skip the membership check', async () => {
    seedProjectSession({ id: 's1', members: ['someone-else'] })
    seedMessage({ id: 'msg-a', sessionId: 's1', content: 'hi', createdAtMs: 1000 })
    const app = createApp({ isAuthenticated: true, userId: 'bridge-proxy', tunnelAuthenticated: true })
    const res = await app.request('/api/chat-sessions/s1/fork', {
      method: 'POST',
      body: JSON.stringify({ messageId: 'msg-a' }),
    })
    expect(res.status).toBe(201)
  })
})
