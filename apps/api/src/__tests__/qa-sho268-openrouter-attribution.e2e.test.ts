// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-secret-ai-proxy-do-not-use-in-prod'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret'
process.env.SECRETS_ENCRYPTION_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')

/**
 * SHO-268 acceptance — OpenRouter app attribution headers, end to end over the wire.
 *
 * `ai-proxy-db-custom-provider.test.ts` asserts the headers the proxy *builds*
 * by stubbing `globalThis.fetch`. This test lets the real fetch run against a
 * local HTTP server standing in for OpenRouter, so it also proves the header
 * names survive Bun's fetch untouched (a key like `X-OpenRouter-Categories`
 * must not be dropped or renamed on the way out).
 *
 *   bun test apps/api/src/__tests__/qa-sho268-openrouter-attribution.e2e.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'
import { encryptSecret } from '../lib/secret-crypto'

delete process.env.SHOGO_LOCAL_MODE
delete process.env.SHOGO_API_KEY
delete process.env.SHOGO_CLOUD_URL

const OPENROUTER_KEY = 'sk-or-staging-attribution-e2e'
const MIMO_KEY = 'sk-mimo-staging-attribution-e2e'
const OPENROUTER_NATIVE_UUID = 'd2680000-0000-4000-8000-000000000001'

const EXPECTED_CATEGORIES = 'cloud-agent,native-app-builder,personal-agent'

// ─── Local stand-in for OpenRouter ────────────────────────────────────────
let upstream: ReturnType<typeof Bun.serve>
let upstreamBase = ''
let received: { path: string; headers: Headers }[] = []

function lastReceived() {
  return received[received.length - 1]
}

function seed(port: number, extraCategoryModels: boolean) {
  PROVIDERS = [
    {
      id: 'prov-openrouter',
      label: 'OpenRouter',
      baseUrl: `http://127.0.0.1:${port}/openrouter.ai/api/v1`,
      protocol: 'openai',
      authStyle: 'bearer',
      encryptedApiKey: encryptSecret(OPENROUTER_KEY),
      enabled: true,
    },
    {
      id: 'prov-mimo',
      label: 'MiMo',
      baseUrl: `http://127.0.0.1:${port}/xiaomimimo/v1`,
      protocol: 'openai',
      authStyle: 'bearer',
      encryptedApiKey: encryptSecret(MIMO_KEY),
      enabled: true,
    },
  ]
  MODELS = [
    {
      id: 'hoshi-e2e',
      provider: 'custom',
      providerId: 'prov-openrouter',
      apiModel: 'deepseek/deepseek-v4.1-flash',
      displayName: 'Hoshi 2.0 (e2e)',
      shortDisplayName: 'Hoshi 2.0',
      tier: 'standard',
      family: 'deepseek',
      generation: 'current',
      maxOutputTokens: 64000,
      enabled: true,
      sortOrder: 1,
      aliases: [],
      capabilities: null,
      inputPerMillion: 0.3,
      cachedInputPerMillion: 0.03,
      cacheWritePerMillion: 0.4,
      outputPerMillion: 1.2,
    },
    {
      id: 'mimo-e2e',
      provider: 'custom',
      providerId: 'prov-mimo',
      apiModel: 'mimo-v2.5',
      displayName: 'MiMo v2.5 (e2e)',
      shortDisplayName: 'MiMo 2.5',
      tier: 'standard',
      family: 'other',
      generation: 'current',
      maxOutputTokens: 64000,
      enabled: true,
      sortOrder: 2,
      aliases: [],
      capabilities: null,
      inputPerMillion: 1,
      cachedInputPerMillion: 0.1,
      cacheWritePerMillion: 1.2,
      outputPerMillion: 4,
    },
  ]
  if (extraCategoryModels) {
    MODELS.push({
      id: OPENROUTER_NATIVE_UUID,
      provider: 'openrouter',
      providerId: null,
      apiModel: 'anthropic/claude-haiku-4.5',
      displayName: 'Haiku via OpenRouter (e2e)',
      shortDisplayName: 'Haiku (OR)',
      tier: 'economy',
      family: 'haiku',
      generation: 'current',
      maxOutputTokens: 64000,
      enabled: true,
      sortOrder: 3,
      aliases: [],
      capabilities: null,
      inputPerMillion: 1,
      cachedInputPerMillion: 0.1,
      cacheWritePerMillion: 1.25,
      outputPerMillion: 5,
    })
  }
}

let PROVIDERS: any[] = []
let MODELS: any[] = []

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
  checkUsageBalance: async () => ({ ok: true }),
  usageLimitErrorPayload: (reason?: string) => ({ code: reason ?? 'usage_limit_reached', message: 'limit' }),
  hasAdvancedModelAccess: async () => true,
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 100 }),
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

const { Hono } = await import('hono')
const { aiProxyRoutes } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')
const { primeModelRegistry } = await import('../services/model-registry.service')

function buildApp() {
  const app = new Hono()
  app.route('/api', aiProxyRoutes())
  return app
}

let TOKEN: string

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    fetch: (req) => {
      received.push({ path: new URL(req.url).pathname, headers: req.headers })
      return Response.json({
        id: 'cmpl_e2e',
        object: 'chat.completion',
        model: 'stub',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
      })
    },
  })
  upstreamBase = `http://127.0.0.1:${upstream.port}`
  TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')
})

afterAll(() => {
  upstream?.stop(true)
  delete process.env.OPENROUTER_BASE_URL
})

beforeEach(async () => {
  received = []
  seed(upstream.port, true)
  // The native `openrouter:` provider resolves its base URL from env, so point
  // it at the same local stand-in instead of the real API.
  process.env.OPENROUTER_BASE_URL = `${upstreamBase}/openrouter.ai/api/v1`
  // The native provider is BYOK: without a key the proxy 503s before fetching.
  process.env.OPENROUTER_API_KEY = OPENROUTER_KEY
  await primeModelRegistry()
})

function postChat(model: string) {
  return buildApp().fetch(new Request('http://x/api/ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  }))
}

describe('SHO-268 OpenRouter app attribution over the wire', () => {
  test('an OpenRouter custom provider request carries the full attribution header set', async () => {
    const res = await postChat('hoshi-e2e')
    expect(res.status).toBe(200)
    expect(lastReceived().path).toBe('/openrouter.ai/api/v1/chat/completions')
    const headers = lastReceived().headers
    expect(headers.get('http-referer')).toBe('https://shogo.ai')
    expect(headers.get('x-title')).toBe('Shogo')
    expect(headers.get('x-openrouter-title')).toBe('Shogo')
    expect(headers.get('x-openrouter-categories')).toBe(EXPECTED_CATEGORIES)
    expect(headers.get('x-openrouter-app-visibility')).toBeNull()
  })

  test('the native openrouter: provider carries the same header set', async () => {
    const res = await postChat(OPENROUTER_NATIVE_UUID)
    expect(res.status).toBe(200)
    expect(lastReceived().path).toBe('/openrouter.ai/api/v1/chat/completions')
    const headers = lastReceived().headers
    expect(headers.get('http-referer')).toBe('https://shogo.ai')
    expect(headers.get('x-openrouter-title')).toBe('Shogo')
    expect(headers.get('x-openrouter-categories')).toBe(EXPECTED_CATEGORIES)
  })

  test('a non-OpenRouter provider receives none of them', async () => {
    const res = await postChat('mimo-e2e')
    expect(res.status).toBe(200)
    expect(lastReceived().path).toBe('/xiaomimimo/v1/chat/completions')
    const headers = lastReceived().headers
    expect(headers.get('http-referer')).toBeNull()
    expect(headers.get('x-title')).toBeNull()
    expect(headers.get('x-openrouter-title')).toBeNull()
    expect(headers.get('x-openrouter-categories')).toBeNull()
  })

  test('OPENROUTER_CATEGORIES and OPENROUTER_X_TITLE overrides reach the wire', async () => {
    const saved = {
      title: process.env.OPENROUTER_X_TITLE,
      categories: process.env.OPENROUTER_CATEGORIES,
    }
    process.env.OPENROUTER_X_TITLE = 'Shogo Staging'
    process.env.OPENROUTER_CATEGORIES = 'personal-agent,general-chat'
    try {
      const res = await postChat('hoshi-e2e')
      expect(res.status).toBe(200)
      const headers = lastReceived().headers
      expect(headers.get('x-openrouter-title')).toBe('Shogo Staging')
      expect(headers.get('x-title')).toBe('Shogo Staging')
      expect(headers.get('x-openrouter-categories')).toBe('personal-agent,general-chat')
      // The referer is the app's identity — an override must not touch it here.
      expect(headers.get('http-referer')).toBe('https://shogo.ai')
    } finally {
      for (const [key, value] of Object.entries({
        OPENROUTER_X_TITLE: saved.title,
        OPENROUTER_CATEGORIES: saved.categories,
      })) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
