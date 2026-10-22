// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-137 round 3 — QA acceptance for R1–R5 (AC9–AC13).
 *
 * Every case enters through the surface a user or the runtime actually hits:
 *
 *   R5 (AC13)  POST /api/projects/:id/chat/compact on an evicted session
 *              — the dock's "Summarize now" through the real route.
 *   R4 (AC12)  POST /api/projects/:id/chat (typed turn) must carry `historySeed`
 *              to the runtime, and the runtime's compaction must reach the DB
 *              through POST /api/internal/chat-sessions/:id/context-summary.
 *   R1 (AC9)   no gap: at every reuse distance 0..19, every message behind the
 *              watermark is folded exactly once, and every message after it is
 *              carried verbatim.
 *   R1b        the watermark may never claim more messages than the summarizer
 *              was actually shown (the invariant, at its weakest).
 *
 * Run alone (bun mocks are process-global):
 *   bun test ./apps/api/src/__tests__/qa-sho137-round3.acceptance.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Hono } from 'hono'

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET ?? 'test-secret'
delete process.env.KUBERNETES_SERVICE_HOST

// ─── Controllable DB ─────────────────────────────────────────────────────────

interface Row {
  id: string
  role: string
  content: string
  createdAt: Date
}

let sessionRow: any = null
let messageRows: Row[] = []
const sessionUpdates: Array<{ id: string; data: any }> = []
const createdMessages: any[] = []

function resetDb() {
  sessionUpdates.length = 0
  createdMessages.length = 0
  sessionRow = {
    id: 'chat-1',
    inferredName: 'QA chat',
    contextSummary: null,
    contextSummaryThroughCount: 0,
    contextId: 'p-1',
    contextType: 'project',
  }
  messageRows = []
}

/** `n` stored turns, alternating user/assistant, oldest first. */
function seedMessages(n: number, tag = 'msg'): Row[] {
  const base = Date.parse('2026-10-21T10:00:00.000Z')
  return Array.from({ length: n }, (_, i) => ({
    id: `${tag}-${i + 1}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `${tag} ${i + 1}`,
    createdAt: new Date(base + i * 1000),
  }))
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
      findUnique: async () => (sessionRow ? { ...sessionRow } : null),
      updateMany: async () => ({ count: 0 }),
      update: async (args: any) => {
        sessionUpdates.push({ id: args.where.id, data: args.data })
        if (sessionRow && args.where.id === sessionRow.id) Object.assign(sessionRow, args.data)
        return { ...sessionRow }
      },
    },
    chatMessage: {
      findMany: async (args: any) => {
        const ordered = messageRows
          .slice()
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        const rows = args?.orderBy?.createdAt === 'desc' ? ordered.slice().reverse() : ordered
        return (args?.take ? rows.slice(0, args.take) : rows).map((r) => ({ ...r }))
      },
      count: async (args: any) => {
        const lt = args?.where?.createdAt?.lt
        if (!(lt instanceof Date)) return messageRows.length
        return messageRows.filter((r) => r.createdAt.getTime() < lt.getTime()).length
      },
      create: async (args: any) => {
        createdMessages.push(args.data)
        return { id: `created-${createdMessages.length}`, ...args.data }
      },
    },
  },
}))

// The rest of project-chat.ts's import graph (same set project-chat-gaps.test.ts uses).
mock.module('../services/cost-analytics.service', () => ({
  recordAgentCostMetric: async () => {},
  getAgentCostBreakdown: async () => [],
  isCostPeriod: () => false,
  isBudgetPeriod: () => false,
  VALID_COST_PERIODS: ['7d', '30d', '90d', '1y'],
  VALID_BUDGET_PERIODS: ['daily', 'weekly', 'monthly'],
}))

mock.module('../services/billing.service', () => ({
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 99 }),
  hasBalance: async () => true,
  checkUsageBalance: async () => ({ ok: true }),
  usageLimitErrorPayload: (reason?: string) => ({ code: reason ?? 'usage_limit_reached', message: 'limit' }),
  hasAdvancedModelAccess: async () => true,
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
mock.module('../lib/project-user-context', () => ({
  setProjectUser: () => {},
  getProjectUser: () => null,
}))
mock.module('../lib/warm-pool-self-heal', () => ({ evictIfPodMissingAuth: async () => false }))
mock.module('../lib/knative-project-manager', () => ({
  getKnativeProjectManager: () => ({
    getStatus: async () => ({ exists: true, ready: true, url: 'http://k8s', replicas: 1 }),
    waitForReady: async () => {},
  }),
}))

// ─── Controllable runtime ───────────────────────────────────────────────────

type FetchFn = (input: any, init?: RequestInit) => Promise<Response>

const forwarded: Array<{ url: string; body: any }> = []
let runtimeCompactResponse: () => Promise<Response> = async () =>
  new Response(JSON.stringify({ compacted: false, queued: false, reason: 'session not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  })

const originalFetch = globalThis.fetch
const originalWorkspacesDir = process.env.WORKSPACES_DIR
process.env.WORKSPACES_DIR = process.env.WORKSPACES_DIR ?? '/tmp/shogo-qa-sho137'

const { projectChatRoutes } = await import('../routes/project-chat')
const { runtimeInternalRoutes } = await import('../routes/internal-runtime-routes')
const { ensureDurableSummary, setChatContextSummarizer, summarizeSessionFromDb } = await import(
  '../services/chat-history-seed.service'
)

const baseRuntimeManager: any = {
  status: () => ({ status: 'running', url: 'http://localhost:5200', port: 5200 }),
  start: async () => ({ status: 'running' }),
  stop: async () => {},
  restart: async () => ({ status: 'running', url: 'http://localhost:5200', port: 5200 }),
}

function chatApp() {
  const app = new Hono()
  app.route('/api', projectChatRoutes({ runtimeManager: baseRuntimeManager }))
  return app
}

function internalApp() {
  const app = runtimeInternalRoutes({
    authenticate: async () => ({ kind: 'sa' as const }),
    saveAgentAvatar: async () => {},
    metalWorkspaceMember: async () => null,
    loadProjectLifecycle: async () => null,
    loadAgentCall: async () => null,
    loadGitHub: async () => null,
    resolveSharedFileTarget: async () => null,
  } as any)
  const mounted = new Hono()
  mounted.route('/api/internal', app)
  return mounted
}

beforeEach(() => {
  resetDb()
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
    if (url.includes('/compact')) return runtimeCompactResponse()
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
  setChatContextSummarizer(null)
  if (originalWorkspacesDir === undefined) delete process.env.WORKSPACES_DIR
  else process.env.WORKSPACES_DIR = originalWorkspacesDir
})

// ─── R5 / AC13 — "Summarize now" on an evicted session ───────────────────────

describe('AC13 — Summarize now on a session the runtime no longer holds', () => {
  test('a 404 unknown-session from the runtime summarizes the DB rows and stores the block', async () => {
    sessionRow = { ...sessionRow, inferredName: 'Overnight chat' }
    messageRows = seedMessages(40)
    // Exactly what packages/agent-runtime/src/server.ts answers for
    // compactSession().status === 'unknown-session'.
    runtimeCompactResponse = async () =>
      new Response(JSON.stringify({ compacted: false, queued: false, reason: 'session not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    setChatContextSummarizer(async ({ messages }) => `SUMMARY(${messages.length})`)

    const res = await chatApp().request('/api/projects/p-1/chat/compact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSessionId: 'chat-1' }),
    })
    const body: any = await res.json()

    expect(res.status).toBe(200)
    expect(body.compacted).toBe(true)
    expect(body.source).toBe('db')

    const summaryWrite = sessionUpdates.find((u) => typeof u.data.contextSummary === 'string')
    expect(summaryWrite?.data.contextSummary).toContain('SUMMARY(')
    expect(summaryWrite?.data.contextSummaryThroughCount).toBeGreaterThan(0)
  })

  test('a live runtime that really compacts still persists the transcript row', async () => {
    messageRows = seedMessages(20)
    runtimeCompactResponse = async () =>
      new Response(
        JSON.stringify({
          compacted: true,
          queued: false,
          tokensBefore: 12000,
          tokensAfter: 3000,
          messagesBefore: 20,
          messagesAfter: 8,
          summaryChars: 900,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )

    const res = await chatApp().request('/api/projects/p-1/chat/compact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSessionId: 'chat-1' }),
    })
    expect(res.status).toBe(200)
    expect(createdMessages.length).toBe(1)
    expect(JSON.stringify(createdMessages[0]?.parts ?? '')).toContain('data-context-summarized')
  })
})

// ─── R4 / AC12 — the seed on a typed turn, and the write-back route ──────────

describe('AC12 — the durable summary reaches the runtime and comes back', () => {
  test('a typed turn forwards historySeed (summary + tail) to the runtime', async () => {
    messageRows = seedMessages(30)
    sessionRow = { ...sessionRow, contextSummary: 'DURABLE-SUMMARY', contextSummaryThroughCount: 5 }

    const res = await chatApp().request('/api/projects/p-1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Chat-Session-Id': 'chat-1' },
      body: JSON.stringify({
        chatSessionId: 'chat-1',
        messages: [{ role: 'user', content: 'what were we doing?' }],
      }),
    })
    expect(res.status).toBe(200)

    const turn = forwarded.find((f) => f.url.includes('/agent/chat'))
    expect(turn).toBeTruthy()
    expect(turn?.body?.historySeed).toBeTruthy()
    expect(turn?.body?.historySeed.summary).toContain('DURABLE-SUMMARY')
    expect(turn?.body?.historySeed.messages.length).toBeGreaterThan(0)
    // Oldest-first tail, ending with the most recent stored turn.
    const texts = turn?.body?.historySeed.messages.map((m: any) => m.text)
    expect(texts[texts.length - 1]).toContain('msg 30')
  })

  test('the runtime compaction write-back route updates the durable column', async () => {
    const res = await internalApp().request('/api/internal/chat-sessions/chat-1/context-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-runtime-token': 'sa-stub' },
      body: JSON.stringify({ summary: 'RUNTIME-COMPACTED' }),
    })
    expect(res.status).toBe(200)
    const write = sessionUpdates.find((u) => u.data.contextSummary === 'RUNTIME-COMPACTED')
    expect(write).toBeTruthy()
    // The watermark belongs to ensureDurableSummary: it counts ChatMessage rows.
    expect(write?.data.contextSummaryThroughCount).toBeUndefined()
  })

  test('an empty summary is rejected rather than wiping the stored block', async () => {
    const res = await internalApp().request('/api/internal/chat-sessions/chat-1/context-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-runtime-token': 'sa-stub' },
      body: JSON.stringify({ summary: '   ' }),
    })
    expect(res.status).toBe(400)
    expect(sessionUpdates.length).toBe(0)
  })
})

// ─── R1 / AC9 — no gap, at every reuse distance ─────────────────────────────

describe('AC9 — the summary and the verbatim tail always meet', () => {
  test('every elision distance 0..19 folds exactly the newly elided messages', async () => {
    const covered = seedMessages(60).map((r) => ({
      role: r.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      text: r.content,
    }))

    for (let distance = 0; distance <= 19; distance++) {
      const existingThrough = 20
      const through = existingThrough + distance + 1
      const seen: string[] = []
      setChatContextSummarizer(async ({ messages }) => {
        seen.push(...messages.map((m) => m.text))
        return `S${through}`
      })
      const result = await ensureDurableSummary({
        sessionId: 'chat-1',
        label: 'QA chat',
        existing: `S${existingThrough}`,
        existingThrough,
        through,
        covered,
      })
      // No message may be skipped: everything from the old watermark up to the
      // new one has to be folded on this turn.
      const expected = covered.slice(existingThrough, through).map((m) => m.text)
      expect({ distance, seen }).toEqual({ distance, seen: expected })
      expect(result.through).toBe(through)
    }
  })

  test('"Summarize now" folds everything it claims to cover', async () => {
    // The R5 path, called directly: a long chat with no summary yet, idle long
    // enough that the runtime dropped the session.
    messageRows = seedMessages(400)
    const seen = new Set<string>()
    setChatContextSummarizer(async ({ messages }) => {
      for (const m of messages) seen.add(m.text.replace(/\s+/g, ' ').trim())
      return 'FOLDED'
    })

    const result = await summarizeSessionFromDb('chat-1')
    expect(result).toBeTruthy()
    const claimed = messageRows
      .slice(0, result!.through)
      .map((r) => r.content)
      .filter((text) => !seen.has(text))
    expect({ through: result!.through, unfolded: claimed.length }).toEqual({
      through: result!.through,
      unfolded: 0,
    })
  })

  test('the watermark never claims more messages than the summarizer was shown', async () => {
    // A long chat folded in one turn — the shape of a cold seed on an old chat,
    // and of "Summarize now" itself.
    const covered = seedMessages(400).map((r) => ({
      role: r.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      text: r.content,
    }))
    const seen = new Set<string>()
    setChatContextSummarizer(async ({ messages }) => {
      for (const m of messages) seen.add(m.text)
      return 'FOLDED'
    })

    const result = await ensureDurableSummary({
      sessionId: 'chat-1',
      label: 'QA chat',
      existing: null,
      existingThrough: 0,
      through: 400,
      covered,
    })

    const unfolded = covered.slice(0, result.through).filter((m) => !seen.has(m.text))
    expect({ through: result.through, unfolded: unfolded.length }).toEqual({
      through: result.through,
      unfolded: 0,
    })
  })
})
