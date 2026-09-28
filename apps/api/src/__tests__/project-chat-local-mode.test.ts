// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * POST /projects/:projectId/chat in desktop local mode, with the REAL local
 * billing seams (nothing billing-related is mocked). The usage gate must let
 * the turn through to the runtime; a broken local seam answered every chat
 * with HTTP 402 `{"error":{}}` before the runtime was ever called.
 *
 *   bun test apps/api/src/__tests__/project-chat-local-mode.test.ts
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const previousLocalMode = process.env.SHOGO_LOCAL_MODE
process.env.SHOGO_LOCAL_MODE = 'true'
process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET ?? 'test-secret'
delete process.env.KUBERNETES_SERVICE_HOST
delete process.env.SHOGO_CLOUD_SYNC

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
    chatMessage: { create: async (args: any) => ({ id: 'msg-1', ...args.data }) },
    chatSession: {
      findUnique: async () => null,
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
    toolCallLog: { createMany: async (args: any) => ({ count: args?.data?.length ?? 0 }) },
    member: { findFirst: async () => ({ id: 'member-1' }) },
    usageEvent: { create: async () => ({}) },
  },
}))

mock.module('../services/git.service', () => ({ isGitAvailable: () => false }))

mock.module('../services/checkpoint.service', () => ({
  createCheckpoint: async () => ({ id: 'ck-1' }),
  createAutoCheckpoint: async () => ({ id: 'ck-1' }),
}))

mock.module('../lib/resolve-pod-url', () => ({
  resolveProjectPodUrl: async () => ({ url: 'http://runtime-p-1.local' }),
}))

mock.module('../lib/runtime-token', () => ({ deriveRuntimeToken: () => 'tok-1' }))

mock.module('../lib/project-user-context', () => ({
  setProjectUser: () => {},
  getProjectUser: () => null,
}))

mock.module('fs', () => ({ existsSync: () => true }))

const runtimeCalls: string[] = []
const originalFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (input: any) => {
    runtimeCalls.push(String(input))
    return new Response(
      'data: {"type":"text-delta","delta":"hi"}\n\ndata: {"type":"data-turn-complete","data":{"status":"completed"}}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
  }) as any
})
afterAll(() => {
  globalThis.fetch = originalFetch
  if (previousLocalMode === undefined) delete process.env.SHOGO_LOCAL_MODE
  else process.env.SHOGO_LOCAL_MODE = previousLocalMode
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

describe('project chat in local mode', () => {
  test('the usage gate lets the turn through to the agent runtime', async () => {
    const res = await buildApp().fetch(new Request('http://x/api/projects/p-1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Chat-Session-Id': 's-1' },
      body: JSON.stringify({ chatSessionId: 's-1', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
    }))
    const body = await res.text()
    expect(res.status).not.toBe(402)
    expect(body).not.toContain('{"error":{}}')
    expect(res.status).toBe(200)
    expect(runtimeCalls.some((url) => url.includes('/agent/chat'))).toBe(true)
  })
})
