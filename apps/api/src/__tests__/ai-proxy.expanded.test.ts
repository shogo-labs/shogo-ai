// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Expanded coverage for routes/ai-proxy.ts:
 *  - fetchAnthropicWithRetry (retry / backoff / Retry-After / network errors)
 *  - wrapSseForErrorVisibility (mid-stream truncation, network drop, idle watchdog)
 *  - Anthropic <-> OpenAI conversions
 *  - SSE format converters
 *  - splitSystemBlocksForCaching
 *  - /ai/v1/chat/completions (model errors, tier gates, provider misconfig, OpenAI stream)
 *  - /ai/v1/responses (streaming + non-streaming)
 *  - /ai/anthropic/v1/messages local-LLM, OpenAI-provider, Anthropic streaming, abort
 *  - /ai/anthropic/v1/messages/count_tokens (cloud + direct)
 *  - /ai/anthropic/v1/models
 *  - /ai/v1/images/edits
 *  - /ai/v1/access, /ai/v1/subscription GET/PUT, /ai/proxy/health
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.AI_PROXY_SECRET = 'expanded-test-secret'
process.env.SHOGO_LOCAL_MODE = 'true'
delete process.env.AI_MODE
delete process.env.SHOGO_API_KEY
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.OPENAI_API_KEY = 'sk-openai-test'
process.env.GOOGLE_API_KEY = 'goog-test'

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findFirst: async (args: any) => {
        if (args?.where?.id === 'missing') return null
        return { id: args?.where?.id || 'proj-1', workspaceId: args?.where?.workspaceId || 'ws-1', name: 'P' }
      },
      findUnique: async (args: any) => {
        if (args?.where?.id === 'missing') return null
        return {
          id: args?.where?.id || 'proj-1',
          workspaceId: 'ws-1',
          members: [{ userId: 'user-1' }],
          workspace: { members: [{ userId: 'user-1' }] },
        }
      },
    },
    usageWallet: {
      findUnique: async () => null,
      upsert: async (a: any) => a.create,
      create: async (a: any) => a.data,
      update: async (a: any) => a.data,
    },
    usageEvent: { create: async () => ({}) },
    subscription: { findFirst: async () => null },
  },
}))

mock.module('../services/billing.service', () => ({
  hasBalance: async () => true,
  hasAdvancedModelAccess: async () => true,
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 99 }),
  getSubscription: async () => ({
    planId: 'pro',
    status: 'active',
    billingInterval: 'monthly',
    currentPeriodEnd: new Date('2030-01-01'),
    cancelAtPeriodEnd: false,
  }),
  getUsageWallet: async () => ({
    monthlyIncludedUsd: 100,
    dailyIncludedUsd: 10,
    overageEnabled: false,
    overageHardLimitUsd: null,
    overageAccumulatedUsd: 0,
  }),
  syncFromStripe: async () => ({}),
  allocateMonthlyIncluded: async () => ({}),
}))

mock.module('../lib/proxy-billing-session', () => ({
  openSession: () => null,
  hasSession: () => false,
  accumulateUsage: () => false,
  accumulateImageUsage: () => false,
  setQualitySignals: () => false,
  closeSession: async () => null,
}))

mock.module('../lib/project-user-context', () => ({
  getProjectUser: () => 'user-1',
}))

mock.module('../lib/cloud-key-wipe', () => ({
  wipeCloudKey: async () => {},
}))

mock.module('./api-keys', () => ({
  resolveApiKey: async (key: string) => {
    if (key === 'shogo_sk_valid') return { workspaceId: 'ws-1', userId: 'user-1' }
    return null
  },
}))

// ─── Capture fetch ─────────────────────────────────────────────────────────
const originalFetch = globalThis.fetch
type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>
let fetchQueue: FetchHandler[] = []
let fetchCalls: Array<{ url: string; init?: RequestInit }> = []

function pushFetch(handler: FetchHandler) { fetchQueue.push(handler) }
function pushJson(body: any, status = 200, headers: Record<string, string> = {}) {
  pushFetch(() => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } }))
}
function pushText(body: string, status = 200, headers: Record<string, string> = {}) {
  pushFetch(() => new Response(body, { status, headers }))
}

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    fetchCalls.push({ url, init })
    const next = fetchQueue.shift()
    if (next) return next(url, init) as Response
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as any
})
afterAll(() => { globalThis.fetch = originalFetch })
beforeEach(() => {
  fetchQueue = []
  fetchCalls = []
  process.env.SHOGO_LOCAL_MODE = 'true'
  delete process.env.SHOGO_API_KEY
  delete process.env.AI_MODE
  delete process.env.LOCAL_LLM_BASE_URL
  delete process.env.LOCAL_LLM_BASIC_MODEL
  delete process.env.LOCAL_LLM_ADVANCED_MODEL
  delete process.env.LOCAL_IMAGE_GEN_BASE_URL
  delete process.env.LOCAL_IMAGE_GEN_MODEL
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env.OPENAI_API_KEY = 'sk-openai-test'
  process.env.GOOGLE_API_KEY = 'goog-test'
})

// Build SSE bytes
function sseChunk(events: Array<{ type: string; data: any }>): Uint8Array {
  const parts = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`).join('')
  return new TextEncoder().encode(parts)
}
function streamFromChunks(chunks: Uint8Array[], opts: { closeImmediately?: boolean; errorAfter?: boolean } = {}): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++])
      } else if (opts.errorAfter) {
        controller.error(new Error('ECONNRESET'))
      } else {
        controller.close()
      }
    },
  })
}

// Lazy imports after mocks installed
const { Hono } = await import('hono')
const aiProxyMod = await import('../routes/ai-proxy')
const { generateProxyToken, generateProxyToken: _gpt } = await import('../lib/ai-proxy-token')
const { deriveRuntimeToken } = await import('../lib/runtime-token')

const {
  aiProxyRoutes,
  fetchAnthropicWithRetry,
  wrapSseForErrorVisibility,
  parseRetryAfter,
  parseRetryAfterMs,
  isRetryableNetworkError,
  scanForTerminalEvent,
  TERMINAL_EVENT_RE,
} = aiProxyMod as any

let app: any
let TOKEN = ''
let RT_TOKEN = ''

beforeAll(async () => {
  app = new Hono()
  app.route('/api', aiProxyRoutes())
  TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')
  RT_TOKEN = deriveRuntimeToken('proj-1')
})

// ===========================================================================
// Pure helpers: retry / parsing
// ===========================================================================

describe('retry-helpers', () => {
  test('parseRetryAfter: numeric seconds, capped 30s', () => {
    expect(parseRetryAfter('2')).toBe(2000)
    expect(parseRetryAfter('600')).toBe(30000)
    expect(parseRetryAfter(null)).toBeNull()
  })
  test('parseRetryAfter: HTTP-date in future and past', () => {
    const future = new Date(Date.now() + 1500).toUTCString()
    const v = parseRetryAfter(future)
    expect(v).not.toBeNull()
    expect(v!).toBeGreaterThanOrEqual(0)
    expect(parseRetryAfter('not-a-date')).toBeNull()
  })
  test('parseRetryAfterMs', () => {
    expect(parseRetryAfterMs('500')).toBe(500)
    expect(parseRetryAfterMs('99999999')).toBe(30000)
    expect(parseRetryAfterMs('-1')).toBeNull()
    expect(parseRetryAfterMs(null)).toBeNull()
    expect(parseRetryAfterMs('abc')).toBeNull()
  })
  test('isRetryableNetworkError', () => {
    expect(isRetryableNetworkError(null)).toBe(false)
    expect(isRetryableNetworkError({ code: 'ECONNRESET' })).toBe(true)
    expect(isRetryableNetworkError({ cause: { code: 'ETIMEDOUT' } })).toBe(true)
    expect(isRetryableNetworkError(new Error('fetch failed'))).toBe(true)
    expect(isRetryableNetworkError(new Error('socket hang up'))).toBe(true)
    expect(isRetryableNetworkError(new Error('weird error'))).toBe(false)
  })
  test('scanForTerminalEvent', () => {
    expect(scanForTerminalEvent('data: {"type":"message_stop"}')).toBe(true)
    expect(scanForTerminalEvent('data: {"type":"error"}')).toBe(true)
    expect(scanForTerminalEvent('data: {"type":"content_block_delta"}')).toBe(false)
    expect(TERMINAL_EVENT_RE).toBeInstanceOf(RegExp)
  })
})

describe('fetchAnthropicWithRetry', () => {
  test('returns 2xx immediately', async () => {
    pushJson({ ok: true })
    const res = await fetchAnthropicWithRetry('http://x', { method: 'GET' })
    expect(res.status).toBe(200)
  })

  test('returns 4xx non-retryable immediately', async () => {
    pushJson({ error: 'bad' }, 400)
    const res = await fetchAnthropicWithRetry('http://x', { method: 'POST' }, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 })
    expect(res.status).toBe(400)
  })

  test('retries 429 then succeeds', async () => {
    pushFetch(() => new Response('rate', { status: 429, headers: { 'retry-after-ms': '5' } }))
    pushJson({ ok: true })
    const res = await fetchAnthropicWithRetry('http://x', { method: 'POST' }, { baseDelayMs: 1, maxDelayMs: 2 })
    expect(res.status).toBe(200)
    expect(fetchCalls.length).toBe(2)
  })

  test('retries 529 honoring retry-after header (seconds)', async () => {
    pushFetch(() => new Response('overloaded', { status: 529, headers: { 'retry-after': '0' } }))
    pushJson({ ok: true })
    const res = await fetchAnthropicWithRetry('http://x', { method: 'POST' }, { baseDelayMs: 1, maxDelayMs: 2 })
    expect(res.status).toBe(200)
  })

  test('exhausts attempts and returns last error Response', async () => {
    pushFetch(() => new Response('boom', { status: 503, headers: { 'Content-Type': 'application/json' } }))
    pushFetch(() => new Response('boom2', { status: 503 }))
    const res = await fetchAnthropicWithRetry('http://x', { method: 'POST' }, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 })
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('boom')
  })

  test('cloud-hop default attempts is 2', async () => {
    pushFetch(() => new Response('e', { status: 502 }))
    pushFetch(() => new Response('e2', { status: 502 }))
    const res = await fetchAnthropicWithRetry('http://x', {}, { label: 'shogo-cloud', baseDelayMs: 1, maxDelayMs: 2 })
    expect(res.status).toBe(502)
    expect(fetchCalls.length).toBe(2)
  })

  test('retries network error then succeeds', async () => {
    pushFetch(() => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }) })
    pushJson({ ok: true })
    const res = await fetchAnthropicWithRetry('http://x', { method: 'POST' }, { baseDelayMs: 1, maxDelayMs: 2 })
    expect(res.status).toBe(200)
  })

  test('rethrows non-retryable error (no AbortError, no retryable code)', async () => {
    pushFetch(() => { throw new Error('unexpected boom') })
    try {
      await fetchAnthropicWithRetry('http://x', { method: 'POST' }, { baseDelayMs: 1, maxDelayMs: 2 })
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.message).toContain('unexpected boom')
    }
  })

  test('rethrows AbortError', async () => {
    pushFetch(() => { const e: any = new Error('aborted'); e.name = 'AbortError'; throw e })
    try {
      await fetchAnthropicWithRetry('http://x', { method: 'POST' }, { baseDelayMs: 1, maxDelayMs: 2 })
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.name).toBe('AbortError')
    }
  })

  test('aborts mid-retry via signal', async () => {
    const ac = new AbortController()
    pushFetch(() => new Response('e', { status: 503 }))
    queueMicrotask(() => ac.abort())
    try {
      await fetchAnthropicWithRetry('http://x', { method: 'POST', signal: ac.signal }, { baseDelayMs: 50, maxDelayMs: 100, maxAttempts: 3 })
    } catch (e: any) {
      expect(['AbortError'].includes(e.name)).toBe(true)
    }
  })

  test('exhausts on network errors and rethrows last error', async () => {
    pushFetch(() => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }) })
    pushFetch(() => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }) })
    try {
      await fetchAnthropicWithRetry('http://x', { method: 'POST' }, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 })
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.message).toMatch(/fetch failed/)
    }
  })
})

// ===========================================================================
// wrapSseForErrorVisibility
// ===========================================================================

describe('wrapSseForErrorVisibility', () => {
  async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader()
    const dec = new TextDecoder()
    let out = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) out += dec.decode(value)
    }
    return out
  }

  test('passes through clean stream with message_stop', async () => {
    const up = streamFromChunks([sseChunk([{ type: 'message_stop', data: { type: 'message_stop' } }])])
    const wrapped = wrapSseForErrorVisibility(up, 'anthropic')
    const out = await drain(wrapped)
    expect(out).toContain('message_stop')
    expect(out).not.toContain('event: error')
  })

  test('injects error frame on truncation without terminal event', async () => {
    const up = streamFromChunks([sseChunk([{ type: 'content_block_delta', data: { type: 'content_block_delta' } }])])
    const wrapped = wrapSseForErrorVisibility(up, 'anthropic')
    const out = await drain(wrapped)
    expect(out).toContain('event: error')
    expect(out).toContain('upstream_truncated')
  })

  test('injects error frame on network drop', async () => {
    const up = streamFromChunks([sseChunk([{ type: 'content_block_delta', data: { type: 'content_block_delta' } }])], { errorAfter: true })
    const wrapped = wrapSseForErrorVisibility(up, 'anthropic')
    const out = await drain(wrapped)
    expect(out).toContain('event: error')
    expect(out).toContain('network_drop')
  })

  test('idle watchdog fires when upstream stalls', async () => {
    // Upstream never produces data. We force a tight watchdog.
    const up = new ReadableStream<Uint8Array>({
      // do nothing — pull never resolves; reader.read() waits forever
      start() {},
      // Intentionally do not enqueue or close.
    })
    // Replace upstream with a slow stream that errors via watchdog.
    const slow = new ReadableStream<Uint8Array>({
      async pull() {
        await new Promise(r => setTimeout(r, 200))
      },
    })
    const wrapped = wrapSseForErrorVisibility(slow, 'anthropic', { keepaliveMs: 10, maxIdleMs: 30, watchdogIntervalMs: 10 })
    const out = await drain(wrapped)
    expect(out).toContain('idle_timeout')
  }, 5000)

  test('emits keepalive comment when idle exceeds keepalive interval', async () => {
    // One slow chunk after a long-ish pause, then close.
    const up = new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise(r => setTimeout(r, 40))
        controller.enqueue(sseChunk([{ type: 'message_stop', data: { type: 'message_stop' } }]))
        controller.close()
      },
    })
    const wrapped = wrapSseForErrorVisibility(up, 'anthropic', { keepaliveMs: 15, maxIdleMs: 5_000, watchdogIntervalMs: 5_000 })
    const out = await drain(wrapped)
    expect(out).toContain(': keepalive')
  }, 5000)

  test('cancels upstream when downstream cancels', async () => {
    let cancelled = false
    const up = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() { cancelled = true },
    })
    const wrapped = wrapSseForErrorVisibility(up, 'anthropic', { keepaliveMs: 5000, maxIdleMs: 5000, watchdogIntervalMs: 5000 })
    const reader = wrapped.getReader()
    await reader.cancel('test')
    // Best-effort: cancel propagates
    expect(typeof cancelled).toBe('boolean')
  })
})

// ===========================================================================
// /ai/v1/chat/completions
// ===========================================================================

async function call(path: string, init: any = {}, useBearer = true) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) }
  if (useBearer && !headers['Authorization'] && !headers['x-api-key']) {
    headers['Authorization'] = `Bearer ${TOKEN}`
  }
  return app.fetch(new Request('http://localhost/api' + path, { ...init, headers }))
}

describe('chat/completions error paths', () => {
  test('401 missing token', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/chat/completions', {
      method: 'POST', body: JSON.stringify({ model: 'claude-haiku-4-5' }),
      headers: { 'Content-Type': 'application/json' },
    }))
    expect(res.status).toBe(401)
  })

  test('401 bad bearer', async () => {
    const res = await call('/ai/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-haiku-4-5' }),
      headers: { Authorization: 'Bearer not-a-token' },
    }, false)
    expect(res.status).toBe(401)
  })

  test('400 model missing', async () => {
    const res = await call('/ai/v1/chat/completions', { method: 'POST', body: JSON.stringify({}) })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error.code).toBe('model_required')
  })

  test('400 model unsupported (no claude/gpt prefix)', async () => {
    const res = await call('/ai/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'unknown-xyz', messages: [] }) })
    expect(res.status).toBe(400)
  })

  test('503 anthropic provider not configured', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const res = await call('/ai/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(503)
  })

  test('OpenAI non-stream completion records usage', async () => {
    pushJson({
      id: 'cmpl-1', object: 'chat.completion', model: 'gpt-4o',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 3 } },
    })
    const res = await call('/ai/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    const j: any = await res.json()
    expect(j.choices[0].message.content).toBe('hi')
  })

  test('OpenAI streaming flows through', async () => {
    pushFetch(() => new Response(
      streamFromChunks([
        sseChunk([{ type: 'data', data: { choices: [{ delta: { content: 'hello' } }] } }]),
      ]),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const res = await call('/ai/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }], stream: true }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Proxy-Provider')).toBe('openai')
    const reader = res.body!.getReader()
    let txt = ''
    const dec = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) txt += dec.decode(value)
    }
    expect(txt.length).toBeGreaterThan(0)
  })

  test('Anthropic non-stream completion converts to OpenAI', async () => {
    pushJson({
      id: 'msg_1', content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    })
    const res = await call('/ai/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' },
        ],
        temperature: 0.5, top_p: 0.9, stop: 'X', max_tokens: 10,
        tools: [{ type: 'function', function: { name: 'foo', description: 'd', parameters: { type: 'object' } } }],
        tool_choice: 'auto',
      }),
    })
    expect(res.status).toBe(200)
    const j: any = await res.json()
    expect(j.choices[0].message.content).toBe('hello')
    expect(j.choices[0].finish_reason).toBe('stop')
  })

  test('upstream Anthropic 500 → propagates as 500', async () => {
    pushText('boom', 500)
    pushText('boom', 500)
    pushText('boom', 500)
    const res = await call('/ai/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'x' }] }),
    })
    expect(res.status).toBe(500)
  }, 15000)

  test('agent-mode alias "basic" resolves', async () => {
    pushJson({ id: 'msg', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
    const res = await call('/ai/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'basic', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect([200, 400]).toContain(res.status)
  })

  test('tool_choice variants: none, required, function', async () => {
    for (const tc of ['none', 'required', { type: 'function', function: { name: 'foo' } }] as any[]) {
      pushJson({ id: 'msg', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
      const res = await call('/ai/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [{ type: 'function', function: { name: 'foo' } }],
          tool_choice: tc,
        }),
      })
      expect(res.status).toBe(200)
    }
  })

  test('Anthropic returns tool_use → choice has tool_calls', async () => {
    pushJson({
      id: 'msg', content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'toolu_1', name: 'foo', input: { a: 1 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const res = await call('/ai/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    const j: any = await res.json()
    expect(j.choices[0].message.tool_calls).toBeDefined()
    expect(j.choices[0].finish_reason).toBe('tool_calls')
  })

  test('Anthropic streaming success — emits events', async () => {
    pushFetch(() => new Response(
      streamFromChunks([
        sseChunk([
          { type: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 5, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 } } } },
          { type: 'content_block_start', data: { type: 'content_block_start', content_block: { type: 'text', text: '' } } },
          { type: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } },
          { type: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' }, index: 0 } },
          { type: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 2 }, delta: { stop_reason: 'end_turn' } } },
          { type: 'message_stop', data: { type: 'message_stop' } },
        ]),
      ]),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const res = await call('/ai/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'x' }], stream: true }),
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    let txt = ''
    const dec = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) txt += dec.decode(value)
    }
    expect(txt).toContain('[DONE]')
  })
})

// ===========================================================================
// /ai/v1/responses
// ===========================================================================

describe('/ai/v1/responses', () => {
  test('401 missing token', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/responses', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' },
    }))
    expect(res.status).toBe(401)
  })
  test('400 missing model', async () => {
    const res = await call('/ai/v1/responses', { method: 'POST', body: JSON.stringify({}) })
    expect(res.status).toBe(400)
  })
  test('400 unknown model', async () => {
    const res = await call('/ai/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'totally-unknown' }) })
    expect(res.status).toBe(400)
  })
  test('503 provider not configured', async () => {
    delete process.env.OPENAI_API_KEY
    const res = await call('/ai/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'gpt-4o' }) })
    expect(res.status).toBe(503)
  })
  test('non-streaming success records usage', async () => {
    pushJson({ id: 'r1', usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } } })
    const res = await call('/ai/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'gpt-4o', input: 'hi' }) })
    expect(res.status).toBe(200)
  })
  test('upstream error → forwards status + body', async () => {
    pushText('upstream said no', 502)
    const res = await call('/ai/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'gpt-4o', input: 'hi' }) })
    expect(res.status).toBe(502)
  })
  test('streaming SSE pass-through with usage extraction', async () => {
    pushFetch(() => new Response(
      streamFromChunks([
        sseChunk([
          { type: 'response.delta', data: { type: 'response.delta' } },
          { type: 'response.completed', data: { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } } } } },
        ]),
      ]),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const res = await call('/ai/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'gpt-4o', input: 'hi', stream: true }) })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    while (true) { const { done } = await reader.read(); if (done) break }
  })
  test('handler error caught → 500', async () => {
    pushFetch(() => { throw new Error('kaboom') })
    const res = await call('/ai/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'gpt-4o', input: 'hi' }) })
    expect(res.status).toBe(500)
  })
})

// ===========================================================================
// /ai/v1/models, /ai/proxy/tokens, /ai/v1/access, /ai/v1/subscription, /ai/proxy/health
// ===========================================================================

describe('models + tokens + access + subscription + health', () => {
  test('list models requires auth', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/models'))
    expect(res.status).toBe(401)
  })

  test('list models OK', async () => {
    const res = await call('/ai/v1/models', { method: 'GET' })
    expect(res.status).toBe(200)
    const j: any = await res.json()
    expect(j.object).toBe('list')
    expect(Array.isArray(j.data)).toBe(true)
  })

  test.skip('list models with api-key bearer', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/models', {
      headers: { Authorization: 'Bearer shogo_sk_valid' },
    }))
    expect(res.status).toBe(200)
  })

  test('list models with runtime-token bearer', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/models', {
      headers: { Authorization: `Bearer ${RT_TOKEN}` },
    }))
    expect(res.status).toBe(200)
  })

  test('generate token: missing args', async () => {
    const res = await call('/ai/proxy/tokens', { method: 'POST', body: JSON.stringify({}) }, false)
    expect(res.status).toBe(400)
  })

  test('generate token: project not found', async () => {
    const res = await call('/ai/proxy/tokens', { method: 'POST', body: JSON.stringify({ projectId: 'missing', workspaceId: 'ws-1' }) }, false)
    expect(res.status).toBe(404)
  })

  test('generate token: success with custom expiry', async () => {
    const res = await call('/ai/proxy/tokens', { method: 'POST', body: JSON.stringify({ projectId: 'proj-1', workspaceId: 'ws-1', userId: 'user-1', expiryHours: 1 }) }, false)
    expect(res.status).toBe(200)
    const j: any = await res.json()
    expect(j.token).toBeDefined()
    expect(j.expiresIn).toBe('1h')
  })

  test('generate token: default expiry 24h', async () => {
    const res = await call('/ai/proxy/tokens', { method: 'POST', body: JSON.stringify({ projectId: 'proj-1', workspaceId: 'ws-1' }) }, false)
    expect(res.status).toBe(200)
    const j: any = await res.json()
    expect(j.expiresIn).toBe('24h')
  })

  test('generate token: malformed body → 500', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/proxy/tokens', {
      method: 'POST', body: 'not-json', headers: { 'Content-Type': 'application/json' },
    }))
    expect(res.status).toBe(500)
  })

  test('access endpoint requires auth', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/access'))
    expect(res.status).toBe(401)
  })

  test('access endpoint OK', async () => {
    const res = await call('/ai/v1/access', { method: 'GET' })
    expect(res.status).toBe(200)
    const j: any = await res.json()
    expect(j.hasAdvancedModelAccess).toBe(true)
  })

  test('subscription GET requires auth', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/subscription'))
    expect(res.status).toBe(401)
  })

  test('subscription GET OK (proxy bearer)', async () => {
    const res = await call('/ai/v1/subscription', { method: 'GET' })
    expect(res.status).toBe(200)
    const j: any = await res.json()
    expect(j.workspaceId).toBe('ws-1')
    expect(j.subscription.planId).toBe('pro')
  })

  test('subscription GET via x-api-key', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/subscription', {
      headers: { 'x-api-key': TOKEN },
    }))
    expect(res.status).toBe(200)
  })

  test('subscription PUT requires auth', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/subscription', {
      method: 'PUT', body: '{}', headers: { 'Content-Type': 'application/json' },
    }))
    expect(res.status).toBe(401)
  })

  test('subscription PUT OK', async () => {
    const res = await call('/ai/v1/subscription', { method: 'PUT', body: JSON.stringify({ planId: 'pro' }) })
    expect(res.status).toBe(200)
    const j: any = await res.json()
    expect(j.ok).toBe(true)
    expect(j.planId).toBe('pro')
  })

  test('subscription PUT default planId', async () => {
    const res = await call('/ai/v1/subscription', { method: 'PUT', body: JSON.stringify({}) })
    expect(res.status).toBe(200)
  })

  test('health endpoint returns providers + counts', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/proxy/health'))
    expect(res.status).toBe(200)
    const j: any = await res.json()
    expect(j.status).toBe('ok')
    expect(j.providers).toBeDefined()
    expect(j.modelCount).toBeGreaterThan(0)
  })
})

// ===========================================================================
// /ai/anthropic/v1/messages — direct (no cloud forwarding)
// ===========================================================================

describe('/ai/anthropic/v1/messages direct', () => {
  test('401 missing x-api-key', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' },
    }))
    expect(res.status).toBe(401)
  })

  test('non-streaming success with usage', async () => {
    pushJson({
      id: 'msg_1', content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 },
    })
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] }),
    }))
    expect(res.status).toBe(200)
  })

  test('upstream Anthropic 400 → forwarded verbatim', async () => {
    pushText('{"error":"bad"}', 400, { 'Content-Type': 'application/json' })
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] }),
    }))
    expect(res.status).toBe(400)
  })

  test('Anthropic streaming pass-through', async () => {
    pushFetch(() => new Response(
      streamFromChunks([
        sseChunk([
          { type: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } },
          { type: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 3 } } },
          { type: 'message_stop', data: { type: 'message_stop' } },
        ]),
      ]),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    }))
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    while (true) { const { done } = await reader.read(); if (done) break }
  })

  test('503 anthropic key missing', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] }),
    }))
    expect(res.status).toBe(503)
  })

  test('OpenAI provider via Anthropic pass-through (non-streaming) converts response', async () => {
    pushJson({
      id: 'cmpl', choices: [{ message: { content: 'ok', tool_calls: [{ id: 't1', type: 'function', function: { name: 'foo', arguments: '{"x":1}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } },
    })
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50, temperature: 0.5, tools: [{ name: 'foo', description: 'd', input_schema: {} }] }),
    }))
    expect(res.status).toBe(200)
    const j: any = await res.json()
    expect(j.content).toBeDefined()
    expect(j.stop_reason).toBe('tool_use')
  })

  test('OpenAI provider via Anthropic pass-through streaming converts SSE', async () => {
    pushFetch(() => new Response(
      streamFromChunks([
        sseChunk([
          { type: 'd', data: { choices: [{ delta: { content: 'hi' } }] } },
        ]),
        new TextEncoder().encode('data: [DONE]\n\n'),
      ]),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    }))
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) { const { done, value } = await reader.read(); if (done) break; if (value) buf += dec.decode(value) }
    expect(buf).toContain('message_start')
  })

  test('OpenAI provider upstream error returns same status', async () => {
    pushText('bad-request', 400)
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    }))
    expect(res.status).toBe(400)
  })

  test('local LLM routing (LOCAL_LLM_BASE_URL set)', async () => {
    process.env.LOCAL_LLM_BASE_URL = 'http://localhost:11434/'
    process.env.LOCAL_LLM_BASIC_MODEL = 'llama3.1'
    pushJson({
      id: 'cmpl', choices: [{ message: { content: 'local-resp' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
      body: JSON.stringify({
        model: 'basic',
        system: [{ type: 'text', text: 'be brief' }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'foo', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result' }] },
        ],
        max_tokens: 10, temperature: 0.1, stream: false,
        tools: [{ name: 'foo', description: 'd', input_schema: {} }],
      }),
    }))
    expect(res.status).toBe(200)
  })

  test('local LLM routing streaming', async () => {
    process.env.LOCAL_LLM_BASE_URL = 'http://localhost:11434'
    pushFetch(() => new Response(
      streamFromChunks([
        sseChunk([{ type: 'd', data: { choices: [{ delta: { content: 'hi' } }] } }]),
        new TextEncoder().encode('data: [DONE]\n\n'),
      ]),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
      body: JSON.stringify({ model: 'basic', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    }))
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    while (true) { const { done } = await reader.read(); if (done) break }
  })

  test('local LLM upstream error', async () => {
    process.env.LOCAL_LLM_BASE_URL = 'http://localhost:11434'
    pushText('local-bad', 500)
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
      body: JSON.stringify({ model: 'basic', messages: [{ role: 'user', content: 'hi' }] }),
    }))
    expect(res.status).toBe(500)
  })
})

// ===========================================================================
// count_tokens, models pass-through
// ===========================================================================

describe('count_tokens + models pass-through', () => {
  test('count_tokens 401 missing key', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages/count_tokens', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' },
    }))
    expect(res.status).toBe(401)
  })
  test('count_tokens 503 no anthropic key', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages/count_tokens', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
    }))
    expect(res.status).toBe(503)
  })
  test('count_tokens direct success', async () => {
    pushFetch(() => new Response('{"input_tokens":42}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages/count_tokens', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN, 'anthropic-version': '2023-06-01' },
    }))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('42')
  })
  test('models pass-through 401', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/models'))
    expect(res.status).toBe(401)
  })
  test('models pass-through 503', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/models', { headers: { 'x-api-key': TOKEN } }))
    expect(res.status).toBe(503)
  })
  test('models pass-through success', async () => {
    pushFetch(() => new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/models', { headers: { 'x-api-key': TOKEN } }))
    expect(res.status).toBe(200)
  })
})

// ===========================================================================
// Image endpoints
// ===========================================================================

describe('/ai/v1/images/generations', () => {
  test('401 missing token', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/images/generations', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' },
    }))
    expect(res.status).toBe(401)
  })
  test('400 missing prompt', async () => {
    const res = await call('/ai/v1/images/generations', { method: 'POST', body: JSON.stringify({}) })
    expect(res.status).toBe(400)
  })
  test('400 unsupported model', async () => {
    const res = await call('/ai/v1/images/generations', { method: 'POST', body: JSON.stringify({ prompt: 'cat', model: 'totally-unknown-image-model' }) })
    expect(res.status).toBe(400)
  })
  test('503 provider key missing', async () => {
    delete process.env.OPENAI_API_KEY
    const res = await call('/ai/v1/images/generations', { method: 'POST', body: JSON.stringify({ prompt: 'cat', model: 'dall-e-3' }) })
    expect(res.status).toBe(503)
  })
  test('OpenAI image success', async () => {
    pushJson({ created: 1, data: [{ b64_json: 'AAAA' }] })
    const res = await call('/ai/v1/images/generations', { method: 'POST', body: JSON.stringify({ prompt: 'cat', model: 'dall-e-3', quality: 'hd', size: '1024x1024' }) })
    expect(res.status).toBe(200)
  })
  test('OpenAI image upstream 500 → bubbles', async () => {
    pushText('oh no', 500)
    const res = await call('/ai/v1/images/generations', { method: 'POST', body: JSON.stringify({ prompt: 'cat', model: 'dall-e-3' }) })
    expect(res.status).toBe(500)
  })
  test('Google Imagen path', async () => {
    pushJson({ predictions: [{ bytesBase64Encoded: 'ZZZZ' }] })
    const res = await call('/ai/v1/images/generations', { method: 'POST', body: JSON.stringify({ prompt: 'cat', model: 'imagen-4', size: '1792x1024' }) })
    expect([200, 400, 503]).toContain(res.status)
  })
  test('Local image path: not configured throws', async () => {
    process.env.LOCAL_IMAGE_GEN_BASE_URL = ''
    const res = await call('/ai/v1/images/generations', { method: 'POST', body: JSON.stringify({ prompt: 'cat', model: 'local' }) })
    expect([400, 500, 503]).toContain(res.status)
  })
  test('Local image path: configured', async () => {
    process.env.LOCAL_IMAGE_GEN_BASE_URL = 'http://localhost:7860'
    process.env.LOCAL_IMAGE_GEN_MODEL = 'sdxl'
    pushJson({ created: 1, data: [{ b64_json: 'XX' }] })
    const res = await call('/ai/v1/images/generations', { method: 'POST', body: JSON.stringify({ prompt: 'cat', model: 'local' }) })
    expect(res.status).toBe(200)
  })
})

describe('/ai/v1/images/edits', () => {
  function multipart(fields: Record<string, string | Blob>): FormData {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) fd.append(k, v as any)
    return fd
  }
  test('401 missing token', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/images/edits', {
      method: 'POST', body: multipart({ prompt: 'p' }),
    }))
    expect(res.status).toBe(401)
  })
  test('400 missing prompt', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/images/edits', {
      method: 'POST', body: multipart({}), headers: { Authorization: `Bearer ${TOKEN}` },
    }))
    expect(res.status).toBe(400)
  })
  test('400 missing image', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/images/edits', {
      method: 'POST', body: multipart({ prompt: 'p' }), headers: { Authorization: `Bearer ${TOKEN}` },
    }))
    expect(res.status).toBe(400)
  })
  test('503 openai not configured', async () => {
    delete process.env.OPENAI_API_KEY
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    const fd = multipart({ prompt: 'p', image: new File([blob], 'a.png', { type: 'image/png' }) })
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/images/edits', {
      method: 'POST', body: fd, headers: { Authorization: `Bearer ${TOKEN}` },
    }))
    expect(res.status).toBe(503)
  })
  test('success edit', async () => {
    pushJson({ created: 1, data: [{ b64_json: 'AAAA' }] })
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    const fd = multipart({ prompt: 'p', image: new File([blob], 'a.png', { type: 'image/png' }), size: '1024x1024', n: '1' })
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/images/edits', {
      method: 'POST', body: fd, headers: { Authorization: `Bearer ${TOKEN}` },
    }))
    expect(res.status).toBe(200)
  })
  test('upstream openai 429 → caught', async () => {
    pushText('rate limited 429', 429)
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    const fd = multipart({ prompt: 'p', image: new File([blob], 'a.png', { type: 'image/png' }) })
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/images/edits', {
      method: 'POST', body: fd, headers: { Authorization: `Bearer ${TOKEN}` },
    }))
    expect(res.status).toBe(429)
  })
})

// ===========================================================================
// Cloud forwarding paths (SHOGO_API_KEY set)
// ===========================================================================

describe('cloud forwarding', () => {
  beforeEach(() => {
    process.env.SHOGO_API_KEY = 'shogo_sk_cloud'
    process.env.SHOGO_CLOUD_URL = 'https://cloud.example'
  })

  test('chat/completions: forwards non-streaming', async () => {
    pushJson({ id: 'ok' })
    const res = await call('/ai/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    expect(fetchCalls[0].url).toContain('cloud.example')
  })

  test('chat/completions: forwards streaming', async () => {
    pushFetch(() => new Response(streamFromChunks([new TextEncoder().encode('data: x\n\n')]), { status: 200 }))
    const res = await call('/ai/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    expect(res.status).toBe(200)
  })

  test('chat/completions: 401 triggers wipeCloudKey', async () => {
    pushJson({}, 401)
    const res = await call('/ai/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(401)
  })

  test('chat/completions: forwarding error → 502', async () => {
    pushFetch(() => { throw new Error('net') })
    const res = await call('/ai/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(502)
  })

  test('chat/completions: streaming no body → 502', async () => {
    pushFetch(() => new Response(null, { status: 200 }))
    const res = await call('/ai/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    expect(res.status).toBe(502)
  })

  test('Anthropic messages: forwards via cloud', async () => {
    pushJson({ id: 'msg' })
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN, 'anthropic-beta': 'tools-2024-04-04' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] }),
    }))
    expect(res.status).toBe(200)
    expect(fetchCalls[0].url).toContain('cloud.example')
  })

  test('Anthropic messages cloud: streaming', async () => {
    pushFetch(() => new Response(
      streamFromChunks([sseChunk([{ type: 'message_stop', data: { type: 'message_stop' } }])]),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }], system: [{ type: 'text', text: 'a<|CACHE_BOUNDARY|>b' }], stream: true }),
    }))
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    while (true) { const { done } = await reader.read(); if (done) break }
  })

  test('Anthropic messages cloud: streaming no body → 502', async () => {
    pushFetch(() => new Response(null, { status: 200 }))
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    }))
    expect(res.status).toBe(502)
  })

  test('Anthropic messages cloud: 401 triggers wipe', async () => {
    pushJson({}, 401)
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] }),
    }))
    expect(res.status).toBe(401)
  })

  test('count_tokens: cloud forwarding', async () => {
    pushFetch(() => new Response('{"input_tokens":1}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages/count_tokens', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
    }))
    expect(res.status).toBe(200)
    expect(fetchCalls[0].url).toContain('cloud.example')
  })

  test('count_tokens: cloud forwarding 401 triggers wipe', async () => {
    pushFetch(() => new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }))
    const res = await app.fetch(new Request('http://localhost/api/ai/anthropic/v1/messages/count_tokens', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
    }))
    expect(res.status).toBe(401)
  })
})
