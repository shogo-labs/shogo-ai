// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.AI_PROXY_SECRET = 'cloud-forward-test-secret'
process.env.SHOGO_API_KEY = 'shogo_sk_cloud'
process.env.SHOGO_CLOUD_URL = 'https://cloud.example/'
process.env.SHOGO_LOCAL_MODE = 'true'
delete process.env.AI_MODE

// Rows of the workspace model allowlist (empty = inherit everything).
let visibilityRows: string[] = []

// Local billing seams. A forwarded request must touch none of them: cloud
// bills it, and a local capture would charge the same generation twice.
let billingCalls: string[] = []
let captureCalls: any[] = []

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
      findUnique: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
    },
    workspaceModelVisibility: {
      findMany: async () => visibilityRows.map((modelId) => ({ modelId })),
    },
    usageWallet: {
      findUnique: async () => null,
      create: async (args: any) => args.data,
      upsert: async (args: any) => args.create,
    },
    usageEvent: { create: async () => ({}) },
  },
}))

mock.module('../services/billing.service', () => ({
  hasBalance: async () => { billingCalls.push('hasBalance'); return true },
  hasAdvancedModelAccess: async () => { billingCalls.push('hasAdvancedModelAccess'); return true },
  checkUsageBalance: async () => { billingCalls.push('checkUsageBalance'); return { ok: true, remainingIncludedUsd: 100 } },
  consumeUsage: async () => { billingCalls.push('consumeUsage'); return { success: true, remainingIncludedUsd: 100 } },
}))

mock.module('../lib/proxy-capture', () => ({
  beginCapture: async (args: any) => { captureCalls.push(args); return null },
  updateTurnFeedback: async () => {},
  markProjectTurnsReverted: async () => {},
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

mock.module('../lib/project-user-context', () => ({
  getProjectUser: () => 'user-1',
}))

mock.module('../lib/cloud-key-wipe', () => ({
  wipeCloudKey: async () => {},
  wipeCloudKeyIfRejected: async () => ({ wiped: false }),
}))

const originalFetch = globalThis.fetch
let lastFetchUrl: string | null = null
let lastFetchInit: RequestInit | undefined
let nextFetchResponses: Array<() => Response> = []

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    lastFetchUrl = typeof input === 'string' ? input : input.url
    lastFetchInit = init
    const next = nextFetchResponses.shift()
    return (next ? next() : new Response('{}', { status: 200 })) as any
  }) as any
})

beforeEach(() => {
  lastFetchUrl = null
  lastFetchInit = undefined
  nextFetchResponses = []
  billingCalls = []
  captureCalls = []
  process.env.SHOGO_API_KEY = 'shogo_sk_cloud'
  process.env.SHOGO_CLOUD_URL = 'https://cloud.example/'
  process.env.SHOGO_LOCAL_MODE = 'true'
  delete process.env.AI_MODE
})

const { Hono } = await import('hono')
const { aiProxyRoutes } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')

let TOKEN = ''
beforeAll(async () => {
  TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')
})

function buildApp() {
  const app = new Hono()
  app.route('/api', aiProxyRoutes())
  return app
}

describe('AI proxy Shogo Cloud forwarding', () => {
  test('forwards non-streaming OpenAI-compatible chat completions to Shogo Cloud', async () => {
    nextFetchResponses.push(() => new Response(JSON.stringify({
      id: 'chatcmpl_cloud',
      choices: [{ message: { role: 'assistant', content: 'cloud ok' } }],
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }))

    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    }))

    expect(res.status).toBe(201)
    expect(lastFetchUrl).toBe('https://cloud.example/api/ai/v1/chat/completions')
    expect(new Headers(lastFetchInit?.headers).get('Authorization')).toBe('Bearer shogo_sk_cloud')
    expect((await res.json() as any).id).toBe('chatcmpl_cloud')
  })

  test('preserves providerOptions on the chat-completions body forwarded to Shogo Cloud (no local stripping)', async () => {
    // The convertToAnthropicFormat fix runs on whichever Shogo instance is NOT
    // cloud-forwarding (typically the staging cloud terminating the request).
    // The local side must stay a verbatim pass-through so providerOptions
    // actually reach the instance that translates it to Anthropic cache_control.
    nextFetchResponses.push(() => new Response(JSON.stringify({
      id: 'chatcmpl_passthrough',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        messages: [
          {
            role: 'system',
            content: 'system text',
            providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
          },
          { role: 'user', content: 'hi' },
        ],
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '5m' } } },
      }),
    }))

    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe('https://cloud.example/api/ai/v1/chat/completions')
    const forwarded = JSON.parse(String(lastFetchInit?.body))
    expect(forwarded.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral', ttl: '5m' } } })
    expect(forwarded.messages[0].providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } })
    // System message is still in its original OpenAI shape; cloud translates.
    expect(forwarded.messages[0].role).toBe('system')
    expect(forwarded.messages[0].content).toBe('system text')
  })

  test('forwards streaming OpenAI-compatible chat completions to Shogo Cloud', async () => {
    nextFetchResponses.push(() => new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', {
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
    expect(res.headers.get('X-Proxy-Provider')).toBe('shogo-cloud')
    expect(await res.text()).toContain('data:')
  })

  test('forwards non-streaming Anthropic-native messages to Shogo Cloud', async () => {
    nextFetchResponses.push(() => new Response(JSON.stringify({
      id: 'msg_cloud',
      content: [{ type: 'text', text: 'ok' }],
    }), { status: 202, headers: { 'Content-Type': 'application/json' } }))

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
        system: [{ type: 'text', text: 'Stable<|CACHE_BOUNDARY|>Dynamic' }],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }))

    expect(res.status).toBe(202)
    expect(lastFetchUrl).toBe('https://cloud.example/api/ai/anthropic/v1/messages')
    const forwarded = JSON.parse(String(lastFetchInit?.body))
    expect(forwarded.system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(new Headers(lastFetchInit?.headers).get('x-api-key')).toBe('shogo_sk_cloud')
    expect((await res.json() as any).id).toBe('msg_cloud')
  })

  test('forwards streaming Anthropic-native messages to Shogo Cloud with error-visible SSE wrapper', async () => {
    nextFetchResponses.push(() => new Response([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}',
      'data: {"type":"message_delta","usage":{"output_tokens":2}}',
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
        model: 'claude-3-haiku-20240307',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }))

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Proxy-Provider')).toBe('shogo-cloud')
    expect(await res.text()).toContain('message_start')
  })

  test('surfaces a Shogo Cloud billing error for a streaming request as-is, without the SSE error-visibility wrapper misclassifying it as a retryable truncated stream', async () => {
    // Regression test: Shogo Cloud returns hard errors (billing, auth, etc.)
    // as a single plain-JSON body with a non-2xx status, even when the client
    // requested `stream: true` — it never opens an SSE stream at all. Piping
    // that body through `wrapSseForErrorVisibility` (which assumes a real SSE
    // stream) would never see a `data: ...message_stop|error` terminal line,
    // so it would conclude the "stream" was truncated mid-flight and inject a
    // synthetic *retryable* `upstream_truncated` marker — masking the real,
    // permanent billing_error as a transient connectivity blip and sending
    // the agent-runtime's retry loop into an endless "reconnecting" spin.
    const billingErrorBody = JSON.stringify({
      type: 'error',
      error: {
        type: 'billing_error',
        message: "Model 'claude-sonnet-4-6' requires a Pro or higher subscription.",
      },
    })
    nextFetchResponses.push(() => new Response(billingErrorBody, {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
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
        model: 'claude-sonnet-4-6',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }))

    expect(res.status).toBe(403)
    const text = await res.text()
    expect(text).toBe(billingErrorBody)
    expect(text).not.toContain('upstream_truncated')
    expect(text).not.toContain('shogo:retryable=true')
  })

  describe('workspace model allowlist applies to forwarded calls', () => {
    let invalidate: (workspaceId: string) => void

    beforeAll(async () => {
      ({ invalidateWorkspaceModels: invalidate } = await import('../services/workspace-models.service'))
    })

    afterAll(() => {
      visibilityRows = []
      invalidate('ws-1')
    })

    test('refuses a hidden model without contacting Shogo Cloud (OpenAI-compatible)', async () => {
      visibilityRows = ['gpt-4o']
      invalidate('ws-1')
      const app = buildApp()
      const res = await app.fetch(new Request('http://x/api/ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
      }))

      expect(res.status).toBe(403)
      expect((await res.json() as any).error.code).toBe('model_not_visible')
      expect(lastFetchUrl).toBeNull()
    })

    test('refuses a hidden model without contacting Shogo Cloud (Anthropic-native)', async () => {
      visibilityRows = ['claude-3-haiku-20240307']
      invalidate('ws-1')
      const app = buildApp()
      const res = await app.fetch(new Request('http://x/api/ai/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: 'hi' }] }),
      }))

      expect(res.status).toBe(403)
      expect(lastFetchUrl).toBeNull()
    })

    test('forwards a model that the allowlist includes', async () => {
      visibilityRows = ['gpt-4o-mini']
      invalidate('ws-1')
      nextFetchResponses.push(() => new Response(JSON.stringify({ id: 'chatcmpl_ok', choices: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      const app = buildApp()
      const res = await app.fetch(new Request('http://x/api/ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
      }))

      expect(res.status).toBe(200)
      expect(lastFetchUrl).toBe('https://cloud.example/api/ai/v1/chat/completions')
    })
  })
})

/**
 * SHO-74: the media / 3D / audio families were local-only, so a cloud-authed
 * desktop with no BYOK keys answered `provider_not_configured` (or an empty
 * catalogue) no matter what the cloud had saved. One router-level forwarder
 * covers all five prefixes so a new media route can't be local-only by
 * accident — and so a job created in cloud is polled in cloud.
 */
describe('AI proxy media / 3D / audio cloud forwarding', () => {
  test('serves the cloud 3D catalogue on a keyless cloud-authed desktop', async () => {
    nextFetchResponses.push(() => new Response(JSON.stringify({
      models: [{ id: 'tripo-v2', provider: 'tripo' }],
      operations: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/3d/models', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }))

    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe('https://cloud.example/api/ai/v1/3d/models')
    const sent = new Headers(lastFetchInit?.headers)
    expect(sent.get('Authorization')).toBe('Bearer shogo_sk_cloud')
    expect(sent.get('x-shogo-client')).toBe('desktop')
    expect((await res.json() as any).models[0].id).toBe('tripo-v2')
    expect(billingCalls).toEqual([])
    expect(captureCalls).toEqual([])
  })

  test('keeps the query string when forwarding the media catalogue', async () => {
    nextFetchResponses.push(() => new Response(JSON.stringify({ images: [], videos: [], utilities: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))

    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/media/models?provider=higgsfield', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }))

    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe('https://cloud.example/api/ai/v1/media/models?provider=higgsfield')
  })

  test('forwards an image generation with its JSON body intact and opens no local capture', async () => {
    nextFetchResponses.push(() => new Response(JSON.stringify({
      data: [{ b64_json: 'aGk=' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const body = { model: 'gpt-image-1', prompt: 'a red cube', size: '1024x1024', n: 1 }
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    }))

    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe('https://cloud.example/api/ai/v1/images/generations')
    expect(JSON.parse(await new Response(lastFetchInit?.body as any).text())).toEqual(body)
    expect(new Headers(lastFetchInit?.headers).get('Content-Type')).toBe('application/json')
    expect((await res.json() as any).data[0].b64_json).toBe('aGk=')
    // Cloud bills the generation; a local capture or balance gate would double-bill.
    expect(billingCalls).toEqual([])
    expect(captureCalls).toEqual([])
  })

  test('forwards a 3D generation and its job poll without a local billing capture', async () => {
    nextFetchResponses.push(() => new Response(JSON.stringify({ id: 'job-1', status: 'queued' }), {
      status: 202, headers: { 'Content-Type': 'application/json' },
    }))
    const app = buildApp()
    const created = await app.fetch(new Request('http://x/api/ai/v1/3d/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: 'tripo-v2', prompt: 'a wooden chair' }),
    }))
    expect(created.status).toBe(202)
    expect(lastFetchUrl).toBe('https://cloud.example/api/ai/v1/3d/generations')

    // The poll has to be answered by the instance that owns the job.
    nextFetchResponses.push(() => new Response(JSON.stringify({ id: 'job-1', status: 'succeeded' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    const polled = await app.fetch(new Request('http://x/api/ai/v1/3d/job-1', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }))
    expect(polled.status).toBe(200)
    expect(lastFetchUrl).toBe('https://cloud.example/api/ai/v1/3d/job-1')

    expect(billingCalls).toEqual([])
    expect(captureCalls).toEqual([])
  })

  test('forwards a multipart transcription with the multipart body and boundary intact', async () => {
    nextFetchResponses.push(() => new Response(JSON.stringify({ text: 'hello there' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))

    const form = new FormData()
    form.set('model', 'gpt-4o-transcribe')
    form.set('file', new File([new Uint8Array([1, 2, 3, 4])], 'note.webm', { type: 'audio/webm' }))

    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: form,
    }))

    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe('https://cloud.example/api/ai/v1/audio/transcriptions')
    expect(new Headers(lastFetchInit?.headers).get('content-type')).toContain('multipart/form-data; boundary=')
    const forwarded = await new Response(lastFetchInit?.body as any).formData()
    expect(forwarded.get('model')).toBe('gpt-4o-transcribe')
    const file = forwarded.get('file') as File
    expect(file.name).toBe('note.webm')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect((await res.json() as any).text).toBe('hello there')
    expect(captureCalls).toEqual([])
  })

  test('rejects an unauthenticated media request before it reaches the cloud', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/ai/v1/3d/models'))

    expect(res.status).toBe(401)
    expect((await res.json() as any).error.code).toBe('invalid_api_key')
    expect(lastFetchUrl).toBeNull()
  })

  test('AI_MODE=api-keys never forwards: local behaviour is unchanged', async () => {
    process.env.AI_MODE = 'api-keys'
    const app = buildApp()

    // No local Tripo key → the same empty catalogue as before this change.
    const models = await app.fetch(new Request('http://x/api/ai/v1/3d/models', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }))
    expect(models.status).toBe(200)
    expect((await models.json() as any).models).toEqual([])
    expect(lastFetchUrl).toBeNull()

    // No local OpenAI key → the same `provider_not_configured` 503.
    const image = await app.fetch(new Request('http://x/api/ai/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: 'gpt-image-1', prompt: 'a red cube' }),
    }))
    expect(image.status).toBe(503)
    expect((await image.json() as any).error.code).toBe('provider_not_configured')
    expect(lastFetchUrl).toBeNull()
  })
})

afterAll(() => {
  globalThis.fetch = originalFetch
})
