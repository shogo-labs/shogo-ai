// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * chat-message-feedback routes tests.
 *
 * Covers:
 *   PUT /api/chat-messages/:id/feedback
 *     - 401 unauthenticated
 *     - 400 when `thumbs` is missing/invalid
 *     - 404 when the message id is unknown
 *     - 403 when the caller is not a workspace member
 *     - 200 happy path: creates a feedback row on first tap
 *     - 200 happy path: flips 'up' -> 'down' via upsert (still one row)
 *     - tunnel-authenticated callers skip the membership check
 *
 *   DELETE /api/chat-messages/:id/feedback
 *     - 401 / 404 / 403 same auth gates
 *     - 200 removes an existing row
 *     - 200 no-op when no row exists (idempotent double-tap)
 *
 *   GET /api/chat-sessions/:id/feedback
 *     - 401 / 404 / 403 same auth gates
 *     - 200 returns only the caller's own feedback, keyed by messageId
 *
 * Run: bun test apps/api/src/routes/__tests__/chat-message-feedback.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

type SessionFixture = {
  sessionId: string
  workspaceMembers: string[]
}

type MessageFixture = {
  id: string
  sessionId: string
}

type FeedbackRow = {
  messageId: string
  userId: string
  thumbs: string
  createdAt: Date
  updatedAt: Date
}

const messagesById = new Map<string, MessageFixture>()
const sessionsById = new Map<string, SessionFixture>()
// Keyed by `${messageId}::${userId}`
const feedbackByKey = new Map<string, FeedbackRow>()

function feedbackKey(messageId: string, userId: string) {
  return `${messageId}::${userId}`
}

function shapeMessage(msg: MessageFixture) {
  const session = sessionsById.get(msg.sessionId)
  if (!session) return null
  return {
    id: msg.id,
    sessionId: msg.sessionId,
    session: {
      project: {
        workspace: {
          members: session.workspaceMembers.map((userId) => ({ userId })),
        },
      },
    },
  }
}

function shapeSession(session: SessionFixture) {
  return {
    id: session.sessionId,
    project: {
      workspace: {
        members: session.workspaceMembers.map((userId) => ({ userId })),
      },
    },
  }
}

const mockPrisma = {
  chatMessage: {
    findUnique: mock(async (args: any) => {
      const fixture = messagesById.get(args.where?.id)
      if (!fixture) return null
      return shapeMessage(fixture)
    }),
  },
  chatSession: {
    findUnique: mock(async (args: any) => {
      const fixture = sessionsById.get(args.where?.id)
      if (!fixture) return null
      return shapeSession(fixture)
    }),
  },
  messageFeedback: {
    upsert: mock(async (args: any) => {
      const { messageId, userId } = args.where.messageId_userId
      const key = feedbackKey(messageId, userId)
      const now = new Date()
      const existing = feedbackByKey.get(key)
      const row: FeedbackRow = existing
        ? { ...existing, thumbs: args.update.thumbs, updatedAt: now }
        : { messageId, userId, thumbs: args.create.thumbs, createdAt: now, updatedAt: now }
      feedbackByKey.set(key, row)
      return row
    }),
    deleteMany: mock(async (args: any) => {
      const key = feedbackKey(args.where.messageId, args.where.userId)
      const existed = feedbackByKey.delete(key)
      return { count: existed ? 1 : 0 }
    }),
    findMany: mock(async (args: any) => {
      const userId = args.where?.userId
      const sessionId = args.where?.message?.sessionId
      const rows: Array<{ messageId: string; thumbs: string }> = []
      for (const row of feedbackByKey.values()) {
        if (row.userId !== userId) continue
        const msg = messagesById.get(row.messageId)
        if (!msg || msg.sessionId !== sessionId) continue
        rows.push({ messageId: row.messageId, thumbs: row.thumbs })
      }
      return rows
    }),
  },
}

mock.module('../../lib/prisma', () => ({ prisma: mockPrisma }))

const { createChatMessageFeedbackRoutes, createChatSessionFeedbackRoutes } = await import(
  '../chat-message-feedback'
)

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
  app.route('/api/chat-messages', createChatMessageFeedbackRoutes())
  app.route('/api/chat-sessions', createChatSessionFeedbackRoutes())
  return app
}

function seedSession(sessionId: string, members: string[]) {
  sessionsById.set(sessionId, { sessionId, workspaceMembers: members })
}

function seedMessage(id: string, sessionId: string) {
  messagesById.set(id, { id, sessionId })
}

beforeEach(() => {
  messagesById.clear()
  sessionsById.clear()
  feedbackByKey.clear()
  mockPrisma.chatMessage.findUnique.mockClear()
  mockPrisma.chatSession.findUnique.mockClear()
  mockPrisma.messageFeedback.upsert.mockClear()
  mockPrisma.messageFeedback.deleteMany.mockClear()
  mockPrisma.messageFeedback.findMany.mockClear()
})

// =============================================================================
// PUT /api/chat-messages/:id/feedback
// =============================================================================

describe('PUT /api/chat-messages/:id/feedback — auth + validation gates', () => {
  test('401 when unauthenticated', async () => {
    const app = createApp(null)
    const res = await app.request('/api/chat-messages/msg-1/feedback', {
      method: 'PUT',
      body: JSON.stringify({ thumbs: 'up' }),
    })
    expect(res.status).toBe(401)
  })

  test('400 when thumbs is missing', async () => {
    seedSession('s1', ['u1'])
    seedMessage('msg-1', 's1')
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-messages/msg-1/feedback', {
      method: 'PUT',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test("400 when thumbs is neither 'up' nor 'down'", async () => {
    seedSession('s1', ['u1'])
    seedMessage('msg-1', 's1')
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-messages/msg-1/feedback', {
      method: 'PUT',
      body: JSON.stringify({ thumbs: 'sideways' }),
    })
    expect(res.status).toBe(400)
  })

  test('404 when message id is unknown', async () => {
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-messages/ghost/feedback', {
      method: 'PUT',
      body: JSON.stringify({ thumbs: 'up' }),
    })
    expect(res.status).toBe(404)
  })

  test('403 when caller is not a workspace member', async () => {
    seedSession('s1', ['owner-user'])
    seedMessage('msg-1', 's1')
    const app = createApp({ isAuthenticated: true, userId: 'intruder' })
    const res = await app.request('/api/chat-messages/msg-1/feedback', {
      method: 'PUT',
      body: JSON.stringify({ thumbs: 'up' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('PUT /api/chat-messages/:id/feedback — happy path', () => {
  test('creates a feedback row on first tap', async () => {
    seedSession('s1', ['u1'])
    seedMessage('msg-1', 's1')
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-messages/msg-1/feedback', {
      method: 'PUT',
      body: JSON.stringify({ thumbs: 'up' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; data: { messageId: string; thumbs: string } }
    expect(body.ok).toBe(true)
    expect(body.data.messageId).toBe('msg-1')
    expect(body.data.thumbs).toBe('up')
    expect(feedbackByKey.get(feedbackKey('msg-1', 'u1'))?.thumbs).toBe('up')
  })

  test("flips 'up' -> 'down' via upsert — still exactly one row", async () => {
    seedSession('s1', ['u1'])
    seedMessage('msg-1', 's1')
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    await app.request('/api/chat-messages/msg-1/feedback', {
      method: 'PUT',
      body: JSON.stringify({ thumbs: 'up' }),
    })
    const res2 = await app.request('/api/chat-messages/msg-1/feedback', {
      method: 'PUT',
      body: JSON.stringify({ thumbs: 'down' }),
    })
    expect(res2.status).toBe(200)
    const body = (await res2.json()) as { data: { thumbs: string } }
    expect(body.data.thumbs).toBe('down')
    expect(feedbackByKey.size).toBe(1)
  })

  test('tunnel-authenticated callers skip the membership check', async () => {
    seedSession('s1', ['someone-else'])
    seedMessage('msg-x', 's1')
    const app = createApp({ isAuthenticated: true, userId: 'bridge-proxy', tunnelAuthenticated: true })
    const res = await app.request('/api/chat-messages/msg-x/feedback', {
      method: 'PUT',
      body: JSON.stringify({ thumbs: 'up' }),
    })
    expect(res.status).toBe(200)
  })
})

// =============================================================================
// DELETE /api/chat-messages/:id/feedback
// =============================================================================

describe('DELETE /api/chat-messages/:id/feedback', () => {
  test('401 when unauthenticated', async () => {
    const app = createApp(null)
    const res = await app.request('/api/chat-messages/msg-1/feedback', { method: 'DELETE' })
    expect(res.status).toBe(401)
  })

  test('404 when message id is unknown', async () => {
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-messages/ghost/feedback', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  test('403 when caller is not a workspace member', async () => {
    seedSession('s1', ['owner-user'])
    seedMessage('msg-1', 's1')
    const app = createApp({ isAuthenticated: true, userId: 'intruder' })
    const res = await app.request('/api/chat-messages/msg-1/feedback', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  test('removes an existing row', async () => {
    seedSession('s1', ['u1'])
    seedMessage('msg-1', 's1')
    feedbackByKey.set(feedbackKey('msg-1', 'u1'), {
      messageId: 'msg-1',
      userId: 'u1',
      thumbs: 'up',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-messages/msg-1/feedback', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(feedbackByKey.has(feedbackKey('msg-1', 'u1'))).toBe(false)
  })

  test('is a no-op (still 200) when no row exists — idempotent double-tap', async () => {
    seedSession('s1', ['u1'])
    seedMessage('msg-1', 's1')
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-messages/msg-1/feedback', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })
})

// =============================================================================
// GET /api/chat-sessions/:id/feedback
// =============================================================================

describe('GET /api/chat-sessions/:id/feedback', () => {
  test('401 when unauthenticated', async () => {
    const app = createApp(null)
    const res = await app.request('/api/chat-sessions/s1/feedback')
    expect(res.status).toBe(401)
  })

  test('404 when session id is unknown', async () => {
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-sessions/ghost/feedback')
    expect(res.status).toBe(404)
  })

  test('403 when caller is not a workspace member', async () => {
    seedSession('s1', ['owner-user'])
    const app = createApp({ isAuthenticated: true, userId: 'intruder' })
    const res = await app.request('/api/chat-sessions/s1/feedback')
    expect(res.status).toBe(403)
  })

  test("returns only the caller's own feedback, keyed by messageId", async () => {
    seedSession('s1', ['u1', 'u2'])
    seedMessage('msg-a', 's1')
    seedMessage('msg-b', 's1')
    seedMessage('msg-other-session', 's-other')
    seedSession('s-other', ['u1'])
    feedbackByKey.set(feedbackKey('msg-a', 'u1'), {
      messageId: 'msg-a',
      userId: 'u1',
      thumbs: 'up',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    feedbackByKey.set(feedbackKey('msg-b', 'u1'), {
      messageId: 'msg-b',
      userId: 'u1',
      thumbs: 'down',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    // A different user's feedback on the same message must NOT leak in.
    feedbackByKey.set(feedbackKey('msg-a', 'u2'), {
      messageId: 'msg-a',
      userId: 'u2',
      thumbs: 'down',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    // Feedback on a message in a DIFFERENT session must not leak in either.
    feedbackByKey.set(feedbackKey('msg-other-session', 'u1'), {
      messageId: 'msg-other-session',
      userId: 'u1',
      thumbs: 'up',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-sessions/s1/feedback')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; feedback: Record<string, string> }
    expect(body.ok).toBe(true)
    expect(body.feedback).toEqual({ 'msg-a': 'up', 'msg-b': 'down' })
  })

  test('tunnel-authenticated callers skip the membership check', async () => {
    seedSession('s1', ['someone-else'])
    const app = createApp({ isAuthenticated: true, userId: 'bridge-proxy', tunnelAuthenticated: true })
    const res = await app.request('/api/chat-sessions/s1/feedback')
    expect(res.status).toBe(200)
  })
})
