// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-402 — a typed turn posts one message, and both routes supply the history.
 *
 * The client stopped sending its loaded transcript (`outgoingChatMessages`), so
 * the contract these routes have to keep is: a body whose `messages` holds only
 * the turn being sent still reaches the runtime with `historySeed` attached, so
 * a cold or evicted runtime is not left with a single line.
 *
 * Entered through both real route handlers, because the client builds one body
 * for both and only the URL differs (`buildChatApiUrl`):
 *
 *   POST /api/projects/:projectId/chat
 *   POST /api/workspaces/:workspaceId/chat
 *
 * Run alone (bun mocks are process-global):
 *   bun test ./apps/api/src/__tests__/qa-sho402-one-message-turn.acceptance.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET ?? 'test-secret'
delete process.env.KUBERNETES_SERVICE_HOST

// ─── The stored conversation a cold runtime must get back ────────────────────

interface Row {
  id: string
  role: string
  content: string
  parts?: string | null
  createdAt: Date
}

const SESSION_ROW = {
  id: 'chat-1',
  inferredName: 'QA chat',
  contextSummary: null,
  contextSummaryThroughCount: 0,
  contextId: 'p-1',
  contextType: 'project',
}

let messageRows: Row[] = []

function seedRows(): Row[] {
  const base = Date.parse('2026-11-16T09:00:00.000Z')
  return [
    { id: 'm1', role: 'user', content: 'the parser keeps dropping the last line', createdAt: new Date(base) },
    { id: 'm2', role: 'assistant', content: 'I will check the splitter', createdAt: new Date(base + 1000) },
    {
      id: 'm3',
      role: 'user',
      content: '',
      parts: JSON.stringify([{ type: 'file', mediaType: 'image/png', name: 'trace.png' }]),
      createdAt: new Date(base + 2000),
    },
  ]
}

mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async () => ({ id: 'p-1', name: 'QA', workspaceId: 'w-1' }),
      update: async () => ({}),
    },
    member: { findFirst: async () => ({ id: 'member-1' }) },
    toolCallLog: { createMany: async () => ({ count: 0 }) },
    chatSession: {
      findUnique: async () => ({ ...SESSION_ROW }),
      updateMany: async () => ({ count: 0 }),
      update: async () => ({ ...SESSION_ROW }),
    },
    chatMessage: {
      findMany: async () => messageRows.slice().reverse(),
      count: async () => messageRows.length,
      create: async (args: any) => ({ id: 'created-1', ...args.data }),
    },
  },
}))

mock.module('../services/workspace.service', () => ({
  getWorkspaceKind: async () => 'team',
  loadWorkspaceContext: async () => ({ hasAccess: true, kind: 'team' }),
  normalizeWorkspaceKind: (k?: string) => (k === 'team' ? 'team' : 'personal'),
}))

class MockWorkspaceSessionError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

// The workspace route only accepts a session that belongs to that workspace; in
// this harness the session is the mocked one above, so it always does.
mock.module('../services/workspace-session.service', () => ({
  attachProject: async () => ({ attachMode: 'readwrite' }),
  assertWorkspaceSessionInWorkspace: async () => {},
  assertWorkspaceSessionAccess: async () => {},
  detachProject: async () => true,
  getAttachedProjects: async () => [],
  createWorkspaceSession: async () => ({ id: 'chat-1' }),
  listWorkspaceSessions: async () => [],
  getOrCreateDefaultWorkspaceSession: async () => ({ id: 'chat-1' }),
  pinWorkspaceSessionToProject: async () => ({ pinned: false, changed: false }),
  unpinWorkspaceSession: async () => {},
  upgradeProjectSessionToWorkspace: async () => null,
  syncPinnedSessionAttachments: async () => {},
  WorkspaceSessionError: MockWorkspaceSessionError,
}))

mock.module('../lib/resolve-workspace-runtime-url', () => {
  class WorkspaceRuntimeNotEnabledError extends Error {}
  return {
    WorkspaceRuntimeNotEnabledError,
    resolveWorkspaceRuntimeUrl: async () => ({ url: 'http://ws-runtime.local', mode: 'pod' }),
  }
})

mock.module('../lib/workspace-runtime-token', () => ({
  deriveWorkspaceRuntimeToken: () => 'mock-workspace-runtime-token',
}))

mock.module('../lib/project-user-context', () => ({
  setProjectUser: () => {},
  getProjectUser: () => 'test-user',
  getProjectOwnerUserId: async () => 'test-user',
  getWorkspaceOwnerUserId: async () => 'test-user',
}))

mock.module('../lib/proxy-billing-session', () => ({
  openSession: () => 'sess-qa',
  closeSession: async () => ({ billedUsd: 0 }),
  setQualitySignals: () => {},
  hasSession: () => false,
  hasActiveSession: () => false,
  accumulateUsage: () => {},
}))

mock.module('../lib/resolve-pod-url', () => ({
  resolveProjectPodUrl: async () => ({ url: 'http://runtime-qa.local' }),
}))

mock.module('../lib/warm-pool-self-heal', () => ({ evictIfPodMissingAuth: async () => false }))

mock.module('../lib/knative-project-manager', () => ({
  getKnativeProjectManager: () => ({
    getStatus: async () => ({ exists: true, ready: true, url: 'http://k8s', replicas: 1 }),
    waitForReady: async () => {},
  }),
}))

mock.module('../services/cost-analytics.service', () => ({
  recordAgentCostMetric: async () => {},
  getAgentCostBreakdown: async () => [],
  isCostPeriod: () => false,
  isBudgetPeriod: () => false,
  VALID_COST_PERIODS: ['7d', '30d', '90d', '1y'],
  VALID_BUDGET_PERIODS: ['daily', 'weekly', 'monthly'],
}))

// ─── Controllable runtime ────────────────────────────────────────────────────

const forwarded: Array<{ url: string; body: any }> = []
const originalFetch = globalThis.fetch

const { projectChatRoutes } = await import('../routes/project-chat')
const { workspaceChatRoutes } = await import('../routes/workspace-chat')

const runtimeManager: any = {
  status: () => ({ status: 'running', url: 'http://localhost:5200', port: 5200 }),
  start: async () => ({ status: 'running' }),
  stop: async () => {},
  restart: async () => ({ status: 'running', url: 'http://localhost:5200', port: 5200 }),
}

/** One app with both typed-turn routes, exactly as server.ts mounts them. */
function chatApp() {
  const app = new Hono()
  app.route('/api', projectChatRoutes({ runtimeManager }))
  app.route('/api', workspaceChatRoutes({ resolveUserId: async () => 'user-1', runtimeManager }))
  return app
}

/** The body the client sends now: the turn being sent, nothing before it. */
function oneMessageBody(text: string) {
  return {
    chatSessionId: 'chat-1',
    agentMode: 'auto',
    trigger: 'submit-message',
    messageId: 'msg-new',
    messages: [
      { id: 'msg-new', role: 'user', parts: [{ type: 'text', text }] },
    ],
  }
}

async function postTurn(url: string, text: string) {
  const res = await chatApp().request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Session-Id': 'chat-1' },
    body: JSON.stringify(oneMessageBody(text)),
  })
  // Drain the stream so the forward has happened before we inspect it.
  const bodyText = await res.text()
  return { status: res.status, text: bodyText }
}

beforeEach(() => {
  messageRows = seedRows()
  forwarded.length = 0
  const enc = new TextEncoder()
  ;(globalThis as any).fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input))
    let body: any = init?.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        /* leave as text */
      }
    }
    forwarded.push({ url, body })
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            enc.encode('data: {"type":"data-turn-complete","data":{"status":"completed"}}\n\n'),
          )
          controller.close()
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
  }
})

afterEach(() => {
  ;(globalThis as any).fetch = originalFetch
})

function forwardedTurn() {
  const turn = forwarded.find((entry) => entry.url.includes('/agent/chat'))
  expect(turn).toBeDefined()
  return turn!
}

describe('SHO-402 — a one-message turn still carries the history', () => {
  test('the project chat route forwards one message plus the seed', async () => {
    const res = await postTurn('/api/projects/p-1/chat', 'what did I ask you two messages ago?')

    expect(res.status, res.text).toBe(200)
    const turn = forwardedTurn()
    // What the client sent, unchanged: the turn, not the transcript.
    expect(turn.body.messages).toHaveLength(1)
    expect(turn.body.messages[0].role).toBe('user')
    // What the API adds so a cold runtime is not left with one line.
    expect(turn.body.historySeed).toBeTruthy()
    expect(turn.body.historySeed.messages.map((m: any) => m.text)).toEqual([
      'the parser keeps dropping the last line',
      'I will check the splitter',
      // A file-only message survives the seed as a note, not as a dropped row.
      '[attached: trace.png (image/png)]',
    ])
  })

  test('the workspace chat route forwards one message plus the seed', async () => {
    const res = await postTurn('/api/workspaces/ws-1/chat', 'what did I ask you two messages ago?')

    expect(res.status, res.text).toBe(200)
    const turn = forwardedTurn()
    expect(turn.body.messages).toHaveLength(1)
    expect(turn.body.messages[0].role).toBe('user')
    expect(turn.body.historySeed).toBeTruthy()
    expect(turn.body.historySeed.messages.length).toBeGreaterThan(0)
  })
})
