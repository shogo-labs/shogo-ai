// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-secret-ai-proxy-do-not-use-in-prod'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret'
// A real 32-byte master key so the registry can decrypt the custom provider key.
process.env.SECRETS_ENCRYPTION_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')
process.env.ANTHROPIC_API_KEY = 'sk-ant-db-routing-test'
process.env.OPENAI_API_KEY = 'sk-openai-db-routing-test'

/**
 * AI Proxy — DB-defined model routing (the model-registry → ai-proxy seam).
 *
 * Verifies that the chat-completions proxy honors the merged catalog:
 *   - A custom-provider model (MiMo) routes to the provider's configured
 *     base URL with its decrypted key + Bearer auth.
 *   - A native DB-defined model (Opus 4.8) routes to Anthropic.
 *   - DB-configured tier gates free/basic users (premium custom model).
 *
 * No external network: `globalThis.fetch` is stubbed at file scope.
 *
 *   bun test apps/api/src/__tests__/ai-proxy-db-custom-provider.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'
import { encryptSecret } from '../lib/secret-crypto'

// Cloud-side path: no local mode / no cloud-key forwarding.
delete process.env.SHOGO_LOCAL_MODE
delete process.env.SHOGO_API_KEY
delete process.env.SHOGO_CLOUD_URL

const MIMO_KEY = 'sk-mimo-staging-routing-key-abcdef'

// Opaque UUIDs are how DB models are really addressed in production (the slug
// lives in `apiModel`/`aliases`, not the id). The prior native-routing
// attempt's test used the slug as the id and so never exercised the
// UUID → apiModel rewrite that actually 404s upstream.
const OPUS_UUID = '11111111-2222-3333-4444-555555555555'
const GPT_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

// ─── Mutable DB rows the registry loads through the mocked prisma ──────────
let MODELS: any[] = []
let PROVIDERS: any[] = []
let hasAdvanced = true

function seed() {
  PROVIDERS = [
    {
      id: 'prov-mimo',
      label: 'MiMo',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      protocol: 'openai',
      authStyle: 'bearer',
      encryptedApiKey: encryptSecret(MIMO_KEY),
      enabled: true,
    },
  ]
  MODELS = [
    {
      id: 'mimo-v2.5',
      provider: 'custom',
      providerId: 'prov-mimo',
      apiModel: 'mimo-v2.5',
      displayName: 'MiMo v2.5',
      shortDisplayName: 'MiMo 2.5',
      tier: 'standard',
      family: 'other',
      generation: 'current',
      maxOutputTokens: 128000,
      enabled: true,
      sortOrder: 1,
      aliases: ['mimo'],
      capabilities: null,
      inputPerMillion: 1.5,
      cachedInputPerMillion: 0.3,
      cacheWritePerMillion: 2,
      outputPerMillion: 6,
    },
    {
      id: 'claude-opus-4-8',
      provider: 'anthropic',
      providerId: null,
      apiModel: 'claude-opus-4-8',
      displayName: 'Claude Opus 4.8',
      shortDisplayName: 'Opus 4.8',
      tier: 'premium',
      family: 'opus',
      generation: 'current',
      maxOutputTokens: 128000,
      enabled: true,
      sortOrder: 0,
      aliases: ['opus'],
      capabilities: null,
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      cacheWritePerMillion: 6.25,
      outputPerMillion: 25,
    },
    // UUID-addressed Opus: id is an opaque UUID, the real Anthropic slug lives
    // in apiModel. This is the production addressing the routing must honor.
    {
      id: OPUS_UUID,
      provider: 'anthropic',
      providerId: null,
      apiModel: 'claude-opus-4-8',
      displayName: 'Claude Opus 4.8 (DB)',
      shortDisplayName: 'Opus 4.8',
      tier: 'premium',
      family: 'opus',
      generation: 'current',
      maxOutputTokens: 128000,
      enabled: true,
      sortOrder: 2,
      aliases: [],
      capabilities: null,
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      cacheWritePerMillion: 6.25,
      outputPerMillion: 25,
    },
    // UUID-addressed GPT: native OpenAI, routed through the Responses API.
    {
      id: GPT_UUID,
      provider: 'openai',
      providerId: null,
      apiModel: 'gpt-5.5',
      displayName: 'GPT 5.5 (DB)',
      shortDisplayName: 'GPT 5.5',
      tier: 'standard',
      family: 'gpt',
      generation: 'current',
      maxOutputTokens: 128000,
      enabled: true,
      sortOrder: 3,
      aliases: [],
      capabilities: null,
      inputPerMillion: 2,
      cachedInputPerMillion: 0.2,
      cacheWritePerMillion: 2.5,
      outputPerMillion: 10,
    },
  ]
}

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    modelDefinition: { findMany: async () => MODELS.filter((m) => m.enabled) },
    modelProvider: { findMany: async () => PROVIDERS },
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
  },
}))

mock.module('../services/billing.service', () => ({
  hasBalance: async () => true,
  hasAdvancedModelAccess: async () => hasAdvanced,
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 100 }),
  getSubscription: async () => ({ planId: 'pro', status: 'active' }),
  getUsageWallet: async () => ({ workspaceId: 'ws-1' }),
}))

mock.module('../lib/proxy-billing-session', () => ({
  openSession: () => null,
  hasSession: () => false,
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

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    lastFetchUrl = url
    lastFetchInit = init
    if (url.includes('anthropic')) {
      return new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        model: 'claude-opus-4-8', stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }) as any
    }
    return new Response(JSON.stringify({
      id: 'cmpl_1', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }) as any
  }) as any
})

afterAll(() => { globalThis.fetch = originalFetch })

// ─── Imports AFTER mocks ──────────────────────────────────────────────────
const { Hono } = await import('hono')
const { aiProxyRoutes } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')
const { primeModelRegistry, invalidateModelRegistry } = await import('../services/model-registry.service')

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
  hasAdvanced = true
  seed()
  await primeModelRegistry()
})

function postChat(app: any, model: string) {
  return app.fetch(new Request('http://x/api/ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  }))
}

// The runtime speaks the native Anthropic Messages API for `provider:anthropic`
// models — this is the endpoint a UUID-addressed Opus turn actually hits.
function postAnthropic(app: any, model: string, extra: Record<string, unknown> = {}) {
  return app.fetch(new Request('http://x/api/ai/anthropic/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
    body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], ...extra }),
  }))
}

// The runtime speaks the OpenAI Responses API for native `provider:openai`
// models — the endpoint a UUID-addressed GPT turn hits.
function postResponses(app: any, model: string) {
  return app.fetch(new Request('http://x/api/ai/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ model, input: 'hi' }),
  }))
}

/** Parse the body of the last captured upstream fetch. */
function lastForwardedBody(): any {
  const raw = lastFetchInit?.body
  if (typeof raw !== 'string') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Parse the `model` field off the body of the last captured upstream fetch. */
function lastForwardedModel(): string | undefined {
  return lastForwardedBody()?.model
}

describe('ai-proxy DB-defined model routing', () => {
  test('routes a custom-provider model to its base URL with Bearer auth', async () => {
    const res = await postChat(buildApp(), 'mimo-v2.5')
    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe('https://api.xiaomimimo.com/v1/chat/completions')
    const auth = (lastFetchInit?.headers as Record<string, string>)?.['Authorization']
    expect(auth).toBe(`Bearer ${MIMO_KEY}`)
  })

  test('resolves a DB alias to the custom provider', async () => {
    const res = await postChat(buildApp(), 'mimo')
    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe('https://api.xiaomimimo.com/v1/chat/completions')
  })

  test('routes a native DB-defined model to Anthropic', async () => {
    const res = await postChat(buildApp(), 'claude-opus-4-8')
    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe('https://api.anthropic.com/v1/messages')
    const apiKey = (lastFetchInit?.headers as Record<string, string>)?.['x-api-key']
    expect(apiKey).toBe('sk-ant-db-routing-test')
  })

  test('gates a premium DB model for users without advanced access', async () => {
    hasAdvanced = false
    const res = await postChat(buildApp(), 'claude-opus-4-8')
    expect(res.status).toBe(403)
    const data = await res.json() as any
    expect(data.error.code).toBe('model_tier_restricted')
  })

  test('a disabled custom model is not routable', async () => {
    MODELS = MODELS.map((m) => (m.id === 'mimo-v2.5' ? { ...m, enabled: false } : m))
    await invalidateModelRegistry()
    const res = await postChat(buildApp(), 'mimo-v2.5')
    expect(res.status).toBe(400)
    const data = await res.json() as any
    expect(data.error.code).toBe('model_not_found')
  })

  // ── UUID-addressed native models (the actual production bug) ──────────────
  // The runtime, given a provider hint, routes these through the native
  // endpoints. The proxy must rewrite the opaque UUID to the upstream
  // `apiModel` or the provider 404s on the unknown id.

  test('Anthropic passthrough rewrites a UUID-addressed Opus to its apiModel', async () => {
    const res = await postAnthropic(buildApp(), OPUS_UUID)
    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe('https://api.anthropic.com/v1/messages')
    // The bug: forwarding the raw UUID 404s upstream. Must send the slug.
    expect(lastForwardedModel()).toBe('claude-opus-4-8')
    const apiKey = (lastFetchInit?.headers as Record<string, string>)?.['x-api-key']
    expect(apiKey).toBe('sk-ant-db-routing-test')
  })

  // ── Adaptive thinking normalization (the production 400) ──────────────────
  // A UUID-addressed Opus reaches pi-ai as an opaque id, so it can't detect
  // adaptive thinking and emits the legacy budget-based `thinking.type:
  // "enabled"` block. Opus 4.7/4.8 reject that with a 400. The proxy — which
  // knows the real apiModel — must rewrite it to the adaptive shape.

  test('rewrites budget-based thinking to adaptive for a UUID-addressed Opus', async () => {
    const res = await postAnthropic(buildApp(), OPUS_UUID, {
      thinking: { type: 'enabled', budget_tokens: 20000, display: 'summarized' },
    })
    expect(res.status).toBe(200)
    const body = lastForwardedBody()
    expect(body.model).toBe('claude-opus-4-8')
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    // effort must live in a separate output_config object, not inside thinking.
    expect(body.thinking.budget_tokens).toBeUndefined()
    expect(body.output_config?.effort).toBe('high')
  })

  test('defaults thinking display to summarized when the source omits it', async () => {
    const res = await postAnthropic(buildApp(), OPUS_UUID, {
      thinking: { type: 'enabled', budget_tokens: 8000 },
    })
    expect(res.status).toBe(200)
    const body = lastForwardedBody()
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config?.effort).toBe('medium')
  })

  test('leaves a disabled thinking block untouched for Opus', async () => {
    const res = await postAnthropic(buildApp(), OPUS_UUID, {
      thinking: { type: 'disabled' },
    })
    expect(res.status).toBe(200)
    const body = lastForwardedBody()
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.output_config).toBeUndefined()
  })

  test('Responses API rewrites a UUID-addressed GPT to its apiModel', async () => {
    const res = await postResponses(buildApp(), GPT_UUID)
    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe('https://api.openai.com/v1/responses')
    expect(lastForwardedModel()).toBe('gpt-5.5')
    const auth = (lastFetchInit?.headers as Record<string, string>)?.['Authorization']
    expect(auth).toBe('Bearer sk-openai-db-routing-test')
  })
})
