// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.AI_PROXY_SECRET = 'cloud-forward-test-secret'
process.env.SHOGO_API_KEY = 'shogo_sk_cloud'
process.env.SHOGO_CLOUD_URL = 'https://cloud.example/'
process.env.SHOGO_LOCAL_MODE = 'true'
delete process.env.AI_MODE

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
      findUnique: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
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
  hasBalance: async () => true,
  hasAdvancedModelAccess: async () => true,
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 100 }),
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
  getProjectUser: () => 'user-1',
}))

mock.module('../lib/cloud-key-wipe', () => ({
  wipeCloudKey: async () => {},
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
})

afterAll(() => {
  globalThis.fetch = originalFetch
})
