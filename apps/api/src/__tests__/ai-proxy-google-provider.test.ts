// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-secret-ai-proxy-do-not-use-in-prod'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret'

/**
 * AI Proxy — Google (Gemini) routing.
 *
 * A `provider: 'google'` model row is served through Gemini's OpenAI-compatible
 * endpoint on the existing OpenAI pass-through: Bearer auth with the stored
 * `GOOGLE_API_KEY`, plain `max_tokens` (never OpenAI's `max_completion_tokens`),
 * and `stream_options.include_usage` so a streamed turn still meters usage.
 *
 * No external network: `globalThis.fetch` is stubbed at file scope.
 *
 *   bun test apps/api/src/__tests__/ai-proxy-google-provider.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

delete process.env.SHOGO_LOCAL_MODE
delete process.env.SHOGO_API_KEY
delete process.env.SHOGO_CLOUD_URL
delete process.env.GOOGLE_BASE_URL

const GOOGLE_KEY = 'AIza-test-google-routing-key'
const GEMINI_UUID = '99999999-8888-7777-6666-555555555555'
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'

let MODELS: any[] = []
let consumedUsageCalls: any[] = []

function seed() {
  MODELS = [{
    id: GEMINI_UUID,
    provider: 'google',
    providerId: null,
    apiModel: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    shortDisplayName: 'Gemini Flash',
    tier: 'standard',
    family: 'other',
    generation: 'current',
    maxOutputTokens: 65536,
    enabled: true,
    sortOrder: 1,
    aliases: [],
    capabilities: null,
    inputPerMillion: 0.3,
    cachedInputPerMillion: 0.075,
    cacheWritePerMillion: 0,
    outputPerMillion: 2.5,
  }]
}

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    modelDefinition: { findMany: async () => MODELS.filter((m) => m.enabled) },
    modelProvider: { findMany: async () => [] },
    project: {
      findFirst: async () => ({ id: 'proj-1', name: 'Test' }),
      findUnique: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
    },
    apiKey: { findUnique: async () => null, update: async () => ({}) },
    usageEvent: { create: async () => ({}) },
    usageWallet: {
      findUnique: async () => ({ workspaceId: 'ws-1', monthlyIncludedUsd: 20 }),
      upsert: async (a: any) => a.create,
      update: async (a: any) => a.data,
    },
    subscription: { findFirst: async () => ({ planId: 'pro', status: 'active' }) },
    platformSetting: { findMany: async () => [], findUnique: async () => null },
  },
}))

mock.module('../services/billing.service', () => ({
  hasBalance: async () => true,
  checkUsageBalance: async () => ({ ok: true }),
  usageLimitErrorPayload: (reason?: string) => ({ code: reason ?? 'usage_limit_reached', message: 'Usage limit reached.' }),
  hasAdvancedModelAccess: async () => true,
  consumeUsage: async (args: any) => {
    consumedUsageCalls.push(args)
    return { success: true, remainingIncludedUsd: 100 }
  },
  getSubscription: async () => ({ planId: 'pro', status: 'active' }),
  getUsageWallet: async () => ({ workspaceId: 'ws-1' }),
}))

mock.module('../lib/proxy-billing-session', () => ({
  openSession: () => null,
  hasSession: () => false,
  hasActiveSession: () => false,
  accumulateUsage: () => {},
  accumulateImageUsage: () => {},
  setQualitySignals: () => false,
  closeSession: async () => null,
}))

mock.module('../lib/project-user-context', () => ({ getProjectUser: () => 'test-user' }))

// ─── Stub fetch and capture the last call ─────────────────────────────────
const originalFetch = globalThis.fetch
let lastFetchUrl: string | null = null
let lastFetchInit: RequestInit | undefined
let fetchQueue: Array<Response | Error> = []


function jsonCompletion() {
  return new Response(JSON.stringify({
    id: 'chatcmpl-gemini-1',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi from gemini' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 2 } },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

const SSE_LINES = [
  '{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"}}]}',
  '{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":7}}',
]


function sseStream() {
  const prefix = 'data: '
  let out = ''
  for (const l of SSE_LINES) out = out + prefix + l + '\n\n'
  return new Response(out, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

beforeAll(() => {
  process.env.GOOGLE_API_KEY = GOOGLE_KEY
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    lastFetchUrl = url
    lastFetchInit = init
    const scripted = fetchQueue.shift()
    if (scripted instanceof Error) throw scripted
    if (scripted) return scripted
    return jsonCompletion()
  }) as any
})

afterAll(() => {
  globalThis.fetch = originalFetch
  delete process.env.GOOGLE_API_KEY
})

// ─── Imports AFTER mocks ──────────────────────────────────────────────────
const { Hono } = await import('hono')
const { aiProxyRoutes, getProviderApiKey, getOpenAICompatibleBaseUrl } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')
const { primeModelRegistry } = await import('../services/model-registry.service')

function buildApp() {
  const app = new Hono()
  app.route('/api', aiProxyRoutes())
  return app
}

let TOKEN: string

beforeAll(async () => {
  TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')
})

beforeEach(async () => {
  lastFetchUrl = null
  lastFetchInit = undefined
  fetchQueue = []
  consumedUsageCalls = []
  process.env.GOOGLE_API_KEY = GOOGLE_KEY
  delete process.env.GOOGLE_BASE_URL
  seed()
  await primeModelRegistry()
})

function postChat(body: Record<string, unknown>) {
  return buildApp().fetch(new Request('http://x/api/ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...body }),
  }))
}

function forwardedBody(): any {
  const raw = lastFetchInit?.body
  if (typeof raw !== 'string') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function forwardedHeaders(): Record<string, string> {
  return (lastFetchInit?.headers as Record<string, string>) ?? {}
}

describe('google (Gemini) provider routing', () => {
  test('serves a gemini model from Gemini’s OpenAI-compatible endpoint', async () => {
    const res = await postChat({ model: GEMINI_UUID })
    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe(GEMINI_URL)
    expect(forwardedHeaders().Authorization).toBe(`Bearer ${GOOGLE_KEY}`)
    expect(forwardedBody().model).toBe('gemini-2.5-flash')
    const body = await res.json() as any
    expect(body.choices[0].message.content).toBe('hi from gemini')
  })

  test('sends plain max_tokens, never OpenAI’s max_completion_tokens', async () => {
    const res = await postChat({ model: GEMINI_UUID, max_tokens: 256 })
    expect(res.status).toBe(200)
    const body = forwardedBody()
    expect(body.max_tokens).toBe(256)
    expect(body.max_completion_tokens).toBeUndefined()
  })

  test('meters a non-streamed turn', async () => {
    const res = await postChat({ model: GEMINI_UUID })
    expect(res.status).toBe(200)
    const metadata = consumedUsageCalls.at(-1)?.actionMetadata
    expect(metadata.inputTokens).toBe(10)
    expect(metadata.cachedInputTokens).toBe(2)
    expect(metadata.outputTokens).toBe(7)
  })

  test('streams with include_usage and meters the streamed turn', async () => {
    fetchQueue = [sseStream()]
    const res = await postChat({ model: GEMINI_UUID, stream: true })
    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe(GEMINI_URL)
    expect(forwardedBody().stream_options).toEqual({ include_usage: true })
    const text = await res.text()
    expect(text).toContain('hi')
    const metadata = consumedUsageCalls.at(-1)?.actionMetadata
    expect(metadata.inputTokens).toBe(12)
    expect(metadata.outputTokens).toBe(7)
  })
})

describe('google provider helpers', () => {
  test('getOpenAICompatibleBaseUrl targets the Gemini OpenAI endpoint', () => {
    expect(getOpenAICompatibleBaseUrl({ provider: 'google', apiModel: 'gemini-2.5-flash' } as any))
      .toBe(GEMINI_URL)
  })

  test('getOpenAICompatibleBaseUrl honors GOOGLE_BASE_URL', () => {
    process.env.GOOGLE_BASE_URL = 'https://gemini-proxy.internal/v1beta/openai'
    expect(getOpenAICompatibleBaseUrl({ provider: 'google', apiModel: 'gemini-2.5-flash' } as any))
      .toBe('https://gemini-proxy.internal/v1beta/openai/chat/completions')
    delete process.env.GOOGLE_BASE_URL
  })

  test('getProviderApiKey resolves google from the server-side key', () => {
    expect(getProviderApiKey('google')).toBe(GOOGLE_KEY)
  })

  test('getProviderApiKey returns null for google when no key is configured', () => {
    delete process.env.GOOGLE_API_KEY
    expect(getProviderApiKey('google')).toBeNull()
    process.env.GOOGLE_API_KEY = GOOGLE_KEY
  })

  test('other providers keep their own endpoints', () => {
    expect(getOpenAICompatibleBaseUrl({ provider: 'openai', apiModel: 'gpt-5.5' } as any))
      .toBe('https://api.openai.com/v1/chat/completions')
    expect(getOpenAICompatibleBaseUrl({ provider: 'openrouter', apiModel: 'x' } as any))
      .toBe('https://openrouter.ai/api/v1/chat/completions')
  })
})
