// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AI Proxy ↔ Chat-Session Header Round-Trip
 *
 * The runtime stamps `X-Chat-Session-Id` on every outbound ai-proxy call
 * so accumulateUsage can route tokens to the right
 * `(projectId, chatSessionId)` billing-session bucket. This test pins
 * that round-trip end-to-end without mocking proxy-billing-session
 * itself (cross-file mock contamination in bun's module cache breaks
 * sibling tests if we do). Instead we open a real session keyed by
 * `(projectId, chatSessionId)`, hit the proxy with the header, close
 * the session, and assert the resulting consumeUsage call carries the
 * tokens that the proxy upstreamed.
 *
 *   bun test apps/api/src/__tests__/ai-proxy-chat-session-header.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test'

delete process.env.SHOGO_LOCAL_MODE
delete process.env.SHOGO_API_KEY
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.OPENAI_API_KEY = 'sk-openai-test'
process.env.NODE_ENV = 'test'

// consumeUsage is the back-stop the real proxy-billing-session calls on
// closeSession; capturing the metadata lets us read back which chat
// session the accumulated tokens were attributed to.
const consumeUsageCalls: any[] = []
mock.module('../services/billing.service', () => ({
  consumeUsage: async (args: any) => {
    consumeUsageCalls.push(args)
    return { success: true, remainingIncludedUsd: 100 }
  },
  hasBalance: async () => true,
  hasAdvancedModelAccess: async () => true,
}))

// recordAgentCostMetric pulls in Prisma — stub it out so closeSession
// doesn't blow up trying to write the analytics row.
mock.module('../services/cost-analytics.service', () => ({
  recordAgentCostMetric: async () => undefined,
}))

const originalFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (_input: any, _init?: RequestInit) => {
    const body = JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 100,
        output_tokens: 25,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    })
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }) as any
  }) as any
})
afterAll(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  consumeUsageCalls.length = 0
})

const { Hono } = await import('hono')
const { aiProxyRoutes } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')
const { openSession, closeSession } = await import('../lib/proxy-billing-session')

const PROJECT_ID = 'proj-header-rt'
const WORKSPACE_ID = 'ws-header-rt'
const USER_ID = 'user-header-rt'

function makeApp() {
  const app = new Hono()
  app.route('/api', aiProxyRoutes())
  return app
}

describe('AI proxy honors X-Chat-Session-Id on outbound runtime calls', () => {
  test('header routes tokens to the matching (project, chatSession) bucket', async () => {
    const app = makeApp()
    const token = await generateProxyToken(PROJECT_ID, WORKSPACE_ID, USER_ID)

    // Two concurrent sessions on the same project. Without the header
    // round-trip, accumulateUsage on the proxy side would fall through
    // to the legacy projectId-only key and credit BOTH sessions'
    // upstream calls to whichever opened first.
    openSession(PROJECT_ID, WORKSPACE_ID, 'user-A', 'chat-A')
    openSession(PROJECT_ID, WORKSPACE_ID, 'user-B', 'chat-B')

    const res = await app.request('/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': token,
        'X-Chat-Session-Id': 'chat-B',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 64,
      }),
    })
    expect(res.status).toBe(200)

    // chat-A was opened but received no proxy calls → 0 tokens.
    await closeSession(PROJECT_ID, { chatSessionId: 'chat-A' })
    await closeSession(PROJECT_ID, { chatSessionId: 'chat-B' })

    expect(consumeUsageCalls.length).toBe(1)
    const call = consumeUsageCalls[0]
    expect(call.memberId).toBe('user-B')
    expect(call.actionMetadata.chatSessionId).toBe('chat-B')
    expect(call.actionMetadata.inputTokens).toBe(100)
    expect(call.actionMetadata.outputTokens).toBe(25)
  })

  test('missing header falls back to the legacy projectId-only billing session', async () => {
    const app = makeApp()
    const token = await generateProxyToken(PROJECT_ID, WORKSPACE_ID, USER_ID)

    // Single legacy-keyed session (no chatSessionId). The proxy call
    // omits the header, so accumulateUsage must hit this session.
    openSession(PROJECT_ID, WORKSPACE_ID, USER_ID)

    const res = await app.request('/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': token,
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 64,
      }),
    })
    expect(res.status).toBe(200)

    await closeSession(PROJECT_ID)

    expect(consumeUsageCalls.length).toBe(1)
    expect(consumeUsageCalls[0].actionMetadata.chatSessionId).toBeUndefined()
    expect(consumeUsageCalls[0].actionMetadata.inputTokens).toBe(100)
  })
})
