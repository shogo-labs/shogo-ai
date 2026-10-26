// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * QA acceptance — SHO-231: Google (Gemini) as a first-class provider.
 *
 * The dev-side tests cover the units (base URL, key lookup, discovery mapping,
 * pi-adapter resolution) with `fetch` stubbed. This file covers the chain a
 * user actually walks, with the one piece a stub cannot prove: the request the
 * AI proxy really puts on the wire, observed by a **real HTTP server** standing
 * in for Gemini (via `GOOGLE_BASE_URL`).
 *
 * Acceptance criteria exercised here:
 *   AC1  a Google key entered in Admin → Models is encrypted at rest, read back
 *        as a mask only, and clearing it removes the row
 *   AC2  live discovery lists only chat-capable Gemini models (no embeddings /
 *        AQA / Imagen / Veo / TTS / Live) with the `models/` prefix stripped
 *   AC3  enabling a discovered Gemini model persists a priced row and a chat
 *        turn on it streams a reply through `/api/ai/v1/chat/completions` with
 *        usage recorded — served locally from the admin-stored key, no env var
 *   AC4  a Google key never leaks into another provider's slot
 *
 *   bun test apps/api/src/__tests__/qa-sho231-google-provider.acceptance.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.AI_PROXY_SECRET = 'qa-sho231-secret'
process.env.BETTER_AUTH_SECRET = 'qa-sho231-better-auth-secret'
// 32-byte master key so the admin route can encrypt the key at rest.
process.env.SECRETS_ENCRYPTION_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')
delete process.env.SHOGO_LOCAL_MODE
delete process.env.SHOGO_API_KEY
delete process.env.SHOGO_CLOUD_URL
// The whole point: the key is entered in the admin UI, never in the env.
delete process.env.GOOGLE_API_KEY
delete process.env.GOOGLE_BASE_URL

const GOOGLE_KEY = 'AIza-qa-sho231-admin-entered-key'
const GEMINI_UUID = '11111111-2222-3333-4444-555555555555'
const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

// ─── In-memory prisma ─────────────────────────────────────────────────────
let models: Map<string, any>
let settings: Map<string, any>
let consumedUsageCalls: any[]

function notFound(): never {
  const e: any = new Error('Record not found')
  e.code = 'P2025'
  throw e
}

function seedGeminiRow(): void {
  models.set(GEMINI_UUID, {
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
    reasoningEffort: null,
    inputPerMillion: 0.3,
    cachedInputPerMillion: 0.075,
    cacheWritePerMillion: 0,
    outputPerMillion: 2.5,
  })
}

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    modelDefinition: {
      findMany: async ({ where }: any = {}) => {
        const all = [...models.values()]
        if (where?.enabled === true) return all.filter((m) => m.enabled)
        if (where?.id?.in) return all.filter((m) => where.id.in.includes(m.id))
        return all
      },
      findUnique: async ({ where }: any) => models.get(where.id) ?? null,
      findFirst: async ({ where }: any) => {
        for (const m of models.values()) {
          if (where?.provider != null && m.provider !== where.provider) continue
          if (where?.apiModel != null && m.apiModel !== where.apiModel) continue
          return m
        }
        return null
      },
      create: async ({ data }: any) => {
        const row = { createdAt: new Date(), updatedAt: new Date(), ...data }
        models.set(data.id, row)
        return row
      },
      update: async ({ where, data }: any) => {
        const existing = models.get(where.id)
        if (!existing) notFound()
        const row = { ...existing, ...data, updatedAt: new Date() }
        models.set(where.id, row)
        return row
      },
    },
    modelProvider: { findMany: async () => [] },
    platformSetting: {
      findUnique: async ({ where }: any) => settings.get(where.key) ?? null,
      findMany: async ({ where }: any = {}) => {
        let entries = [...settings.entries()]
        if (where?.key?.startsWith) entries = entries.filter(([k]) => k.startsWith(where.key.startsWith))
        return entries.map(([key, row]: any) => ({
          ...(typeof row === 'string' ? {} : row),
          key,
          value: typeof row === 'string' ? row : row.value,
        }))
      },
      upsert: async ({ where, update, create }: any) => {
        const existing = settings.get(where.key)
        const row = existing ? { ...existing, ...update } : { key: where.key, ...create }
        settings.set(where.key, row)
        return row
      },
      deleteMany: async ({ where }: any) => {
        if (where?.key) settings.delete(where.key)
        return { count: 1 }
      },
    },
    workspaceModelVisibility: { findMany: async () => [] },
    project: {
      findFirst: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
      findUnique: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
    },
    apiKey: { findUnique: async () => null, update: async () => ({}) },
    usageEvent: { create: async ({ data }: any) => data },
    usageWallet: {
      findUnique: async () => ({ workspaceId: 'ws-1', monthlyIncludedUsd: 20 }),
      upsert: async (a: any) => a.create,
      update: async (a: any) => a.data,
    },
    subscription: { findFirst: async () => ({ planId: 'pro', status: 'active' }) },
  },
}))

mock.module('../services/billing.service', () => ({
  SYSTEM_WORKSPACE_ID: 'system',
  ensureSystemWorkspace: async () => {},
  hasBalance: async () => true,
  checkUsageBalance: async () => ({ ok: true, remainingIncludedUsd: 100 }),
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

// Fake Gemini upstream (real HTTP, so the wire format is observable)
interface GeminiHit {
  path: string
  authorization: string | null
  body: any
}

let geminiHits: GeminiHit[] = []
let geminiMode: 'json' | 'sse' = 'json'
let geminiServer: ReturnType<typeof Bun.serve>

const SSE_LINES = [
  '{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello "}}]}',
  '{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"from gemini"}}]}',
  '{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":14,"completion_tokens":6,"prompt_tokens_details":{"cached_tokens":4}}}',
]

function geminiJson() {
  return {
    id: 'chatcmpl-gemini-qa',
    object: 'chat.completion',
    model: 'gemini-2.5-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello from gemini' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 14, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 4 } },
  }
}

function geminiResponse(): Response {
  if (geminiMode === 'sse') {
    let body = ''
    for (const line of SSE_LINES) body = body + 'data: ' + line + '\n\n'
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  return new Response(JSON.stringify(geminiJson()), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Only the two calls that hit a hard-coded URL are intercepted: the LiteLLM
// price table (so enabling a model is priced from real-looking rates, not a
// network round-trip) and Google's ListModels (whose URL is not configurable).
// Everything else -- notably the proxy's call to Gemini -- uses the real fetch
// against the local server below.
const realFetch = globalThis.fetch
let discoveryPayload: any = { models: [] }
let discoveryStatus = 200
let discoveryCalls: Array<{ url: string; headers: Record<string, string> }> = []

const LITELLM_TABLE = {
  'gemini/gemini-2.5-flash': {
    input_cost_per_token: 0.0000003,
    output_cost_per_token: 0.0000025,
    cache_read_input_token_cost: 0.000000075,
    max_input_tokens: 1048576,
    max_tokens: 65536,
  },
  'gemini/gemini-2.5-pro': {
    input_cost_per_token: 0.00000125,
    output_cost_per_token: 0.00001,
    max_input_tokens: 1048576,
    max_tokens: 65536,
  },
}

globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.url
  if (url.startsWith(LITELLM_URL)) {
    return new Response(JSON.stringify(LITELLM_TABLE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (url.includes('generativelanguage.googleapis.com/v1beta/models')) {
    discoveryCalls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} })
    return new Response(JSON.stringify(discoveryPayload), {
      status: discoveryStatus,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return realFetch(input, init)
}) as any

// Imports AFTER the module mocks are installed.
const { Hono } = await import('hono')
const { aiProxyRoutes, getProviderApiKey } = await import('../routes/ai-proxy')
const { adminModelCatalogRoutes } = await import('../routes/admin-model-catalog')
const { generateProxyToken } = await import('../lib/ai-proxy-token')
const { primeModelRegistry } = await import('../services/model-registry.service')
const { invalidateProviderCredentials } = await import('../services/provider-credentials.service')
const { isModelProviderConfigured } = await import('../services/visible-models.service')

function buildApp() {
  const app = new Hono()
  app.route('/api/admin/settings', adminModelCatalogRoutes())
  app.route('/api', aiProxyRoutes())
  return app
}

function adminFetch(path: string, init?: RequestInit) {
  return buildApp().fetch(new Request('http://api.test/api/admin/settings' + path, init))
}

function adminJson(method: string, path: string, body: any) {
  return adminFetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

let TOKEN: string

function postChat(body: Record<string, unknown>) {
  return buildApp().fetch(new Request('http://api.test/api/ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...body }),
  }))
}

async function storeGoogleKey(key: string | null) {
  const res = await adminJson('PUT', '/provider-keys', { google: key ?? '' })
  expect(res.status).toBe(200)
  await invalidateProviderCredentials()
  return res
}

beforeAll(async () => {
  geminiServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = await req.json().catch(() => null)
      geminiHits.push({
        path: new URL(req.url).pathname,
        authorization: req.headers.get('authorization'),
        body,
      })
      return geminiResponse()
    },
  })
  process.env.GOOGLE_BASE_URL = 'http://127.0.0.1:' + geminiServer.port + '/v1beta/openai'
  TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')
})

afterAll(() => {
  geminiServer?.stop(true)
  globalThis.fetch = realFetch
  delete process.env.GOOGLE_BASE_URL
})

beforeEach(async () => {
  models = new Map()
  settings = new Map()
  consumedUsageCalls = []
  geminiHits = []
  geminiMode = 'json'
  discoveryPayload = { models: [] }
  discoveryStatus = 200
  discoveryCalls = []
  delete process.env.GOOGLE_API_KEY
  seedGeminiRow()
  // The credentials snapshot is module-level and cached for 30s; without this
  // a key stored by the previous test would still answer for this one.
  await invalidateProviderCredentials()
  await primeModelRegistry()
})

describe('AC1 - the Google key is entered in the admin UI', () => {
  test('PUT stores it encrypted and only ever returns a mask', async () => {
    const res = await storeGoogleKey(GOOGLE_KEY)
    const data = await res.json() as any
    expect(data.ok).toBe(true)
    expect(data.keys.google.configured).toBe(true)
    expect(data.keys.google.source).toBe('db')
    expect(JSON.stringify(data)).not.toContain(GOOGLE_KEY)

    const stored = settings.get('provider-key.google')
    expect(stored.value).toBeTruthy()
    expect(stored.value).not.toContain(GOOGLE_KEY)

    const read = await (await adminFetch('/provider-keys')).json() as any
    expect(read.keys.google.configured).toBe(true)
    expect(read.keys.google.mask).toContain('\u2026')
    expect(JSON.stringify(read)).not.toContain(GOOGLE_KEY)
  })

  test('clearing it removes the row and the provider reads as unconfigured', async () => {
    await storeGoogleKey(GOOGLE_KEY)
    expect(settings.has('provider-key.google')).toBe(true)

    const res = await storeGoogleKey(null)
    const data = await res.json() as any
    expect(data.keys.google).toEqual({ configured: false, mask: '', source: null })
    expect(settings.has('provider-key.google')).toBe(false)
    expect(getProviderApiKey('google')).toBeNull()
  })
})

describe('AC3 - a Gemini chat turn is served locally from the stored key', () => {
  test('the proxy really calls Gemini with the admin key and plain max_tokens', async () => {
    await storeGoogleKey(GOOGLE_KEY)

    const res = await postChat({ model: GEMINI_UUID, max_tokens: 256 })
    expect(res.status).toBe(200)

    expect(geminiHits).toHaveLength(1)
    const hit = geminiHits[0]
    expect(hit.path).toBe('/v1beta/openai/chat/completions')
    expect(hit.authorization).toBe('Bearer ' + GOOGLE_KEY)
    expect(hit.body.model).toBe('gemini-2.5-flash')
    expect(hit.body.max_tokens).toBe(256)
    expect(hit.body.max_completion_tokens).toBeUndefined()

    const body = await res.json() as any
    expect(body.choices[0].message.content).toBe('hello from gemini')
  })

  test('a streamed turn relays Gemini SSE and records usage', async () => {
    await storeGoogleKey(GOOGLE_KEY)
    geminiMode = 'sse'

    const res = await postChat({ model: GEMINI_UUID, stream: true })
    expect(res.status).toBe(200)
    expect(geminiHits[0].body.stream_options).toEqual({ include_usage: true })

    const text = await res.text()
    expect(text).toContain('hello ')
    expect(text).toContain('from gemini')

    const metadata = consumedUsageCalls.at(-1)?.actionMetadata
    expect(metadata.inputTokens).toBe(10)
    expect(metadata.cachedInputTokens).toBe(4)
    expect(metadata.outputTokens).toBe(6)
  })

  test('no key anywhere -> a clear provider_not_configured, never a silent success', async () => {
    const res = await postChat({ model: GEMINI_UUID })
    expect(res.status).toBe(503)
    const body = await res.json() as any
    expect(body.error.code).toBe('provider_not_configured')
    expect(geminiHits).toHaveLength(0)
  })

  test('AC4: a Google key does not populate another provider slot', async () => {
    await storeGoogleKey(GOOGLE_KEY)
    expect(getProviderApiKey('google')).toBe(GOOGLE_KEY)
    expect(getProviderApiKey('openai')).toBeNull()
    expect(getProviderApiKey('anthropic')).toBeNull()
    expect(isModelProviderConfigured('google')).toBe(true)
  })
})

describe('AC2 + AC3 - discover, enable, then chat on the new row', () => {
  const LIST_MODELS = {
    models: [
      { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-embedding-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/text-embedding-005', displayName: 'Text Embedding', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/imagen-4.0-generate-001', supportedGenerationMethods: ['predict'] },
      { name: 'models/veo-3.0-generate-001', supportedGenerationMethods: ['predictLongRunning'] },
      { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash-image', displayName: 'Gemini 2.5 Flash Image', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.0-flash-preview-image-generation', displayName: 'Gemini 2.0 Flash Preview Image Generation', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.0-flash-live-001', supportedGenerationMethods: ['bidiGenerateContent'] },
      { name: 'models/aqa', supportedGenerationMethods: ['generateAnswer'] },
    ],
  }

  test('discovery offers only chat models and sends the key as a header', async () => {
    await storeGoogleKey(GOOGLE_KEY)
    discoveryPayload = LIST_MODELS

    const data = await (await adminFetch('/providers/google/models')).json() as any
    expect(data.ok).toBe(true)
    // Gemini's image-OUTPUT models also answer ListModels with generateContent,
    // so the id filter has to drop them: the card scopes image/video generation
    // out, and a chat turn on one returns an image part, not a reply.
    expect(data.models.map((m: any) => m.id)).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro'])
    expect(discoveryCalls).toHaveLength(1)
    expect(discoveryCalls[0].headers['x-goog-api-key']).toBe(GOOGLE_KEY)
    expect(discoveryCalls[0].url).toContain('pageSize=1000')
  })

  test('discovery without a key never calls Google', async () => {
    const data = await (await adminFetch('/providers/google/models')).json() as any
    expect(data.ok).toBe(false)
    expect(data.error).toBe('No API key configured for google.')
    expect(discoveryCalls).toHaveLength(0)
  })

  test('enabling a discovered model persists a priced row that the proxy then serves', async () => {
    // Start from an empty catalog so this asserts the CREATE path (a row that
    // already matches provider+apiModel would be updated instead).
    models = new Map()
    await primeModelRegistry()
    await storeGoogleKey(GOOGLE_KEY)
    discoveryPayload = LIST_MODELS

    const enabled = await (await adminJson('POST', '/providers/google/models/enable', {
      models: [{ id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', enabled: true }],
    })).json() as any
    expect(enabled.ok).toBe(true)

    const row = [...models.values()].find(
      (m) => m.provider === 'google' && m.apiModel === 'gemini-2.5-flash',
    )
    expect(row).toBeTruthy()
    expect(row.enabled).toBe(true)
    // Priced from the LiteLLM alias (gemini/<id>), never $0.
    expect(row.inputPerMillion).toBeCloseTo(0.3, 6)
    expect(row.outputPerMillion).toBeCloseTo(2.5, 6)
    expect(row.contextWindow).toBe(1048576)

    await primeModelRegistry()

    const res = await postChat({ model: row.id })
    expect(res.status).toBe(200)
    expect(geminiHits).toHaveLength(1)
    expect(geminiHits[0].body.model).toBe('gemini-2.5-flash')
    expect(geminiHits[0].authorization).toBe('Bearer ' + GOOGLE_KEY)
  })
})
