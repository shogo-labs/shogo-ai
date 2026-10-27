// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-230 QA acceptance — "Summarize now" reaches the runtime that OWNS the
 * session, not merely a runtime with the right *kind* of URL.
 *
 * The card's bug was a scope bug: a workspace chat asked a project runtime that
 * had never held the session, got a 404, and folded the entire ChatMessage
 * history inline. The dev's route test proves the workspace route hits the
 * workspace runtime. This file covers the two ways the same bug survives that
 * fix, which no existing test exercised:
 *
 *  AC1  A workspace chat **pinned to a project** does not live on the
 *       workspace-wide runtime — it lives on the anchor-keyed merged-root
 *       runtime (`ws:proj:<anchorId>`). `resolveWorkspaceRuntimeUrl` picks
 *       between them from `extra.anchorProjectId`, so a route that resolves
 *       the runtime but forgets to forward `extra` reaches the *other* pod,
 *       gets a 404, and falls into the same minutes-long DB fold. The resolver
 *       mock below therefore returns a DIFFERENT url for the anchor case: drop
 *       the extras and the fetch assertion fails, exactly as production would.
 *
 *  AC4  The detached fold persists the summary + divider row, and the
 *       per-session dedupe neither double-folds nor wedges the session forever
 *       (module-level state that is never cleared would answer `queued` to
 *       every later press — a permanent, silent "nothing happens").
 *
 *   bun test apps/api/src/routes/__tests__/qa-sho230-compact-scope.acceptance.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const ANCHOR_PROJECT_ID = 'proj-anchor'

const store = {
  userId: 'user-1' as string | null,
  hasAccess: true,
  kind: 'personal' as 'personal' | 'team',
  runtimeArgs: {
    attachedProjectIds: [] as string[],
    extra: {} as { anchorProjectId?: string; localFolders?: string[]; readonlyProjectIds?: string[] },
  },
  /** Every opts object the route handed the runtime resolver. */
  resolveOpts: [] as any[],
  /** Every url the route actually fetched. */
  fetchCalls: [] as { url: string; init?: RequestInit }[],
  fetchImpl: null as null | ((url: string) => Promise<Response>),
}

mock.module('../../services/workspace.service', () => ({
  getWorkspaceKind: async () => store.kind,
  loadWorkspaceContext: async () => ({ hasAccess: store.hasAccess, kind: store.kind }),
  normalizeWorkspaceKind: (k?: string) => (k === 'team' ? 'team' : 'personal'),
}))

mock.module('../../lib/resolve-workspace-runtime-url', () => {
  class WorkspaceRuntimeNotEnabledError extends Error {}
  return {
    WorkspaceRuntimeNotEnabledError,
    resolveWorkspaceRuntimeUrl: async (_workspaceId: string, opts: any) => {
      store.resolveOpts.push(opts)
      // Two different pods. A pinned chat's session only exists on the
      // anchor-keyed merged-root runtime; the workspace-wide one has never
      // heard of it (that 404 is the bug).
      return opts?.anchorProjectId
        ? { url: `http://anchor-${opts.anchorProjectId}.internal:8080`, mode: 'pod' }
        : { url: 'http://workspace-wide.internal:8080', mode: 'pod' }
    },
  }
})

mock.module('../../lib/workspace-runtime-token', () => ({
  deriveWorkspaceRuntimeToken: () => 'mock-workspace-runtime-token',
}))

mock.module('../../lib/project-user-context', () => ({
  setProjectUser: () => {},
  getProjectUser: () => 'test-user',
  getProjectOwnerUserId: async () => 'test-user',
  getWorkspaceOwnerUserId: async () => 'test-user',
}))

mock.module('../../lib/workspace-runtime-args', () => ({
  readWorkspaceSessionRuntimeArgs: async () => store.runtimeArgs,
}))

class MockWorkspaceSessionError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

mock.module('../../services/workspace-session.service', () => ({
  attachProject: async () => ({ attachMode: 'readwrite' }),
  assertWorkspaceSessionInWorkspace: async () => {},
  assertWorkspaceSessionAccess: async () => {},
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

let dbFold: { summary: string; through: number; messagesBefore: number; messagesAfter: number } | null =
  null
/** Delay before the DB fold settles — lets a second press arrive mid-fold. */
let foldDelayMs = 0
const foldCalls: string[] = []
const compactionRows: any[] = []

// Spread the real module: the workspace-chat import graph pulls `Prisma` (and
// friends) out of it, and `mock.module` replaces the whole module.
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
    if (foldDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, foldDelayMs))
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
    workspaceChatRoutes({ resolveUserId: async () => store.userId, runtimeManager: {} as any }),
  )
  return app
}

function compactRequest() {
  return new Request('http://x/api/workspaces/ws-1/chat/compact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Session-Id': 'sess-1' },
    body: JSON.stringify({ chatSessionId: 'sess-1' }),
  })
}

/** The runtime no longer holds the session — the branch that folds the DB. */
function evictedResponse() {
  return new Response(JSON.stringify({ compacted: false, queued: false, reason: 'session not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  store.userId = 'user-1'
  store.hasAccess = true
  store.kind = 'personal'
  store.runtimeArgs = { attachedProjectIds: [], extra: {} }
  store.resolveOpts = []
  store.fetchCalls = []
  store.fetchImpl = null
  dbFold = null
  foldDelayMs = 0
  foldCalls.length = 0
  compactionRows.length = 0
  resetCompactFoldsForTests()
  globalThis.fetch = ((url: any, init?: any) => {
    store.fetchCalls.push({ url: String(url), init })
    if (store.fetchImpl) return store.fetchImpl(String(url))
    return originalFetch(url, init)
  }) as any
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('SHO-230 AC1 — a pinned workspace chat compacts on the runtime that owns its session', () => {
  test('the anchor extras reach the resolver, so the fetch lands on the anchor runtime', async () => {
    store.runtimeArgs = {
      attachedProjectIds: [ANCHOR_PROJECT_ID],
      extra: { anchorProjectId: ANCHOR_PROJECT_ID, readonlyProjectIds: [] },
    }
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
    // Without `extra`, this would be `http://workspace-wide.internal:8080` —
    // a pod that never held the session, i.e. the 404 that started all this.
    expect(store.fetchCalls.map((c) => c.url)).toContain(
      `http://anchor-${ANCHOR_PROJECT_ID}.internal:8080/agent/sessions/sess-1/compact`,
    )
    expect(store.resolveOpts.at(-1)?.anchorProjectId).toBe(ANCHOR_PROJECT_ID)
    expect(foldCalls).toEqual([])
  })

  test('the compact call is a POST and carries no turn payload', async () => {
    store.fetchImpl = async () => Response.json({ compacted: false, queued: true, reason: 'busy' })

    await buildApp().fetch(compactRequest())

    const call = store.fetchCalls.find((c) => c.url.includes('/compact'))!
    expect(call.init?.method).toBe('POST')
    expect(String(call.init?.body)).toBe('{}')
  })

  test('a live turn on the anchor runtime answers 202 queued with its own reason', async () => {
    store.runtimeArgs = {
      attachedProjectIds: [ANCHOR_PROJECT_ID],
      extra: { anchorProjectId: ANCHOR_PROJECT_ID },
    }
    store.fetchImpl = async () =>
      new Response(
        JSON.stringify({ compacted: false, queued: true, reason: 'will summarize at the next step' }),
        { status: 202, headers: { 'Content-Type': 'application/json' } },
      )

    const res = await buildApp().fetch(compactRequest())

    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({
      compacted: false,
      queued: true,
      reason: 'will summarize at the next step',
    })
    // A live turn is the runtime's business; the API must not fold behind it.
    expect(foldCalls).toEqual([])
  })
})

describe('SHO-230 AC4 — the bounded fold persists, dedupes, and unwedges', () => {
  test('an evicted session writes the divider row the dock renders', async () => {
    store.fetchImpl = async () => evictedResponse()
    dbFold = { summary: 'SUMMARY', through: 228, messagesBefore: 240, messagesAfter: 12 }

    const res = await buildApp().fetch(compactRequest())
    const body: any = await res.json()

    expect(body).toMatchObject({ compacted: true, source: 'db', messagesAfter: 12 })
    expect(foldCalls).toEqual(['sess-1'])
    expect(compactionRows.length).toBe(1)
    const parts = JSON.parse(compactionRows[0].parts)
    expect(parts[0].type).toBe('data-context-summarized')
    expect(parts[0].data).toMatchObject({
      trigger: 'manual',
      messagesBefore: 240,
      messagesAfter: 12,
      summaryChars: 'SUMMARY'.length,
    })
  })

  test('a second press during the fold answers 202 without starting a second fold', async () => {
    store.fetchImpl = async () => evictedResponse()
    dbFold = { summary: 'SUMMARY', through: 228, messagesBefore: 240, messagesAfter: 12 }
    foldDelayMs = 40

    const app = buildApp()
    const first = app.fetch(compactRequest())
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = await app.fetch(compactRequest())
    const secondBody: any = await second.json()
    const firstBody: any = await (await first).json()

    expect(second.status).toBe(202)
    expect(secondBody).toMatchObject({ compacted: false, queued: true, status: 'summarizing' })
    expect(firstBody).toMatchObject({ compacted: true, source: 'db' })
    expect(foldCalls).toEqual(['sess-1'])
    expect(compactionRows.length).toBe(1)
  })

  test('a press after the fold finished folds again — the dedupe does not wedge the session', async () => {
    store.fetchImpl = async () => evictedResponse()
    dbFold = { summary: 'SUMMARY', through: 228, messagesBefore: 240, messagesAfter: 12 }

    const app = buildApp()
    const one: any = await (await app.fetch(compactRequest())).json()
    const two: any = await (await app.fetch(compactRequest())).json()

    expect(one).toMatchObject({ compacted: true, source: 'db' })
    expect(two).toMatchObject({ compacted: true, source: 'db' })
    expect(foldCalls).toEqual(['sess-1', 'sess-1'])
  })
})
