// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-52: a retried project-chat send delivers its `<@c:CHAT_ID>` handoff once.
 *
 * The offline send queue re-POSTs a message whose original request may already
 * have landed, carrying the same `X-Client-Turn-Id`. Delivery of chat tags has
 * to sit behind that idempotency gate, otherwise the tagged chat is handed the
 * same message twice.
 *
 *   bun test apps/api/src/__tests__/project-chat-mention-idempotency.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET ?? 'test-secret'
delete process.env.KUBERNETES_SERVICE_HOST
delete process.env.SHOGO_CLOUD_SYNC

const sessions = new Map<string, any>()
const queued: any[] = []

mock.module('@shogo/model-catalog', () => ({
  getModelTier: (_modelId: string) => 'standard',
  resolveModelId: (mode: string) => mode || 'claude-haiku-4-5',
  MODEL_CATALOG: {},
  getModelEntry: (_id: string) => null,
  MODEL_DOLLAR_COSTS: {} as Record<string, any>,
  calculateDollarCost: () => 0,
  getModelBillingModel: (id: string) => id,
  resolveAgentModeDefault: (mode: string) => mode,
  AUTO_MODEL_ID: 'auto',
  isAutoModel: (id: string) => id === 'auto',
  inferProviderFromModel: (_id: string, fallback: string) => fallback,
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
      upsert: async (args: any) => args.create,
    },
    chatQueuedMessage: {
      findFirst: async () => null,
      create: async (args: any) => {
        queued.push(args.data)
        return args.data
      },
    },
    chatSession: {
      findUnique: async (args: any) => sessions.get(args?.where?.id) ?? null,
      findFirst: async (args: any) => sessions.get(args?.where?.AND?.[0]?.id) ?? null,
      update: async (args: any) => {
        const row = sessions.get(args.where.id)
        if (!row) throw new Error('Record to update not found')
        Object.assign(row, args.data)
        return row
      },
      updateMany: async () => ({ count: 0 }),
    },
    user: {
      findUnique: async () => ({ name: 'Ada Lovelace', email: 'ada@example.com' }),
    },
    toolCallLog: { createMany: async () => ({ count: 0 }) },
    member: { findFirst: async () => ({ id: 'member-1' }) },
  },
}))

// Only the access check the route uses; the delivery service's own access
// rules are covered by `chat-mention-delivery.test.ts`.
mock.module('../lib/authz', () => ({
  loadAccess: async () => ({ permissions: new Set(['project:read']) }),
  accessibleProjectsWhere: async () => ({}),
}))

mock.module('../lib/chat-mentionables', () => ({
  resolveChatForUser: async (_userId: string, chatId: string) =>
    chatId === 'chat-target'
      ? { id: 'chat-target', name: 'Deploy notes', contextType: 'project', workspaceId: null, isArchived: false }
      : null,
  chatTitleOf: (session: any) => session?.name ?? 'chat',
  chatScopeOf: () => ({ projectId: null, projectName: null, workspaceId: 'ws-2', workspaceName: 'Other team' }),
  readChatTranscript: async () => null,
}))

mock.module('../services/chat-queue-dispatcher.service', () => ({
  dispatchNext: async () => true,
}))

mock.module('../services/billing.service', () => ({
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 99 }),
  hasBalance: async () => true,
  checkUsageBalance: async () => ({ ok: true }),
  getEffectivePlanId: async () => 'free',
  usageLimitErrorPayload: (reason?: string) => ({ code: reason ?? 'usage_limit_reached', message: 'limit' }),
  hasAdvancedModelAccess: async () => true,
}))

mock.module('../services/git.service', () => ({ isGitAvailable: () => false }))

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

mock.module('../lib/runtime-token', () => ({ deriveRuntimeToken: () => 'tok-1' }))

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

const encoder = new TextEncoder()
let fetchResponder: ((url: string) => Response | Promise<Response>) | null = null
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

const { projectChatRoutes } = await import('../routes/project-chat')
const { _resetClientTurnIdempotencyForTests } = await import('../lib/chat-turn-idempotency')

beforeEach(() => {
  sessions.clear()
  queued.length = 0
  fetchResponder = null
  _resetClientTurnIdempotencyForTests()
  sessions.set('s-1', {
    id: 's-1',
    contextId: 'p-1',
    workspaceId: null,
    activeTurnId: null,
    activeTurnStartedAt: null,
    activeTurnHeartbeatAt: null,
  })
})

function buildApp() {
  const app = new Hono()
  app.route(
    '/api',
    projectChatRoutes({
      runtimeManager: {
        status: () => ({ status: 'running', url: 'http://localhost:5200', port: 5200, agentPort: 6200 }),
        start: async () => ({ status: 'running' }),
        stop: async () => {},
        restart: async () => ({ status: 'running' }),
      } as any,
    }),
  )
  return app
}

/** The runtime's turn stream, complete on arrival. */
function turnStream(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"text-delta","delta":"ok"}\n'))
        controller.enqueue(
          encoder.encode('data: {"type":"data-turn-complete","data":{"status":"completed"}}\n'),
        )
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

function sendChat(app: Hono, clientTurnId: string, text: string) {
  return app.fetch(
    new Request('http://x/api/projects/p-1/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Chat-Session-Id': 's-1',
        'X-Client-Turn-Id': clientTurnId,
      },
      body: JSON.stringify({ chatSessionId: 's-1', userId: 'user-1', text }),
    }),
  )
}

describe('project chat chat-tag delivery under retries', () => {
  test('a first send delivers the handoff into the tagged chat', async () => {
    fetchResponder = () => turnStream()
    const res = await sendChat(buildApp(), 'turn-abc', 'please pick this up <@c:chat-target>')
    expect(res.status).toBe(200)
    await res.text()

    expect(queued).toHaveLength(1)
    expect(queued[0].sessionId).toBe('chat-target')
    // The target gets the text without its own tag (no chip back to itself).
    expect(queued[0].content).toContain('please pick this up')
    expect(queued[0].content).not.toContain('<@c:chat-target>')
  })

  test('a retry with the same X-Client-Turn-Id does not deliver it twice', async () => {
    fetchResponder = (url) => {
      // The retry attaches to the buffered turn rather than starting another.
      if (url.includes('/stream')) return new Response(null, { status: 204 })
      return turnStream()
    }
    const app = buildApp()
    const text = 'please pick this up <@c:chat-target>'

    const first = await sendChat(app, 'turn-abc', text)
    expect(first.status).toBe(200)
    await first.text()

    const retry = await sendChat(app, 'turn-abc', text)
    expect(retry.status).toBe(200)
    await retry.text()

    expect(queued).toHaveLength(1)
  })

  test('a new turn id is a new send and delivers again', async () => {
    fetchResponder = () => turnStream()
    const app = buildApp()
    const text = 'one more <@c:chat-target>'

    await (await sendChat(app, 'turn-abc', text)).text()
    await (await sendChat(app, 'turn-def', text)).text()

    expect(queued).toHaveLength(2)
  })
})
