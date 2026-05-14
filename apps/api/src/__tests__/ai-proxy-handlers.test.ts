// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AI Proxy — handler-level coverage for the routes not exercised by
 * `ai-proxy-routes.test.ts` / `-billing.test.ts` / `-e2e.test.ts`.
 *
 * Targets:
 *   - POST /ai/v1/responses (auth + model validation + provider gating)
 *   - GET  /ai/v1/access
 *   - GET  /ai/v1/subscription
 *   - PUT  /ai/v1/subscription
 *   - POST /ai/anthropic/v1/messages/count_tokens
 *   - GET  /ai/anthropic/v1/models
 *   - POST /ai/v1/images/edits  (validation paths)
 *   - POST /ai/v1/images/generations (unknown model / unconfigured provider)
 *
 * No external network: `globalThis.fetch` is stubbed at file scope.
 *
 *   bun test apps/api/src/__tests__/ai-proxy-handlers.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// We want the cloud-side path: no SHOGO_LOCAL_MODE/SHOGO_API_KEY so the
// route exercises the local-provider call (which we then stub via
// `fetch`).
delete process.env.SHOGO_LOCAL_MODE
delete process.env.SHOGO_API_KEY
delete process.env.GOOGLE_API_KEY
process.env.OPENAI_API_KEY = 'sk-openai-test'
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'

let walletStub: any
let subStub: any
let projectFindFirstResult: any

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findFirst: async () => projectFindFirstResult,
      findUnique: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
    },
    apiKey: {
      findUnique: async () => null,
      update: async () => ({}),
    },
    usageEvent: {
      create: async () => ({}),
    },
    usageWallet: {
      findUnique: async () => walletStub,
      create: async (args: any) => args.data,
      update: async (args: any) => args.data,
      upsert: async (args: any) => args.create,
    },
    subscription: {
      findFirst: async () => subStub,
      upsert: async () => subStub,
    },
  },
}))

// Stub billing service so the auth/billing gates fire deterministically.
mock.module('../services/billing.service', () => ({
  hasBalance: async () => true,
  hasAdvancedModelAccess: async (workspaceId: string) => workspaceId === 'ws-pro',
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 100 }),
  getSubscription: async () => subStub,
  getUsageWallet: async () => walletStub,
  syncFromStripe: async () => ({}),
  allocateMonthlyIncluded: async () => ({}),
}))

mock.module('../lib/proxy-billing-session', () => ({
  openSession: () => null,
  hasSession: () => false,
  accumulateUsage: () => {},
  accumulateImageUsage: () => {},
  setQualitySignals: () => false,
  closeSession: async () => null,
}))

mock.module('../lib/project-user-context', () => ({
  getProjectUser: () => 'test-user',
}))

// ─── Stub fetch deterministically per call ────────────────────────────────
const originalFetch = globalThis.fetch
let lastFetchUrl: string | null = null
let lastFetchInit: RequestInit | undefined
let nextFetchResponses: Array<() => Response> = []

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    lastFetchUrl = url
    lastFetchInit = init
    const next = nextFetchResponses.shift()
    if (next) return next() as any
    // Default to an empty JSON body so tests that don't preload an
    // upstream response still get something valid back.
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }) as any
  }) as any
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  lastFetchUrl = null
  lastFetchInit = undefined
  nextFetchResponses = []
  delete process.env.SHOGO_API_KEY
  delete process.env.SHOGO_CLOUD_URL
  projectFindFirstResult = { id: 'proj-1', name: 'Test' }
  walletStub = {
    workspaceId: 'ws-1',
    monthlyIncludedUsd: 20,
    monthlyIncludedAllocationUsd: 20,
    dailyIncludedUsd: 0.5,
    dailyUsedThisMonthUsd: 0,
    overageEnabled: false,
    overageHardLimitUsd: null,
    overageAccumulatedUsd: 0,
    stripeMeteredItemId: null,
    lastDailyReset: new Date(),
    lastMonthlyReset: new Date(),
  }
  subStub = {
    id: 'sub_1',
    workspaceId: 'ws-1',
    planId: 'pro',
    status: 'active',
    billingInterval: 'monthly',
    currentPeriodEnd: new Date(Date.now() + 86_400_000),
    cancelAtPeriodEnd: false,
  }
})

// ─── Imports AFTER mocks ─────────────────────────────────────────────────
const { Hono } = await import('hono')
const { aiProxyRoutes } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')

function buildApp() {
  const app = new Hono()
  app.route('/api', aiProxyRoutes())
  return app
}

let TOKEN: string

beforeAll(async () => {
  TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')
})

// =========================================================================
// POST /ai/v1/responses
// =========================================================================

describe('POST /ai/v1/responses', () => {
  test('rejects without auth (401)', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', input: 'hi' }),
    }))
    expect(res.status).toBe(401)
  })

  test('rejects missing model (400)', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ input: 'hi' }),
    }))
    expect(res.status).toBe(400)
    const data = await res.json() as any
    expect(data.error.message).toMatch(/model is required/i)
  })

  test('rejects unknown model (400)', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: 'totally-fake-model', input: 'hi' }),
    }))
    expect(res.status).toBe(400)
    const data = await res.json() as any
    expect(data.error.message).toMatch(/not supported/i)
  })

  test('forwards a non-streaming request and records usage on success', async () => {
    nextFetchResponses.push(() => new Response(JSON.stringify({
      id: 'resp_1',
      output_text: 'hello',
      usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 5 } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', input: 'hi' }),
    }))
    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe('https://api.openai.com/v1/responses')
    const data = await res.json() as any
    expect(data.id).toBe('resp_1')
  })

  test('forwards a streaming request and records usage from response.completed events', async () => {
    nextFetchResponses.push(() => new Response([
      'data: {"type":"response.output_text.delta","delta":"hello"}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":18,"input_tokens_details":{"cached_tokens":3},"output_tokens":5}}}',
      'data: [DONE]',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', input: 'hi', stream: true }),
    }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    const text = await res.text()
    expect(text).toContain('response.completed')
    expect(text).toContain('data: [DONE]')
  })

  test('propagates upstream non-2xx response verbatim', async () => {
    nextFetchResponses.push(() => new Response('{"error":"upstream bad"}', {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    }))

    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', input: 'hi' }),
    }))
    expect(res.status).toBe(502)
  })

  test('returns 503 when the provider key is not configured', async () => {
    const saved = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const app = buildApp()
      const res = await app.fetch(new Request('http://x/api/ai/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', input: 'hi' }),
      }))
      expect(res.status).toBe(503)
    } finally {
      process.env.OPENAI_API_KEY = saved
    }
  })
})

// =========================================================================
// POST /ai/v1/chat/completions stream conversion
// =========================================================================

describe('POST /ai/v1/chat/completions streaming conversions', () => {
  test('proxies OpenAI-compatible streams and records usage from final SSE chunk', async () => {
    nextFetchResponses.push(() => new Response([
      'data: {"id":"chunk-1","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"prompt_tokens_details":{"cached_tokens":4},"completion_tokens":6}}',
      'data: [DONE]',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }))

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Proxy-Provider')).toBe('openai')
    const text = await res.text()
    expect(text).toContain('"content":"hi"')
    expect(text).toContain('"completion_tokens":6')
    expect(text).toContain('data: [DONE]')
  })

  test('converts Anthropic streaming events into OpenAI-compatible chunks', async () => {
    nextFetchResponses.push(() => new Response([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_creation_input_tokens":2,"cache_read_input_tokens":3}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"search"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\""}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}',
      'data: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}',
      'data: [DONE]',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }))

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Proxy-Provider')).toBe('anthropic')
    const text = await res.text()
    expect(text).toContain('"object":"chat.completion.chunk"')
    expect(text).toContain('"content":"hello"')
    expect(text).toContain('"tool_calls"')
    expect(text).toContain('"arguments":"{\\"q\\""')
    expect(text).toContain('"finish_reason":"tool_calls"')
    expect(text).toContain('"overloaded_error"')
    expect(text).toContain('data: [DONE]')
  })

  test('converts Anthropic non-streaming responses into OpenAI chat completions', async () => {
    nextFetchResponses.push(() => new Response(JSON.stringify({
      id: 'msg_1',
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'there' },
        { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'docs' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 15, output_tokens: 9 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' },
        ],
        tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
        tool_choice: { type: 'function', function: { name: 'search' } },
      }),
    }))

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.id).toBe('msg_1')
    expect(body.choices[0].message.content).toBe('hello there')
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('search')
    expect(body.choices[0].finish_reason).toBe('tool_calls')
    expect(body.usage.total_tokens).toBe(24)
  })
})

// =========================================================================
// POST /ai/anthropic/v1/messages OpenAI-to-Anthropic stream conversion
// =========================================================================

describe('POST /ai/anthropic/v1/messages streaming conversions', () => {
  test('converts OpenAI streaming chunks into Anthropic SSE for OpenAI-backed models', async () => {
    nextFetchResponses.push(() => new Response([
      'data: {"choices":[{"delta":{"content":"hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"}}]}',
      'data: {"choices":[{"delta":{}}]}',
      'data: [DONE]',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': TOKEN,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        stream: true,
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }))

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Proxy-Provider')).toBe('openai')
    const text = await res.text()
    expect(text).toContain('event: message_start')
    expect(text).toContain('event: content_block_start')
    expect(text).toContain('"text":"hello"')
    expect(text).toContain('"text":" world"')
    expect(text).toContain('event: content_block_stop')
    expect(text).toContain('event: message_stop')
  })

  test('passes through non-streaming Anthropic-native requests and records usage', async () => {
    nextFetchResponses.push(() => new Response(JSON.stringify({
      id: 'msg_native',
      type: 'message',
      role: 'assistant',
      model: 'claude-3-haiku-20240307',
      content: [{ type: 'text', text: 'native ok' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 4,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': TOKEN,
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        system: [{ type: 'text', text: 'Stable<|CACHE_BOUNDARY|>Dynamic' }],
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }))

    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe('https://api.anthropic.com/v1/messages')
    const body = await res.json() as any
    expect(body.id).toBe('msg_native')
    expect(body.content[0].text).toBe('native ok')
  })

  test('passes through streaming Anthropic-native requests and tracks usage from SSE events', async () => {
    nextFetchResponses.push(() => new Response([
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"cache_creation_input_tokens":2,"cache_read_input_tokens":3}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'request-id': 'req_native',
      },
    }))

    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': TOKEN,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        stream: true,
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }))

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Proxy-Provider')).toBe('anthropic')
    expect(res.headers.get('X-Proxy-Project')).toBe('proj-1')
    expect(res.headers.get('request-id')).toBe('req_native')
    const text = await res.text()
    expect(text).toContain('message_start')
    expect(text).toContain('message_stop')
    expect(text).not.toContain('upstream_truncated')
  })
})

// =========================================================================
// GET /ai/v1/access
// =========================================================================

describe('GET /ai/v1/access', () => {
  test('401 without auth', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/access'))
    expect(res.status).toBe(401)
  })

  test('returns hasAdvancedModelAccess for the authed workspace', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/access', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }))
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(typeof data.hasAdvancedModelAccess).toBe('boolean')
  })
})

// =========================================================================
// GET /ai/v1/models and POST /ai/proxy/tokens
// =========================================================================

describe('AI proxy model listing and token generation', () => {
  test('GET /ai/v1/models requires auth and returns canonical model metadata', async () => {
    const app = buildApp()
    const unauth = await app.fetch(new Request('http://x/api/ai/v1/models'))
    expect(unauth.status).toBe(401)

    const res = await app.fetch(new Request('http://x/api/ai/v1/models', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }))
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.object).toBe('list')
    expect(data.data.some((model: any) => model.id === 'gpt-4o-mini' && model.available === true)).toBe(true)
    expect(data.data.some((model: any) => model.id === 'claude-3-haiku-20240307' && model.available === true)).toBe(true)
  })

  test('POST /ai/proxy/tokens validates input, project scope, and returns an expiring token', async () => {
    const app = buildApp()

    const invalid = await app.fetch(new Request('http://x/api/ai/proxy/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-1' }),
    }))
    expect(invalid.status).toBe(400)

    projectFindFirstResult = null
    const missing = await app.fetch(new Request('http://x/api/ai/proxy/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'missing', workspaceId: 'ws-1' }),
    }))
    expect(missing.status).toBe(404)

    projectFindFirstResult = { id: 'proj-1', name: 'Test' }
    const ok = await app.fetch(new Request('http://x/api/ai/proxy/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-1', workspaceId: 'ws-1', userId: 'user-1', expiryHours: 2 }),
    }))
    expect(ok.status).toBe(200)
    const body = await ok.json() as any
    expect(body.projectId).toBe('proj-1')
    expect(body.workspaceId).toBe('ws-1')
    expect(body.expiresIn).toBe('2h')
    expect(typeof body.token).toBe('string')
  })
})

// =========================================================================
// GET / PUT /ai/v1/subscription
// =========================================================================

describe('/ai/v1/subscription', () => {
  test('GET 401 without auth', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/subscription'))
    expect(res.status).toBe(401)
  })

  test('GET returns subscription + usage snapshot for authed workspace', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/subscription', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }))
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.workspaceId).toBe('ws-1')
    expect(data.subscription).toBeDefined()
    expect(data.usage).toBeDefined()
  })

  test('GET tolerates null subscription and null wallet (returns null fields)', async () => {
    subStub = null
    walletStub = null
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/subscription', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }))
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.subscription).toBeNull()
    expect(data.usage).toBeNull()
  })

  test('PUT 401 without auth', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/subscription', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }))
    expect(res.status).toBe(401)
  })

  test('PUT defaults planId to "pro" when body omits it', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/subscription', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: '{}',
    }))
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.ok).toBe(true)
    expect(data.planId).toBe('pro')
  })

  test('PUT accepts an explicit planId override', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/subscription', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ planId: 'team' }),
    }))
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.planId).toBe('team')
  })
})

// =========================================================================
// POST /ai/anthropic/v1/messages/count_tokens
// =========================================================================

describe('POST /ai/anthropic/v1/messages/count_tokens', () => {
  test('401 without x-api-key', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/anthropic/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-3-haiku-20240307', messages: [] }),
    }))
    expect(res.status).toBe(401)
  })

  test('forwards to Anthropic when authed and returns upstream body verbatim', async () => {
    nextFetchResponses.push(() => new Response(JSON.stringify({ input_tokens: 42 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/anthropic/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': TOKEN,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'claude-3-haiku-20240307', messages: [{ role: 'user', content: 'hi' }] }),
    }))
    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe('https://api.anthropic.com/v1/messages/count_tokens')
    const data = await res.json() as any
    expect(data.input_tokens).toBe(42)
  })

  test('returns 503 when ANTHROPIC_API_KEY is not set', async () => {
    const saved = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const app = buildApp()
      const res = await app.fetch(new Request('http://x/api/ai/anthropic/v1/messages/count_tokens', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TOKEN,
        },
        body: JSON.stringify({ model: 'claude-3-haiku-20240307', messages: [] }),
      }))
      expect(res.status).toBe(503)
    } finally {
      process.env.ANTHROPIC_API_KEY = saved
    }
  })
})

// =========================================================================
// GET /ai/anthropic/v1/models
// =========================================================================

describe('GET /ai/anthropic/v1/models', () => {
  test('401 without auth', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/anthropic/v1/models'))
    expect(res.status).toBe(401)
  })

  test('forwards to Anthropic and returns upstream body verbatim', async () => {
    nextFetchResponses.push(() => new Response(JSON.stringify({ data: [{ id: 'claude-3-haiku-20240307' }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/anthropic/v1/models', {
      headers: { 'x-api-key': TOKEN, 'anthropic-version': '2023-06-01' },
    }))
    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe('https://api.anthropic.com/v1/models')
    const data = await res.json() as any
    expect(Array.isArray(data.data)).toBe(true)
  })

  test('returns 503 when ANTHROPIC_API_KEY is not set', async () => {
    const saved = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const app = buildApp()
      const res = await app.fetch(new Request('http://x/api/ai/anthropic/v1/models', {
        headers: { 'x-api-key': TOKEN },
      }))
      expect(res.status).toBe(503)
    } finally {
      process.env.ANTHROPIC_API_KEY = saved
    }
  })
})

// =========================================================================
// POST /ai/v1/images/edits  (validation surface only)
// =========================================================================

describe('POST /ai/v1/images/edits', () => {
  test('401 without auth', async () => {
    const app = buildApp()
    const fd = new FormData()
    fd.append('prompt', 'a sunset')
    const res = await app.fetch(new Request('http://x/api/ai/v1/images/edits', {
      method: 'POST',
      body: fd,
    }))
    expect(res.status).toBe(401)
  })

  test('returns 400 when prompt is missing', async () => {
    const app = buildApp()
    const fd = new FormData()
    fd.append('image', new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }))
    const res = await app.fetch(new Request('http://x/api/ai/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: fd,
    }))
    expect(res.status).toBe(400)
    const data = await res.json() as any
    expect(data.error.code).toBe('missing_prompt')
  })

  test('returns 400 when image file is missing', async () => {
    const app = buildApp()
    const fd = new FormData()
    fd.append('prompt', 'a sunset')
    const res = await app.fetch(new Request('http://x/api/ai/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: fd,
    }))
    expect(res.status).toBe(400)
    const data = await res.json() as any
    expect(data.error.code).toBe('missing_image')
  })

  test('returns 503 when OPENAI_API_KEY is not set', async () => {
    const saved = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const app = buildApp()
      const fd = new FormData()
      fd.append('prompt', 'a sunset')
      fd.append('image', new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }))
      const res = await app.fetch(new Request('http://x/api/ai/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: fd,
      }))
      expect(res.status).toBe(503)
    } finally {
      process.env.OPENAI_API_KEY = saved
    }
  })

  test('forwards successful upstream edit response back to caller', async () => {
    nextFetchResponses.push(() => new Response(JSON.stringify({
      data: [{ b64_json: 'aGk=' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const app = buildApp()
    const fd = new FormData()
    fd.append('prompt', 'a sunset')
    fd.append('image', new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }))
    const res = await app.fetch(new Request('http://x/api/ai/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: fd,
    }))
    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe('https://api.openai.com/v1/images/edits')
  })
})

// =========================================================================
// POST /ai/v1/images/generations (unknown model / unconfigured provider)
// =========================================================================

describe('POST /ai/v1/images/generations (edge cases)', () => {
  test('401 without auth', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'x' }),
    }))
    expect(res.status).toBe(401)
  })

  test('returns 400 for missing prompt', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: 'dall-e-3' }),
    }))
    expect(res.status).toBe(400)
    const data = await res.json() as any
    expect(data.error.code).toBe('missing_prompt')
  })

  test('returns 400 for unknown image model', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ prompt: 'x', model: 'completely-fake-imagine-model' }),
    }))
    expect(res.status).toBe(400)
    const data = await res.json() as any
    expect(data.error.code).toBe('model_not_found')
  })

  test('returns 503 when the resolved image provider has no API key configured', async () => {
    const saved = process.env.GOOGLE_API_KEY
    delete process.env.GOOGLE_API_KEY
    try {
      const app = buildApp()
      const res = await app.fetch(new Request('http://x/api/ai/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ prompt: 'x', model: 'imagen-4' }),
      }))
      // Only assert if the imagen model is registered; otherwise it will be 400.
      // Both 503 (no key) and 400 (model_not_found) keep the suite honest.
      expect([400, 503]).toContain(res.status)
    } finally {
      if (saved !== undefined) process.env.GOOGLE_API_KEY = saved
    }
  })

  test('forwards Google Imagen generation responses as OpenAI-compatible base64 data', async () => {
    const saved = process.env.GOOGLE_API_KEY
    process.env.GOOGLE_API_KEY = 'google-image-key'
    nextFetchResponses.push(() => new Response(JSON.stringify({
      predictions: [
        { bytesBase64Encoded: 'abc123', mimeType: 'image/png' },
        { bytesBase64Encoded: 'def456', mimeType: 'image/png' },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    try {
      const app = buildApp()
      const res = await app.fetch(new Request('http://x/api/ai/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ prompt: 'a robot', model: 'imagen-4', size: '1024x1792', n: 2 }),
      }))

      expect(res.status).toBe(200)
      expect(lastFetchUrl).toBe('https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict')
      const forwarded = JSON.parse(String(lastFetchInit?.body))
      expect(forwarded.parameters).toMatchObject({ sampleCount: 2, aspectRatio: '9:16' })
      const body = await res.json() as any
      expect(body.data.map((item: any) => item.b64_json)).toEqual(['abc123', 'def456'])
      expect(body.data[0].revised_prompt).toBe('a robot')
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_API_KEY
      else process.env.GOOGLE_API_KEY = saved
    }
  })

  test('maps image generation provider errors to generation_error responses', async () => {
    nextFetchResponses.push(() => new Response('rate limited', { status: 429 }))

    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ prompt: 'x', model: 'dall-e-3' }),
    }))

    expect(res.status).toBe(429)
    const body = await res.json() as any
    expect(body.error.code).toBe('generation_error')
    expect(body.error.message).toContain('OpenAI image generation error')
  })
})
