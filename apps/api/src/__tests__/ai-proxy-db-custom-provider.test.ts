// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-secret-ai-proxy-do-not-use-in-prod'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret'
// A real 32-byte master key so the registry can decrypt the custom provider key.
process.env.SECRETS_ENCRYPTION_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')
process.env.ANTHROPIC_API_KEY = 'sk-ant-db-routing-test'

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

// A DB-defined native model addressed by an opaque UUID id whose `apiModel`
// differs from the id — the real Opus 4.8 shape. The agent sends the UUID; the
// native Anthropic passthrough must forward `apiModel` (Anthropic 404s on the
// UUID otherwise).
const OPUS_UUID = '11111111-1111-4111-8111-111111111111'

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
    {
      id: OPUS_UUID,
      provider: 'anthropic',
      providerId: null,
      apiModel: 'claude-opus-4-8',
      displayName: 'Claude Opus 4.8 (DB UUID)',
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

// The Anthropic-native passthrough the agent-runtime uses when a model routes
// to provider `anthropic` (auth is the proxy token via `x-api-key`).
function postAnthropic(app: any, model: string) {
  return app.fetch(new Request('http://x/api/ai/anthropic/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': TOKEN,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
  }))
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

  test('native passthrough forwards apiModel, not the opaque UUID id', async () => {
    const res = await postAnthropic(buildApp(), OPUS_UUID)
    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe('https://api.anthropic.com/v1/messages')
    // The agent addresses the model by its UUID; the passthrough must rewrite
    // it to the resolved `apiModel` before forwarding upstream.
    const forwarded = JSON.parse((lastFetchInit?.body as string) ?? '{}')
    expect(forwarded.model).toBe('claude-opus-4-8')
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
})
