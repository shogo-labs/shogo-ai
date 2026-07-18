// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Extra coverage paths for routes/ai-proxy.ts that the existing 17 test files
 * leave uncovered:
 *   - `shogo_sk_*` Bearer auth path inside validateProxyAuthImpl,
 *     with and without the X-Shogo-Device-App-Version header
 *     (the one similar test in ai-proxy.expanded.test.ts is `test.skip`'d)
 *   - logCacheControlIfEnabled() body when AI_PROXY_LOG_CACHE=1
 *     (gated diagnostic helper, invoked from proxyAnthropicStream /
 *     proxyAnthropicNonStream which power /ai/v1/chat/completions when
 *     the resolved model is Anthropic)
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.AI_PROXY_SECRET = 'extra-paths-test-secret'
process.env.SHOGO_LOCAL_MODE = 'true'
process.env.AI_PROXY_LOG_CACHE = '1'
delete process.env.AI_MODE
delete process.env.SHOGO_API_KEY
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.OPENAI_API_KEY = 'sk-openai-test'

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'proj-1', workspaceId: 'ws-1', name: 'P' }),
      findUnique: async () => ({
        id: 'proj-1',
        workspaceId: 'ws-1',
        members: [{ userId: 'user-1' }],
        workspace: { members: [{ userId: 'user-1' }] },
      }),
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
  getSubscription: async () => null,
  getUsageWallet: async () => null,
  syncFromStripe: async () => ({}),
  allocateMonthlyIncluded: async () => ({}),
}))

mock.module('../lib/proxy-billing-session', () => ({
  openSession: () => null,
  hasSession: () => false,
  hasActiveSession: () => false,
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

// Capture the `extra` arg that resolveApiKey receives so we can assert the
// X-Shogo-Device-App-Version header was threaded through.
let lastResolveApiKeyArgs: { key: string; extra?: { deviceAppVersion?: string } } | null = null
mock.module('../routes/api-keys', () => ({
  resolveApiKey: async (key: string, extra?: { deviceAppVersion?: string }) => {
    lastResolveApiKeyArgs = { key, extra }
    if (key === 'shogo_sk_valid_extra') return { workspaceId: 'ws-1', userId: 'user-1' }
    if (key === 'shogo_sk_with_version') return { workspaceId: 'ws-1', userId: 'user-1' }
    return null
  },
}))

const originalFetch = globalThis.fetch
type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>
let fetchQueue: FetchHandler[] = []

function pushFetch(handler: FetchHandler) { fetchQueue.push(handler) }
function pushJson(body: any, status = 200) {
  pushFetch(() => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }))
}

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    void url; void init
    const next = fetchQueue.shift()
    if (next) return next(url, init) as Response
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as any
})
afterAll(() => { globalThis.fetch = originalFetch })

beforeEach(() => {
  fetchQueue = []
  lastResolveApiKeyArgs = null
  process.env.AI_PROXY_LOG_CACHE = '1'
})

const { Hono } = await import('hono')
const aiProxyMod = await import('../routes/ai-proxy')
const { aiProxyRoutes } = aiProxyMod as { aiProxyRoutes: () => any }

const app = new Hono()
app.route('/api', aiProxyRoutes())

// ============================================================================
// shogo_sk_ Bearer auth path (validateProxyAuthImpl)
// ============================================================================

describe('validateProxyAuthImpl — shogo_sk_ bearer', () => {
  test('GET /ai/v1/models authenticates with shogo_sk_ and no device header', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/models', {
      headers: { Authorization: 'Bearer shogo_sk_valid_extra' },
    }))
    expect(res.status).toBe(200)
    expect(lastResolveApiKeyArgs).not.toBeNull()
    expect(lastResolveApiKeyArgs!.key).toBe('shogo_sk_valid_extra')
    expect(lastResolveApiKeyArgs!.extra).toBeUndefined()
  })

  test('threads X-Shogo-Device-App-Version through to resolveApiKey', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/models', {
      headers: {
        Authorization: 'Bearer shogo_sk_with_version',
        'X-Shogo-Device-App-Version': '4.2.1',
      },
    }))
    expect(res.status).toBe(200)
    expect(lastResolveApiKeyArgs?.extra).toEqual({ deviceAppVersion: '4.2.1' })
  })

  test('rejects when shogo_sk_ key cannot be resolved', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/models', {
      headers: { Authorization: 'Bearer shogo_sk_unknown' },
    }))
    expect(res.status).toBe(401)
    expect(lastResolveApiKeyArgs?.key).toBe('shogo_sk_unknown')
  })
})

// ============================================================================
// logCacheControlIfEnabled — gated diagnostic helper
// ============================================================================

describe('logCacheControlIfEnabled (AI_PROXY_LOG_CACHE=1)', () => {
  let logs: string[]
  let originalLog: typeof console.log
  beforeAll(() => {
    originalLog = console.log
  })
  beforeEach(() => {
    logs = []
    console.log = (...args: any[]) => { logs.push(args.map(String).join(' ')) }
  })
  afterAll(() => {
    console.log = originalLog
  })

  test('logs system=string / blocks=0 on non-streaming Anthropic chat completion', async () => {
    pushJson({
      id: 'msg_1',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    })
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer shogo_sk_valid_extra',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 16,
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hello' },
        ],
      }),
    }))
    expect(res.status).toBe(200)
    const cacheLog = logs.find(l => l.includes('[AI Proxy] [cache:nonstream]'))
    expect(cacheLog).toBeDefined()
    expect(cacheLog!).toContain('system_cache_control=0')
    expect(cacheLog!).toContain('cache_control=0')
  })

  test('logs cache:stream on streaming Anthropic chat completion', async () => {
    pushFetch(() => new Response(
      new TextEncoder().encode(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg","usage":{"input_tokens":3,"output_tokens":0}}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      ),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer shogo_sk_valid_extra',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 16,
        stream: true,
        messages: [
          { role: 'user', content: 'hi' },
        ],
      }),
    }))
    expect(res.status).toBe(200)
    // Drain stream to ensure handler completes
    const reader = res.body!.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
    const cacheLog = logs.find(l => l.includes('[AI Proxy] [cache:stream]'))
    expect(cacheLog).toBeDefined()
  })

  test('no log when AI_PROXY_LOG_CACHE is not "1"', async () => {
    process.env.AI_PROXY_LOG_CACHE = '0'
    pushJson({
      id: 'msg_3',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const res = await app.fetch(new Request('http://localhost/api/ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer shogo_sk_valid_extra',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }))
    expect(res.status).toBe(200)
    expect(logs.find(l => l.includes('[cache:'))).toBeUndefined()
  })
})
