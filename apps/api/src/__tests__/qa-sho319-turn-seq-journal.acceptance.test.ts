// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-319 — the seq heartbeat stops costing a `chat_turn_frames` row, and the
 * write-ahead guarantee survives it.
 *
 * The unit tests hold the forwarder in isolation. This one enters through the
 * real relay (`POST /api/projects/:id/chat`) with an upstream shaped like the
 * runtime's own output — one chunk per frame, a `data-turn-seq` frame every few
 * content frames, and a long idle stretch of identical heartbeats (the 250 ms
 * tick that produced 2,400 rows for a ten-minute tool call) — and asserts the
 * three things the card is actually about:
 *
 *   1. zero loss: every frame the upstream wrote reaches the client, in order,
 *      byte-identical;
 *   2. no heartbeat rows: no `chatTurnFrame.create` carries a seq-only frame,
 *      and the idle stretch adds nothing at all;
 *   3. replay is unchanged: the journalled rows compact to exactly what the
 *      full stream compacts to, so a reconnect rebuilds the same message.
 *
 * Run alone (bun mocks are process-global):
 *   bun test src/__tests__/qa-sho319-turn-seq-journal.acceptance.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { compactSseFrames } from '../../../../packages/core/src/stream-compaction'

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET ?? 'test-secret'
delete process.env.KUBERNETES_SERVICE_HOST

// ─── The journal, recorded ───────────────────────────────────────────────────

interface FrameRow {
  sessionId: string
  turnId: string
  seq: number
  data: string
}

let frameRows: FrameRow[] = []

const SESSION_ROW = {
  id: 'chat-1',
  inferredName: 'QA chat',
  contextSummary: null,
  contextSummaryThroughCount: 0,
  contextId: 'p-1',
  contextType: 'project',
}

mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async () => ({ id: 'p-1', name: 'QA', workspaceId: 'w-1' }),
      update: async () => ({}),
    },
    member: { findFirst: async () => ({ id: 'member-1' }) },
    toolCallLog: { createMany: async () => ({ count: 0 }) },
    modelDefinition: { findMany: async () => [] },
    subscription: { findFirst: async () => null },
    chatTurnFrame: {
      create: async (args: any) => {
        frameRows.push({ ...args.data })
        return {}
      },
      findMany: async () => frameRows.slice().sort((a, b) => a.seq - b.seq).map((row) => ({ data: row.data })),
      count: async () => frameRows.length,
      deleteMany: async () => ({ count: 0 }),
    },
    chatSession: {
      findUnique: async () => ({ ...SESSION_ROW }),
      updateMany: async () => ({ count: 0 }),
      update: async () => ({ ...SESSION_ROW }),
    },
    chatMessage: {
      findUnique: async () => null,
      findMany: async () => [],
      count: async () => 0,
      create: async (args: any) => ({ id: 'created-1', ...args.data }),
    },
  },
}))

mock.module('../services/billing.service', () => ({
  SYSTEM_WORKSPACE_ID: 'system',
  checkUsageBalance: async () => ({ ok: true }),
  usageLimitErrorPayload: (reason?: string) => ({ code: reason ?? 'usage_limit_reached', message: 'limit' }),
  hasAdvancedModelAccess: async () => true,
  hasBalance: async () => true,
  hasPaidSubscription: async () => true,
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 99 }),
  resolveBillingWorkspaceId: async (workspaceId: string) => workspaceId,
  getEffectivePlanId: async () => 'free',
  canPublishSubdomain: async () => false,
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

// ─── The upstream, shaped like the runtime ───────────────────────────────────

const { projectChatRoutes } = await import('../routes/project-chat')

const runtimeManager: any = {
  status: () => ({ status: 'running', url: 'http://localhost:5200', port: 5200 }),
  start: async () => ({ status: 'running' }),
  stop: async () => {},
  restart: async () => ({ status: 'running', url: 'http://localhost:5200', port: 5200 }),
}

function chatApp() {
  const app = new Hono()
  app.route('/api', projectChatRoutes({ runtimeManager }))
  return app
}

const sse = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`

const TURN_ID = 'turn_sho319'

/**
 * A turn as the runtime writes it: one chunk per frame, a seq heartbeat every
 * few content frames, then `idleHeartbeats` frames with the seq unchanged —
 * the 250 ms tick during a long tool call, which is the regression.
 */
function runtimeTurn({ contentFrames, idleHeartbeats }: { contentFrames: number; idleHeartbeats: number }) {
  const frames: string[] = []
  let seq = 0
  const push = (event: Record<string, unknown>) => {
    frames.push(sse(event))
    seq++
  }
  const heartbeat = () => frames.push(sse({ type: 'data-turn-seq', data: { turnId: TURN_ID, seq }, transient: true }))

  push({ type: 'data-turn-start', data: { turnId: TURN_ID, startedAt: Date.now() } })
  push({ type: 'start-step' })
  push({ type: 'text-start', id: 't1' })
  for (let i = 0; i < contentFrames; i++) {
    push({ type: 'text-delta', id: 't1', delta: `w${i} ` })
    if (i % 5 === 4) heartbeat()
  }
  // The idle stretch: the seq does not move, so every one of these is a frame
  // the old tick wrote and the journal stored.
  for (let i = 0; i < idleHeartbeats; i++) heartbeat()
  push({ type: 'text-end', id: 't1' })
  push({ type: 'finish-step' })
  push({ type: 'finish' })
  return frames
}

const originalFetch = globalThis.fetch

function serveUpstream(frames: string[]) {
  const enc = new TextEncoder()
  ;(globalThis as any).fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          // One enqueue per frame: the runtime flushes each `writer.write`.
          for (const frame of frames) controller.enqueue(enc.encode(frame))
          controller.close()
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
}

async function postTurn() {
  const res = await chatApp().request('/api/projects/p-1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Session-Id': 'chat-1' },
    body: JSON.stringify({
      chatSessionId: 'chat-1',
      agentMode: 'auto',
      trigger: 'submit-message',
      messageId: 'msg-new',
      messages: [{ id: 'msg-new', role: 'user', parts: [{ type: 'text', text: 'go' }] }],
    }),
  })
  const text = await res.text()
  return { status: res.status, text }
}

/** Every complete SSE event in a body, in order. */
function events(body: string): string[] {
  const parts = body.split('\n\n')
  parts.pop()
  return parts.map((part) => `${part}\n\n`)
}

const isSeqOnly = (event: string) => {
  if (!event.startsWith('data: ')) return false
  try {
    return JSON.parse(event.slice(6))?.type === 'data-turn-seq'
  } catch {
    return false
  }
}

beforeEach(() => {
  frameRows = []
})

afterEach(() => {
  ;(globalThis as any).fetch = originalFetch
})

describe('SHO-319 — the seq heartbeat costs no journal row', () => {
  test('every frame reaches the client, and no heartbeat is journalled', async () => {
    const frames = runtimeTurn({ contentFrames: 40, idleHeartbeats: 20 })
    serveUpstream(frames)

    const res = await postTurn()
    expect(res.status, res.text).toBe(200)

    // 1. Zero loss: the client got the stream byte for byte, in order.
    expect(res.text).toBe(frames.join(''))

    // 2. No heartbeat row. The idle stretch alone is 20 frames that used to be
    //    20 inserts; none of them may appear in the journal.
    const journalled = frameRows.map((row) => row.data).join('')
    const journalledEvents = events(journalled)
    expect(journalledEvents.filter(isSeqOnly)).toEqual([])

    // The content is all there, byte for byte, in order.
    const contentEvents = events(frames.join('')).filter((event) => !isSeqOnly(event))
    expect(journalledEvents).toEqual(contentEvents)

    // 3. Replay is unchanged: the journal compacts to exactly what the full
    //    stream compacts to, so a reconnect rebuilds the same message.
    const fromJournal = new TextDecoder().decode(
      compactSseFrames(frameRows.map((row) => new TextEncoder().encode(row.data))),
    )
    const fromStream = new TextDecoder().decode(
      compactSseFrames(frames.map((frame) => new TextEncoder().encode(frame))),
    )
    expect(fromJournal).toBe(fromStream)
  })

  test('a burst of content chunks is coalesced into far fewer rows', async () => {
    const contentFrames = 20
    const frames = runtimeTurn({ contentFrames, idleHeartbeats: 0 })
    serveUpstream(frames)

    const res = await postTurn()
    expect(res.status, res.text).toBe(200)
    expect(res.text).toBe(frames.join(''))

    // The upstream enqueues every chunk before the relay reads any of them, so
    // they land inside one batch window. One row per delta would be 20.
    expect(frameRows.length).toBeLessThanOrEqual(2)
    expect(frameRows.map((row) => row.data).join('')).toBe(
      events(frames.join('')).filter((event) => !isSeqOnly(event)).join(''),
    )
  })

  test('a turn with no content but 30 heartbeats writes one row, holding no heartbeat', async () => {
    const frames = runtimeTurn({ contentFrames: 0, idleHeartbeats: 30 })
    serveUpstream(frames)

    const res = await postTurn()
    expect(res.status, res.text).toBe(200)
    expect(res.text).toBe(frames.join(''))

    // The turn's structural frames are content and are journalled; the 30
    // heartbeats are not, and they all coalesce into that one row.
    expect(frameRows).toHaveLength(1)
    expect(events(frameRows[0].data).filter(isSeqOnly)).toEqual([])
  })
})
