// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * POST /api/workspaces/:workspaceId/chat/compact (SHO-230)
 *
 * The dock's "Summarize now" called the *project* compact route for every
 * chat. A workspace-scoped chat's session lives on the workspace runtime, so
 * that request landed on a runtime that had never held it, took the "evicted"
 * branch and folded the entire ChatMessage history inline — the button spun
 * for minutes and the honest `queued` answer was never reachable.
 *
 * This route is the workspace half: same shared `compactChatSession`, but the
 * runtime fetch goes to the workspace runtime that owns the session.
 *
 *   bun test apps/api/src/routes/__tests__/workspace-chat-compact.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const store = {
  userId: 'user-1' as string | null,
  hasAccess: true,
  kind: 'personal' as 'personal' | 'team',
  resolvedUrl: null as null | { url: string; mode: string },
  fetchImpl: null as null | ((url: string, init?: RequestInit) => Promise<Response>),
  calls: [] as string[],
}

mock.module('../../services/workspace.service', () => ({
  getWorkspaceKind: async (_workspaceId: string) => store.kind,
  loadWorkspaceContext: async (_workspaceId: string, _userId: string) => ({
    hasAccess: store.hasAccess,
    kind: store.kind,
  }),
  normalizeWorkspaceKind: (k?: string) => (k === 'team' ? 'team' : 'personal'),
}))

mock.module('../../lib/resolve-workspace-runtime-url', () => {
  class WorkspaceRuntimeNotEnabledError extends Error {}
  return {
    WorkspaceRuntimeNotEnabledError,
    resolveWorkspaceRuntimeUrl: async (_workspaceId: string, _opts: any) => store.resolvedUrl,
  }
})

mock.module('../../lib/workspace-runtime-token', () => ({
  deriveWorkspaceRuntimeToken: (_workspaceId: string) => 'mock-workspace-runtime-token',
}))

mock.module('../../lib/project-user-context', () => ({
  setProjectUser: (_projectId: string, _userId: string) => {},
  getProjectUser: (_projectId: string) => 'test-user',
  getProjectOwnerUserId: async (_projectId: string) => 'test-user',
  getWorkspaceOwnerUserId: async (_workspaceId: string) => 'test-user',
}))

mock.module('../../lib/workspace-runtime-args', () => ({
  readWorkspaceSessionRuntimeArgs: async (_workspaceId: string, _sessionId: string) => ({
    attachedProjectIds: [],
    extra: {},
  }),
}))

class MockWorkspaceSessionError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

mock.module('../../services/workspace-session.service', () => ({
  attachProject: async () => ({ attachMode: 'readwrite' }),
  assertWorkspaceSessionInWorkspace: async () => {},
  assertWorkspaceSessionAccess: async () => {
    if (!store.hasAccess) throw new MockWorkspaceSessionError('workspace_access_denied')
  },
  detachProject: async () => true,
  getAttachedProjects: async () => [],
  createWorkspaceSession: async () => ({ id: 'sess-1' }),
  listWorkspaceSessions: async () => [],
  getOrCreateDefaultWorkspaceSession: async () => ({ id: 'sess-1' }),
  pinWorkspaceSessionToProject: async () => ({ pinned: false, changed: false }),
  unpinWorkspaceSession: async () => {},
  upgradeProjectSessionToWorkspace: async () => null,
  syncPinnedSessionAttachments: async () => {},
  WorkspaceSessionError: MockWorkspaceSessionError,
}))

/** What the DB fold returns when the runtime no longer holds the session. */
let dbFold: { summary: string; through: number; messagesBefore: number; messagesAfter: number } | null =
  null
const foldCalls: string[] = []
const compactionRows: any[] = []

// Spread the real module: the workspace-chat import graph pulls `Prisma` (and
// friends) out of it, and `mock.module` replaces the whole module, not just
// `prisma`.
const realPrismaModule = await import('../../lib/prisma')
mock.module('../../lib/prisma', () => ({
  ...realPrismaModule,
  prisma: {
    chatSession: { findUnique: async () => ({ id: 'sess-1' }) },
    chatMessage: {
      create: async (args: any) => {
        compactionRows.push(args.data)
        return { id: `row-${compactionRows.length}`, ...args.data }
      },
    },
  },
}))

mock.module('../../services/chat-history-seed.service', () => ({
  historySeedForTurn: async () => null,
  lastUserPromptText: () => '',
  summarizeSessionFromDb: async (chatSessionId: string) => {
    foldCalls.push(chatSessionId)
    return dbFold
  },
}))

const originalFetch = globalThis.fetch

const { workspaceChatRoutes } = await import('../workspace-chat')
const { resetCompactFoldsForTests } = await import('../../services/chat-compact.service')
const { Hono } = await import('hono')

function buildApp() {
  const app = new Hono()
  app.route(
    '/api',
    workspaceChatRoutes({
      resolveUserId: async () => store.userId,
      runtimeManager: {} as any,
    }),
  )
  return app
}

const COMPACT_URL = 'http://x/api/workspaces/ws-1/chat/compact'

function compactRequest(body: unknown = { chatSessionId: 'sess-1' }) {
  return new Request(COMPACT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Session-Id': 'sess-1' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/workspaces/:workspaceId/chat/compact', () => {
  beforeEach(() => {
    store.userId = 'user-1'
    store.hasAccess = true
    store.kind = 'personal'
    store.resolvedUrl = { url: 'http://pod.internal:8080', mode: 'pod' }
    store.fetchImpl = null
    store.calls = []
    dbFold = null
    foldCalls.length = 0
    compactionRows.length = 0
    resetCompactFoldsForTests()
    globalThis.fetch = ((url: any, init?: any) => {
      store.calls.push(String(url))
      if (store.fetchImpl) return store.fetchImpl(String(url), init)
      return originalFetch(url, init)
    }) as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('401s without auth', async () => {
    store.userId = null
    const res = await buildApp().fetch(compactRequest())
    expect(res.status).toBe(401)
  })

  test('400s without a chat session', async () => {
    const res = await buildApp().fetch(
      new Request(COMPACT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' } }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()) as any).toMatchObject({ compacted: false, reason: 'missing chatSessionId' })
  })

  test('compacts on the workspace runtime that owns the session', async () => {
    store.fetchImpl = async () =>
      Response.json({
        compacted: true,
        queued: false,
        tokensBefore: 192_000,
        tokensAfter: 21_000,
        messagesBefore: 240,
        messagesAfter: 12,
        summaryChars: 1200,
      })

    const res = await buildApp().fetch(compactRequest())
    const body: any = await res.json()

    expect(res.status).toBe(200)
    expect(body.compacted).toBe(true)
    expect(body.tokensBefore).toBe(192_000)
    // The whole point: the compact call reaches the *workspace* runtime, not a
    // project runtime that never held this session.
    expect(store.calls).toContain('http://pod.internal:8080/agent/sessions/sess-1/compact')
    expect(foldCalls).toEqual([])
    // The transcript row an idle session has no live turn to carry.
    expect(compactionRows.length).toBe(1)
    expect(JSON.stringify(compactionRows[0]?.parts)).toContain('data-context-summarized')
  })

  test('a live turn answers queued and is passed through', async () => {
    store.fetchImpl = async () =>
      Response.json({ compacted: false, queued: true, reason: 'turn in progress' })

    const res = await buildApp().fetch(compactRequest())
    const body: any = await res.json()

    expect(body.queued).toBe(true)
    expect(body.reason).toBe('turn in progress')
    expect(foldCalls).toEqual([])
  })

  test('an evicted session folds the stored messages instead of failing', async () => {
    store.fetchImpl = async () =>
      new Response(JSON.stringify({ compacted: false, queued: false, reason: 'session not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    dbFold = { summary: 'SUMMARY', through: 228, messagesBefore: 240, messagesAfter: 12 }

    const res = await buildApp().fetch(compactRequest())
    const body: any = await res.json()

    expect(res.status).toBe(200)
    expect(body.compacted).toBe(true)
    expect(body.source).toBe('db')
    expect(body.messagesAfter).toBe(12)
    expect(foldCalls).toEqual(['sess-1'])
  })

  test('reports a runtime error instead of a fake success', async () => {
    store.fetchImpl = async () =>
      new Response(JSON.stringify({ error: 'runtime exploded' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })

    const res = await buildApp().fetch(compactRequest())
    expect(res.status).toBe(500)
    expect((await res.json()) as any).toMatchObject({
      compacted: false,
      reason: 'runtime exploded',
    })
  })
})
