// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * POST /projects/:projectId/chat — chat-session id single source of truth.
 *
 * Pins the contract that the chat route resolves `chatSessionId` ONCE per
 * request, with the `X-Chat-Session-Id` header winning over the JSON
 * body, and that the same resolved value is used for BOTH:
 *
 *   - opening / closing the proxy billing session
 *   - persisting the assistant `ChatMessage` row via trackUsageFromStream
 *
 * Regression history: the staging incident on session
 * `8af6be85-e4c0-43aa-994a-b9ea7ab45ca0` was caused by these two paths
 * reading from different sources. The route handler used
 * `header || body.chatSessionId`, but `trackUsageFromStream` reached
 * straight into `requestBody.chatSessionId`. When the body lacked the
 * field — or carried a stale value — billing went to the header session
 * while persistence either dropped the row entirely or saved it under
 * the wrong session. The user observed "AI never replied" even though
 * the runtime had streamed a full turn.
 *
 * Required behavior:
 *   - Header set, body missing  → billing AND persistence use the header.
 *   - Header and body disagree  → billing AND persistence use the header.
 *   - Both agree                → no change in behavior (control).
 *
 *   bun test apps/api/src/__tests__/project-chat-session-id-split.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { Hono } from 'hono'

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET ?? 'test-secret'
delete process.env.KUBERNETES_SERVICE_HOST
delete process.env.SHOGO_VM_ISOLATION
delete process.env.SHOGO_CLOUD_SYNC

// ---------------------------------------------------------------------------
// Mocks — capture prisma + billing calls so we can assert who got attributed
// what. Shapes mirror `project-chat.expanded.test.ts` so bun's module cache
// stays consistent across both files.
// ---------------------------------------------------------------------------

let chatSessionFixture: { id: string } | null = { id: 'session-typed' }

const prismaCalls = {
  chatMessageCreate: [] as any[],
  toolCallLogCreateMany: [] as any[],
  projectUpdate: [] as any[],
  chatSessionFindUnique: [] as any[],
}


// @shogo/model-catalog re-exports from @shogo-ai/sdk/model-catalog which has no
// built dist on this branch — stub before the dynamic import chain loads it.
mock.module('@shogo/model-catalog', () => ({
  getModelTier: (_modelId: string) => 'standard',
  resolveModelId: (mode: string) => mode || 'claude-haiku-4-5',
  MODEL_CATALOG: {},
  getModelEntry: (_id: string) => null,
  MODEL_DOLLAR_COSTS: {} as Record<string, any>,
  calculateDollarCost: () => 0,
  getModelBillingModel: (id: string) => id,
  resolveAgentModeDefault: (mode: string) => mode,
}))

mock.module('../services/cost-analytics.service', () => ({
  recordAgentCostMetric: async () => {},
  getAgentCostBreakdown: async () => [],
  getCostRecommendations: async () => [],
  getBudgetAlerts: async () => [],
  checkBudgetAlerts: async () => [],
  getActiveThrottleModel: async () => null,
  getCostTrends: async () => [],
  deriveActiveThrottleModel: () => null,
  isCostPeriod: () => false,
  isBudgetPeriod: () => false,
  VALID_COST_PERIODS: ['7d', '30d', '90d', '1y'],
  VALID_BUDGET_PERIODS: ['daily', 'weekly', 'monthly'],
}))

mock.module('../lib/prisma', () => ({
  // `mock.module` is process-global in bun — if a sibling test file
  // imports `InstanceKind` from this module after we've mocked it, the
  // import resolves against our mock object. Forward the real enum
  // (a string-literal union shipped as runtime values) so any consumer
  // of `prisma.ts` still works.
  InstanceKind: { desktop: 'desktop', cli_worker: 'cli_worker' },
  prisma: {
    project: {
      findUnique: async () => ({ id: 'p-split', name: 'Split', workspaceId: 'ws-split' }),
      update: async (args: any) => {
        prismaCalls.projectUpdate.push(args)
        return {}
      },
    },
    chatMessage: {
      create: async (args: any) => {
        prismaCalls.chatMessageCreate.push(args)
        return { id: 'msg-x', ...args.data }
      },
    },
    chatSession: {
      // The route persists when this returns a row. We return whichever
      // session id is looked up, so the assertion can target who got
      // saved (rather than testing "session not found" by accident).
      findUnique: async (args: any) => {
        prismaCalls.chatSessionFindUnique.push(args)
        if (!chatSessionFixture) return null
        return { id: args?.where?.id ?? chatSessionFixture.id }
      },
    },
    toolCallLog: {
      createMany: async (args: any) => {
        prismaCalls.toolCallLogCreateMany.push(args)
        return { count: args?.data?.length ?? 0 }
      },
    },
    member: { findFirst: async () => ({ id: 'member-1' }) },
  },
}))

mock.module('../services/billing.service', () => ({
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 99 }),
  hasBalance: async () => true,
  hasAdvancedModelAccess: async () => true,
}))

mock.module('../services/git.service', () => ({
  isGitAvailable: () => false,
}))

mock.module('../services/checkpoint.service', () => ({
  createCheckpoint: async () => ({ id: 'ck-1' }),
  createAutoCheckpoint: async () => ({ id: 'ck-1' }),
}))

// Billing session — we record open/close calls so we can read back which
// (project, chatSessionId) the route credited tokens to.
const sessionCalls: Array<{ op: 'open' | 'close'; projectId: string; chatSessionId: string | null | undefined }> = []
mock.module('../lib/proxy-billing-session', () => ({
  openSession: (projectId: string, _ws: string, _user: string, chatSessionId?: string | null) => {
    sessionCalls.push({ op: 'open', projectId, chatSessionId: chatSessionId ?? null })
    return 'sess-1'
  },
  closeSession: async (projectId: string, opts?: { chatSessionId?: string | null }) => {
    sessionCalls.push({ op: 'close', projectId, chatSessionId: opts?.chatSessionId ?? null })
    return { billedUsd: 0 }
  },
  setQualitySignals: () => false,
  hasSession: () => false,
  accumulateUsage: () => {},
}))

mock.module('../lib/resolve-pod-url', () => ({
  resolveProjectPodUrl: async () => ({ url: 'http://runtime-p-split.local' }),
}))

mock.module('../lib/runtime-token', () => ({
  deriveRuntimeToken: () => 'tok-1',
}))

mock.module('../lib/project-user-context', () => ({
  setProjectUser: () => {},
  getProjectUser: () => null,
}))

mock.module('../lib/warm-pool-self-heal', () => ({
  evictIfPodMissingAuth: async () => false,
  evictOnSingleMissingAuth: async () => false,
  RUNTIME_AUTH_MISSING_SENTINEL: 'RUNTIME_AUTH_SECRET',
}))

mock.module('../lib/knative-project-manager', () => ({
  getKnativeProjectManager: () => ({
    getStatus: async () => ({ exists: true, ready: true, url: 'http://knative-svc', replicas: 2 }),
    waitForReady: async () => {},
  }),
}))

mock.module('fs', () => ({ existsSync: () => true }))

// Stub the runtime fetch — the route POST forwards here.
type FetchResponder = () => Response | Promise<Response>
let fetchResponses: FetchResponder[] = []
const originalFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (_input: any, _init?: RequestInit) => {
    const next = fetchResponses.length > 1 ? fetchResponses.shift()! : fetchResponses[0]
    if (!next) throw new Error('No fetch responder configured')
    return next() as any
  }) as any
})
afterAll(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  chatSessionFixture = { id: 'session-typed' }
  prismaCalls.chatMessageCreate.length = 0
  prismaCalls.toolCallLogCreateMany.length = 0
  prismaCalls.projectUpdate.length = 0
  prismaCalls.chatSessionFindUnique.length = 0
  sessionCalls.length = 0
  fetchResponses = []
})

// Imports must come AFTER mock.module so the route picks up our fakes.
const { projectChatRoutes } = await import('../routes/project-chat')

function buildApp() {
  const app = new Hono()
  app.route('/api', projectChatRoutes({
    runtimeManager: {
      status: () => ({ status: 'running', url: 'http://localhost:5200', port: 5200, agentPort: 6200 }),
      start: async () => ({ status: 'running' }),
      stop: async () => {},
      restart: async () => ({ status: 'running' }),
    } as any,
  }))
  return app
}

// Minimal SSE turn the runtime would emit: one text delta + terminal frame.
const ASSISTANT_SSE =
  'data: {"type":"text-delta","delta":"assistant reply"}\n' +
  'data: {"type":"data-turn-complete","data":{"status":"completed"}}\n'

function runtimeStream(): Response {
  return new Response(ASSISTANT_SSE, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

// ---------------------------------------------------------------------------
// Control case — header and body agree → billing and persistence agree.
// ---------------------------------------------------------------------------

describe('POST /chat — control: header and body chatSessionId agree', () => {
  test('billing session and assistant persistence target the same chat session', async () => {
    fetchResponses = [runtimeStream]
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-split/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Chat-Session-Id': 'session-typed',
      },
      body: JSON.stringify({ chatSessionId: 'session-typed' }),
    }))
    expect(res.status).toBe(200)
    await res.text() // drain so trackUsageFromStream finishes

    const open = sessionCalls.find((c) => c.op === 'open')
    expect(open?.chatSessionId).toBe('session-typed')

    // Wait a microtask tick for the fire-and-forget trackUsageFromStream.
    await new Promise((r) => setTimeout(r, 50))

    expect(prismaCalls.chatMessageCreate.length).toBe(1)
    expect(prismaCalls.chatMessageCreate[0].data.sessionId).toBe('session-typed')
    expect(prismaCalls.chatMessageCreate[0].data.role).toBe('assistant')
    expect(prismaCalls.chatMessageCreate[0].data.content).toBe('assistant reply')
  })
})

// ---------------------------------------------------------------------------
// Bug 1a — Header set, body missing.
//
// This is the staging-incident pattern: the auto-resuming-fetch wrapper
// (and the transport header thunk) put `X-Chat-Session-Id` on every
// chat POST, so billing routes correctly to the typed panel. But if the
// JSON body lacks `chatSessionId` (e.g. a stale closure on the body
// extras, or the frontend forgets to include it), `trackUsageFromStream`
// has nothing to persist under and the assistant row is silently
// dropped.
// ---------------------------------------------------------------------------

describe('POST /chat — header carries chatSessionId, body does not', () => {
  test('header is the single source of truth: billing AND persistence both use it', async () => {
    fetchResponses = [runtimeStream]
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-split/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Chat-Session-Id': 'session-typed',
      },
      // Body omits chatSessionId — the header alone should drive routing.
      body: JSON.stringify({}),
    }))
    expect(res.status).toBe(200)
    await res.text()
    await new Promise((r) => setTimeout(r, 50))

    // openSession + closeSession both target the header session, so
    // the billing-session bucket opens and closes cleanly (no leak).
    const opens = sessionCalls.filter((c) => c.op === 'open')
    const closes = sessionCalls.filter((c) => c.op === 'close')
    expect(opens.length).toBe(1)
    expect(opens[0].chatSessionId).toBe('session-typed')
    expect(closes.some((c) => c.chatSessionId === 'session-typed')).toBe(true)

    // Persistence also keys off the resolved (header) chatSessionId, so
    // the assistant message lands where the user's panel is reading from.
    expect(prismaCalls.chatMessageCreate.length).toBe(1)
    expect(prismaCalls.chatMessageCreate[0].data.sessionId).toBe('session-typed')
    expect(prismaCalls.chatMessageCreate[0].data.content).toBe('assistant reply')
  })
})

// ---------------------------------------------------------------------------
// Bug 1b — Header and body disagree.
//
// Two panels open on the same project, each with its own currentSessionId.
// A render-timing bug (or stale closure on bodyExtra) sends a request
// whose header says panel-A but whose body says panel-B. Billing credits
// panel-A; the assistant reply lands in panel-B's history. Panel-A's
// user sees their own message but no reply — meanwhile panel-B sees a
// random assistant message they didn't ask for.
// ---------------------------------------------------------------------------

describe('POST /chat — header and body disagree', () => {
  test('header wins for both billing and persistence; body is ignored', async () => {
    fetchResponses = [runtimeStream]
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/projects/p-split/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Chat-Session-Id': 'panel-A',
      },
      body: JSON.stringify({ chatSessionId: 'panel-B' }),
    }))
    expect(res.status).toBe(200)
    await res.text()
    await new Promise((r) => setTimeout(r, 50))

    const open = sessionCalls.find((c) => c.op === 'open')
    expect(open?.chatSessionId).toBe('panel-A')

    expect(prismaCalls.chatMessageCreate.length).toBe(1)
    // Header is authoritative: assistant row lands in panel-A, matching
    // the panel the user is actively reading from.
    expect(prismaCalls.chatMessageCreate[0].data.sessionId).toBe('panel-A')
    expect(prismaCalls.chatMessageCreate[0].data.content).toBe('assistant reply')

    // The stale body chatSessionId must NOT silently win persistence.
    const panelBLeak = prismaCalls.chatMessageCreate.filter(
      (c) => c.data.sessionId === 'panel-B',
    )
    expect(panelBLeak.length).toBe(0)
  })
})
