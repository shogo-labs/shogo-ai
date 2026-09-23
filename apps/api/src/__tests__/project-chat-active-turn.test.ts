// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * POST /projects/:projectId/chat + /chat/stop — active-turn bookkeeping.
 *
 * Runs the real chat-turn-state service against an in-memory ChatSession
 * table so the route's start / finish / stop / failure paths are asserted
 * on the resulting row state, including the scoping of stop requests and
 * that a failed send never clears another tab's live turn.
 *
 *   bun test apps/api/src/__tests__/project-chat-active-turn.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET ?? 'test-secret'
delete process.env.KUBERNETES_SERVICE_HOST
delete process.env.SHOGO_CLOUD_SYNC

type SessionRow = {
  id: string
  contextId: string | null
  workspaceId: string | null
  activeTurnId: string | null
  activeTurnStartedAt: Date | null
  activeTurnHeartbeatAt: Date | null
}

const sessions = new Map<string, SessionRow>()

function matches(row: SessionRow, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return (value as Record<string, any>[]).some((branch) => matches(row, branch))
    if (key === 'project') return row.contextId !== null && value.workspaceId === 'ws-1'
    return (row as any)[key] === value
  })
}

function seedSession(id: string, overrides: Partial<SessionRow> = {}) {
  sessions.set(id, {
    id,
    contextId: 'p-1',
    workspaceId: null,
    activeTurnId: null,
    activeTurnStartedAt: null,
    activeTurnHeartbeatAt: null,
    ...overrides,
  })
}

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
  InstanceKind: { desktop: 'desktop', cli_worker: 'cli_worker' },
  prisma: {
    project: {
      findUnique: async () => ({ id: 'p-1', name: 'Project', workspaceId: 'ws-1' }),
      update: async () => ({}),
    },
    chatMessage: {
      create: async (args: any) => ({ id: 'msg-1', ...args.data }),
    },
    chatSession: {
      findUnique: async (args: any) => sessions.get(args?.where?.id) ?? null,
      update: async (args: any) => {
        const row = sessions.get(args.where.id)
        if (!row) throw new Error('Record to update not found')
        Object.assign(row, args.data)
        return row
      },
      updateMany: async (args: any) => {
        let count = 0
        for (const row of sessions.values()) {
          if (!matches(row, args.where)) continue
          Object.assign(row, args.data)
          count++
        }
        return { count }
      },
    },
    toolCallLog: {
      createMany: async (args: any) => ({ count: args?.data?.length ?? 0 }),
    },
    member: { findFirst: async () => ({ id: 'member-1' }) },
  },
}))

mock.module('../services/billing.service', () => ({
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 99 }),
  hasBalance: async () => true,
  checkUsageBalance: async () => ({ ok: true }),
  usageLimitErrorPayload: (reason?: string) => ({ code: reason ?? 'usage_limit_reached', message: 'limit' }),
  hasAdvancedModelAccess: async () => true,
}))

mock.module('../services/git.service', () => ({
  isGitAvailable: () => false,
}))

mock.module('../services/checkpoint.service', () => ({
  createCheckpoint: async () => ({ id: 'ck-1' }),
  createAutoCheckpoint: async () => ({ id: 'ck-1' }),
}))

mock.module('../lib/proxy-billing-session', () => ({
  openSession: () => 'sess-1',
  closeSession: async () => ({ billedUsd: 0 }),
  setQualitySignals: () => false,
  hasSession: () => false,
  hasActiveSession: () => false,
  accumulateUsage: () => {},
}))

mock.module('../lib/resolve-pod-url', () => ({
  resolveProjectPodUrl: async () => ({ url: 'http://runtime-p-1.local' }),
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

type FetchResponder = (url: string) => Response | Promise<Response>
let fetchResponder: FetchResponder | null = null
const originalFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (input: any) => {
    if (!fetchResponder) throw new Error('No fetch responder configured')
    return fetchResponder(String(input))
  }) as any
})
afterAll(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  sessions.clear()
  fetchResponder = null
})

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

const encoder = new TextEncoder()

/** A runtime SSE response whose terminal frame is sent only when `finish()` runs. */
function controllableRuntimeStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      c.enqueue(encoder.encode('data: {"type":"text-delta","delta":"working"}\n'))
    },
  })
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    finish() {
      controller.enqueue(encoder.encode('data: {"type":"data-turn-complete","data":{"status":"completed"}}\n'))
      controller.close()
    },
  }
}

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms))

function sendChat(app: Hono, sessionId: string) {
  return app.fetch(new Request('http://x/api/projects/p-1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Session-Id': sessionId },
    body: JSON.stringify({ chatSessionId: sessionId }),
  }))
}

function sendStop(app: Hono, projectId: string, sessionId: string) {
  return app.fetch(new Request(`http://x/api/projects/${projectId}/chat/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatSessionId: sessionId }),
  }))
}

describe('project chat active turn', () => {
  test('stays active while the stream runs and clears when it completes', async () => {
    seedSession('s-1')
    const runtime = controllableRuntimeStream()
    fetchResponder = () => runtime.response
    const app = buildApp()

    const res = await sendChat(app, 's-1')
    expect(res.status).toBe(200)
    await tick()
    const turnId = sessions.get('s-1')!.activeTurnId
    expect(turnId).toEqual(expect.any(String))
    expect(sessions.get('s-1')!.activeTurnHeartbeatAt).toBeInstanceOf(Date)

    runtime.finish()
    await res.text()
    await tick()
    expect(sessions.get('s-1')!.activeTurnId).toBeNull()
    expect(sessions.get('s-1')!.activeTurnHeartbeatAt).toBeNull()
  })

  test('a scoped stop clears the turn once the runtime acknowledges it', async () => {
    seedSession('s-1', { activeTurnId: 'turn-1', activeTurnStartedAt: new Date(), activeTurnHeartbeatAt: new Date() })
    fetchResponder = () => Response.json({ success: true })

    const res = await sendStop(buildApp(), 'p-1', 's-1')
    expect(res.status).toBe(200)
    expect(sessions.get('s-1')!.activeTurnId).toBeNull()
  })

  test('a stop naming another project\'s session is a no-op', async () => {
    seedSession('s-other', { contextId: 'p-other', activeTurnId: 'turn-other', activeTurnStartedAt: new Date() })
    fetchResponder = () => Response.json({ success: true })

    await sendStop(buildApp(), 'p-1', 's-other')
    expect(sessions.get('s-other')!.activeTurnId).toBe('turn-other')
  })

  test('a stop the runtime rejects leaves the turn active', async () => {
    seedSession('s-1', { activeTurnId: 'turn-1', activeTurnStartedAt: new Date() })
    fetchResponder = () => Response.json({ success: false }, { status: 500 })

    await sendStop(buildApp(), 'p-1', 's-1')
    expect(sessions.get('s-1')!.activeTurnId).toBe('turn-1')
  })

  test('a failed send does not clear another tab\'s live turn', async () => {
    const heartbeat = new Date()
    seedSession('s-1', { activeTurnId: 'other-tab-turn', activeTurnStartedAt: heartbeat, activeTurnHeartbeatAt: heartbeat })
    fetchResponder = () => new Response('bad request', { status: 400 })

    const res = await sendChat(buildApp(), 's-1')
    expect(res.status).toBe(400)
    await tick()
    expect(sessions.get('s-1')).toMatchObject({
      activeTurnId: 'other-tab-turn',
      activeTurnHeartbeatAt: heartbeat,
    })
  })
})
