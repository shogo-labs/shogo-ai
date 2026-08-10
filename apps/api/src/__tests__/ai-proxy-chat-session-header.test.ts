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
// Flip to false to simulate an exhausted wallet for the usage-limit-grace
// tests below (a build must not be dropped mid-turn when the limit is hit).
let hasBalanceResult = true
mock.module('../services/billing.service', () => ({
  consumeUsage: async (args: any) => {
    consumeUsageCalls.push(args)
    return { success: true, remainingIncludedUsd: 100 }
  },
  hasBalance: async () => hasBalanceResult,
  hasAdvancedModelAccess: async () => true,
  // buildUsageLimitInfo (the 402 detail builder) calls this.
  getUsageWindows: async () => ({
    fiveHour: { kind: 'five_hour', usedUsd: 0, limitUsd: null, utilization: 0, resetsAt: null },
    weekly: { kind: 'weekly', usedUsd: 0, limitUsd: null, utilization: 0, resetsAt: null },
  }),
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
  hasBalanceResult = true
})

const { Hono } = await import('hono')
const { aiProxyRoutes } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')
const { openSession, closeSession, hasSession } = await import('../lib/proxy-billing-session')

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

  // ── Usage-limit grace: don't drop a build mid-message ──
  // A chat turn is gated for usage once at turn start. Once admitted (a billing
  // session is open), the per-call 402 pre-flight in the proxy must NOT re-gate
  // its intermediate LLM/image calls, or a long build dies halfway with
  // "model did not produce a final answer after tool execution".

  test('exhausted wallet does NOT 402 a text call that belongs to an in-flight turn', async () => {
    const app = makeApp()
    const token = await generateProxyToken(PROJECT_ID, WORKSPACE_ID, USER_ID)
    hasBalanceResult = false // wallet crossed the limit mid-build

    openSession(PROJECT_ID, WORKSPACE_ID, USER_ID, 'chat-grace')

    const res = await app.request('/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': token,
        'X-Chat-Session-Id': 'chat-grace',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'keep building' }],
        max_tokens: 64,
      }),
    })
    // The message is allowed to finish rather than being cut off with a 402.
    expect(res.status).not.toBe(402)
    expect(res.status).toBe(200)

    await closeSession(PROJECT_ID, { chatSessionId: 'chat-grace' })
  })

  test('grace still applies when the runtime dropped the chat-session header', async () => {
    const app = makeApp()
    const token = await generateProxyToken(PROJECT_ID, WORKSPACE_ID, USER_ID)
    hasBalanceResult = false

    // Session opened under a composite key, but the proxy call omits the
    // header (gateway isRealChatSession=false). The projectId-scan fallback in
    // hasActiveSession must still detect the in-flight turn.
    openSession(PROJECT_ID, WORKSPACE_ID, USER_ID, 'chat-headerless')

    const res = await app.request('/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': token,
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'keep building' }],
        max_tokens: 64,
      }),
    })
    expect(res.status).not.toBe(402)

    await closeSession(PROJECT_ID, { chatSessionId: 'chat-headerless' })
  })

  test('exhausted wallet DOES 402 when no turn is in flight (no open session)', async () => {
    const app = makeApp()
    const token = await generateProxyToken(PROJECT_ID, WORKSPACE_ID, USER_ID)
    hasBalanceResult = false

    // No session opened → this is a brand-new request, so the usage limit is
    // enforced as before.
    expect(hasSession(PROJECT_ID)).toBe(false)

    const res = await app.request('/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': token,
        'X-Chat-Session-Id': 'chat-none',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 64,
      }),
    })
    expect(res.status).toBe(402)
    const json = (await res.json()) as any
    expect(json.error?.type).toBe('billing_error')
  })

  test('image generation is not cut off mid-turn, but is 402d with no session', async () => {
    const app = makeApp()
    const token = await generateProxyToken(PROJECT_ID, WORKSPACE_ID, USER_ID)
    hasBalanceResult = false

    // Image endpoints authenticate via `Authorization: Bearer`, not x-api-key.
    // No session → hard 402 (enforced as before).
    const gated = await app.request('/api/ai/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: 'a cat', model: 'dall-e-3' }),
    })
    expect(gated.status).toBe(402)

    // In-flight turn → the pre-flight is skipped so the image call proceeds
    // (downstream status varies under the stub; it just must not be 402).
    openSession(PROJECT_ID, WORKSPACE_ID, USER_ID, 'chat-img')
    const granted = await app.request('/api/ai/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Chat-Session-Id': 'chat-img',
      },
      body: JSON.stringify({ prompt: 'a cat', model: 'dall-e-3' }),
    })
    expect(granted.status).not.toBe(402)

    await closeSession(PROJECT_ID, { chatSessionId: 'chat-img' })
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
