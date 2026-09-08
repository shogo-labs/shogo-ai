// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-secret-ai-proxy-do-not-use-in-prod'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret'
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-openai-do-not-use'
/**
 * Public OpenAI-compatible API (`/v1/*`) route tests.
 *
 * Validates the external developer surface:
 *   - auth accepts ONLY `shogo_sk_*` keys (proxy JWTs / runtime tokens rejected)
 *   - `/v1/models` lists only curated public models with the provider masked
 *   - chat completions translate `hoshi-1.0` → the backing model, bill the
 *     workspace at the backing model's id, and rewrite the response `model`
 *     back to the public id
 *   - unknown / non-public models 404, out-of-balance 402
 *
 * Run: bun test apps/api/src/__tests__/public-api.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'
import { generateProxyToken } from '../lib/ai-proxy-token'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const VALID_KEY = 'shogo_sk_test1234567890abcdef'

// The seeded public model map served by the mocked PlatformSetting. `hoshi-1.0`
// is backed by an OpenAI model so the routing test can mock a single upstream.
const PUBLIC_MODELS_JSON = JSON.stringify([
  { publicId: 'hoshi-1.0', displayName: 'Hoshi 1.0', backingModelId: 'gpt-5.5', enabled: true },
  { publicId: 'hidden-1.0', displayName: 'Hidden', backingModelId: 'gpt-5.5', enabled: false },
  // Backed by the one static-catalog model with `capabilities.supportsAudioInput`
  // (see packages/agent/src/model-catalog/models.ts), for the input_audio
  // pass-through test below.
  { publicId: 'hoshi-audio-1.0', displayName: 'Hoshi Audio', backingModelId: 'gpt-audio', enabled: true },
])

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    apiKey: {
      findUnique: async ({ where }: any) => {
        // Any hashed shogo_sk_ key resolves to a live workspace/user.
        if (!where?.keyHash) return null
        return {
          id: 'key-1',
          workspaceId: 'ws-1',
          userId: 'user-1',
          revokedAt: null,
          expiresAt: null,
          kind: 'user',
          deviceId: null,
        }
      },
      update: async () => ({}),
    },
    platformSetting: {
      findUnique: async ({ where }: any) =>
        where?.key === 'public-models' ? { key: 'public-models', value: PUBLIC_MODELS_JSON } : null,
      findMany: async () => [],
    },
    usageEvent: { create: async () => ({}) },
  },
}))

// Control balance/tier and capture billing calls without real wallet logic.
let hasBalanceValue = true
let hasAdvancedValue = true
const consumeUsageCalls: any[] = []

mock.module('../services/billing.service', () => ({
  hasBalance: async () => hasBalanceValue,
  checkUsageBalance: async () => (hasBalanceValue ? { ok: true } : { ok: false, reason: 'usage_limit_reached' }),
  usageLimitErrorPayload: (reason?: string) => ({
    code: reason ?? 'usage_limit_reached',
    message: "You've reached your usage limit. Enable usage-based pricing or upgrade your plan to continue.",
  }),
  hasAdvancedModelAccess: async () => hasAdvancedValue,
  consumeUsage: async (args: any) => {
    consumeUsageCalls.push(args)
    return { success: true, remainingIncludedUsd: 1 }
  },
  getUsageWindows: async () => ({
    fiveHour: { kind: 'fiveHour', limitUsd: null, utilization: 0, resetsAt: null },
    weekly: { kind: 'weekly', limitUsd: null, utilization: 0, resetsAt: null },
  }),
}))

// Imported AFTER the mocks so the route module binds to the stubs.
const { publicApiRoutes } = await import('../routes/public-api')
const { primePublicModels } = await import('../services/public-models.service')

describe('Public API /v1', () => {
  let app: Hono

  beforeAll(async () => {
    app = new Hono()
    app.route('/v1', publicApiRoutes())
    await primePublicModels()
  })

  beforeEach(() => {
    hasBalanceValue = true
    hasAdvancedValue = true
    consumeUsageCalls.length = 0
  })

  // ---- health -------------------------------------------------------------

  test('GET /v1/health is public', async () => {
    const res = await app.fetch(new Request('http://localhost/v1/health'))
    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.status).toBe('ok')
  })

  // ---- auth ---------------------------------------------------------------

  test('GET /v1/models rejects without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/v1/models'))
    expect(res.status).toBe(401)
    const data = (await res.json()) as any
    expect(data.error.type).toBe('authentication_error')
  })

  test('GET /v1/models rejects a proxy JWT (internal-only credential)', async () => {
    const jwt = await generateProxyToken('p-1', 'ws-1', 'user-1')
    const res = await app.fetch(
      new Request('http://localhost/v1/models', { headers: { Authorization: `Bearer ${jwt}` } }),
    )
    expect(res.status).toBe(401)
  })

  test('GET /v1/models rejects a runtime token', async () => {
    const res = await app.fetch(
      new Request('http://localhost/v1/models', {
        headers: { Authorization: 'Bearer rt_v1_p-1_deadbeef' },
      }),
    )
    expect(res.status).toBe(401)
  })

  // ---- models listing + masking ------------------------------------------

  test('GET /v1/models lists only enabled public models, provider masked', async () => {
    const res = await app.fetch(
      new Request('http://localhost/v1/models', { headers: { Authorization: `Bearer ${VALID_KEY}` } }),
    )
    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.object).toBe('list')
    const ids = data.data.map((m: any) => m.id)
    expect(ids).toContain('hoshi-1.0')
    expect(ids).not.toContain('hidden-1.0')
    // No backing model id / provider leaks.
    for (const m of data.data) {
      expect(m.owned_by).toBe('shogo')
      expect(JSON.stringify(m)).not.toContain('gpt-5.5')
    }
  })

  // ---- chat completions: validation --------------------------------------

  test('POST /v1/chat/completions rejects without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'hoshi-1.0', messages: [{ role: 'user', content: 'hi' }] }),
      }),
    )
    expect(res.status).toBe(401)
  })

  test('POST /v1/chat/completions 400s when model missing', async () => {
    const res = await app.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VALID_KEY}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      }),
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('model_required')
  })

  test('POST /v1/chat/completions 404s for a non-public model', async () => {
    const res = await app.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VALID_KEY}` },
        // A real internal model id must NOT be reachable via the public surface.
        body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] }),
      }),
    )
    expect(res.status).toBe(404)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('model_not_found')
  })

  test('POST /v1/chat/completions 404s for a disabled public model', async () => {
    const res = await app.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VALID_KEY}` },
        body: JSON.stringify({ model: 'hidden-1.0', messages: [{ role: 'user', content: 'hi' }] }),
      }),
    )
    expect(res.status).toBe(404)
  })

  test('POST /v1/chat/completions 402s when out of balance', async () => {
    hasBalanceValue = false
    const res = await app.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VALID_KEY}` },
        body: JSON.stringify({ model: 'hoshi-1.0', messages: [{ role: 'user', content: 'hi' }] }),
      }),
    )
    expect(res.status).toBe(402)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('usage_limit_reached')
  })

  // ---- chat completions: alias routing + billing + masking ---------------

  test('POST /v1/chat/completions routes hoshi-1.0 to the backing model, bills it, masks the response model', async () => {
    const originalFetch = globalThis.fetch
    let upstreamBody: any = null
    globalThis.fetch = (async (url: any, init: any) => {
      upstreamBody = init?.body ? JSON.parse(init.body) : null
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          model: 'gpt-5.5',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as any

    try {
      const res = await app.fetch(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VALID_KEY}` },
          body: JSON.stringify({ model: 'hoshi-1.0', messages: [{ role: 'user', content: 'hi' }] }),
        }),
      )
      expect(res.status).toBe(200)
      const data = (await res.json()) as any
      // Response model is masked back to the public id.
      expect(data.model).toBe('hoshi-1.0')
      // Upstream was actually called with the backing model id.
      expect(upstreamBody.model).toBe('gpt-5.5')
      // Billing was recorded against the backing model id and the key's workspace.
      expect(consumeUsageCalls.length).toBe(1)
      expect(consumeUsageCalls[0].workspaceId).toBe('ws-1')
      expect(consumeUsageCalls[0].actionMetadata.model).toBe('gpt-5.5')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  // ---- chat completions: input_audio validation ---------------------------
  // Mirrors the internal `/api/ai/v1/chat/completions` guard (see
  // ai-proxy-audio-input.test.ts) on the public surface, keyed off the
  // *backing* model's capability rather than the public id.

  test('POST /v1/chat/completions rejects input_audio for a public model backed by a non-audio model', async () => {
    const res = await app.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VALID_KEY}` },
        body: JSON.stringify({
          model: 'hoshi-1.0',
          messages: [
            {
              role: 'user',
              content: [{ type: 'input_audio', input_audio: { data: 'ZmFrZQ==', format: 'wav' } }],
            },
          ],
        }),
      }),
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('audio_input_not_supported')
    // The error is reported under the public id, not the masked backing model.
    expect(data.error.message).toContain('hoshi-1.0')
  })

  test('POST /v1/chat/completions accepts and forwards input_audio for a public model backed by an audio-native model', async () => {
    const originalFetch = globalThis.fetch
    let upstreamBody: any = null
    globalThis.fetch = (async (_url: any, init: any) => {
      upstreamBody = init?.body ? JSON.parse(init.body) : null
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-audio-test',
          object: 'chat.completion',
          model: 'gpt-audio',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as any

    try {
      const res = await app.fetch(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VALID_KEY}` },
          body: JSON.stringify({
            model: 'hoshi-audio-1.0',
            messages: [
              {
                role: 'user',
                content: [{ type: 'input_audio', input_audio: { data: 'ZmFrZQ==', format: 'wav' } }],
              },
            ],
          }),
        }),
      )
      expect(res.status).toBe(200)
      expect(upstreamBody.messages[0].content[0].type).toBe('input_audio')
      expect(upstreamBody.messages[0].content[0].input_audio.data).toBe('ZmFrZQ==')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
