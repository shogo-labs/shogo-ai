// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Gemini on the OpenAI-compatible path: the wire URL, request normalization,
 * and the thought-signature round trip.
 *
 * Gemini 3+ rejects a replayed function call that is missing the
 * `extra_content.google.thought_signature` it was issued with. The runtime has
 * no field for `extra_content`, so the proxy carries the signature in
 * `reasoning_details` (`type: 'reasoning.encrypted'`, matched by tool-call id)
 * on the way out and puts it back on the tool call on the way in.
 *
 * No external network: `globalThis.fetch` is stubbed.
 *
 *   bun test apps/api/src/__tests__/ai-proxy-google.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const ORIGINAL_ENV = {
  AI_PROXY_SECRET: process.env.AI_PROXY_SECRET,
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  GOOGLE_BASE_URL: process.env.GOOGLE_BASE_URL,
  SHOGO_LOCAL_MODE: process.env.SHOGO_LOCAL_MODE,
  SHOGO_API_KEY: process.env.SHOGO_API_KEY,
  SHOGO_CLOUD_URL: process.env.SHOGO_CLOUD_URL,
  AI_MODE: process.env.AI_MODE,
}

process.env.AI_PROXY_SECRET = 'google-test-secret'
process.env.GOOGLE_API_KEY = 'goog-test'
process.env.GOOGLE_BASE_URL = 'https://google.test/v1beta/openai'
process.env.SHOGO_LOCAL_MODE = 'true'
delete process.env.SHOGO_API_KEY
delete process.env.SHOGO_CLOUD_URL
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
    if (next) return next() as any
    return new Response(JSON.stringify({
      id: 'chatcmpl_google',
      object: 'chat.completion',
      model: 'gemini-3.1-pro-preview',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }) as any
  }) as any
})

afterAll(() => {
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

beforeEach(() => {
  lastFetchUrl = null
  lastFetchInit = undefined
  nextFetchResponses = []
  process.env.GOOGLE_API_KEY = 'goog-test'
  process.env.GOOGLE_BASE_URL = 'https://google.test/v1beta/openai'
})

const { Hono } = await import('hono')
const aiProxyModule = await import('../routes/ai-proxy')
const { aiProxyRoutes, liftGoogleThoughtSignatures, applyGoogleThoughtSignatures, createGoogleSseRewriter } = aiProxyModule
const { generateProxyToken } = await import('../lib/ai-proxy-token')

let TOKEN = ''
beforeAll(async () => {
  TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')
})

const app = new Hono()
app.route('/api', aiProxyRoutes())

const post = (body: unknown) =>
  app.fetch(new Request('http://x/api/ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  }))

const forwardedBody = (): any => JSON.parse(String(lastFetchInit?.body))

const sseResponse = (chunks: string[]) =>
  new Response(new TextEncoder().encode(chunks.map((c) => `data: ${c}\n\n`).join('')), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })

const drain = async (res: Response): Promise<string> => {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out
}

/** Every `data: {...}` payload in a drained SSE body. */
const ssePayloads = (text: string): any[] =>
  text.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6).trim())
    .filter((raw) => raw && raw !== '[DONE]')
    .map((raw) => JSON.parse(raw))

const SIG = 'c2lnbmF0dXJlLWJ5dGVz'

// =========================================================================
// Pure helpers
// =========================================================================

describe('Gemini thought signatures — helpers', () => {
  test('lift moves a signature off the tool call into reasoning_details', () => {
    const payload = {
      choices: [{
        message: {
          role: 'assistant',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' }, extra_content: { google: { thought_signature: SIG } } }],
        },
      }],
    }
    expect(liftGoogleThoughtSignatures(payload)).toBe(true)
    const message: any = payload.choices[0].message
    expect(message.tool_calls[0].extra_content).toBeUndefined()
    expect(message.reasoning_details).toEqual([{ type: 'reasoning.encrypted', id: 'call_1', data: SIG }])
  })

  test('lift leaves a payload with no signature untouched', () => {
    const payload = { choices: [{ message: { role: 'assistant', content: 'hi' } }] }
    expect(liftGoogleThoughtSignatures(payload)).toBe(false)
  })

  test('apply restores the signature by id and uses the skip value for unknown calls', () => {
    const out = applyGoogleThoughtSignatures([
      { role: 'developer', content: 'sys' },
      {
        role: 'assistant',
        reasoning_content: 'thinking…',
        reasoning_details: [{ type: 'reasoning.encrypted', id: 'call_1', data: SIG }],
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      },
    ])
    expect(out[0].role).toBe('system')
    expect(out[1].reasoning_details).toBeUndefined()
    expect(out[1].reasoning_content).toBeUndefined()
    expect(out[1].tool_calls[0].extra_content).toEqual({ google: { thought_signature: SIG } })
    expect(out[1].tool_calls[1].extra_content).toEqual({ google: { thought_signature: 'skip_thought_signature_validator' } })
  })

  test('the SSE rewriter attaches a late signature to the call id it saw earlier', () => {
    const rewrite = createGoogleSseRewriter()
    const first = rewrite(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'exec', arguments: '' } }] } }] })}`)
    expect(JSON.parse(first.slice(6)).choices[0].delta.reasoning_details).toBeUndefined()
    const later = rewrite(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, extra_content: { google: { thought_signature: SIG } } }] } }] })}`)
    const delta = JSON.parse(later.slice(6)).choices[0].delta
    expect(delta.tool_calls[0].extra_content).toBeUndefined()
    expect(delta.reasoning_details).toEqual([{ type: 'reasoning.encrypted', id: 'call_9', data: SIG }])
    expect(rewrite('data: [DONE]')).toBe('data: [DONE]')
  })
})

// =========================================================================
// Through the proxy route
// =========================================================================

describe('POST /ai/v1/chat/completions — Gemini', () => {
  test('routes to Google\'s OpenAI endpoint with the Google key and a normalized body', async () => {
    const res = await post({
      model: 'gemini-3.1-pro-preview',
      store: true,
      reasoning_effort: 'none',
      messages: [
        { role: 'developer', content: 'be brief' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          reasoning_details: [{ type: 'reasoning.encrypted', id: 'call_1', data: SIG }],
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
      ],
    })
    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe('https://google.test/v1beta/openai/chat/completions')
    expect((lastFetchInit?.headers as Record<string, string>).Authorization).toBe('Bearer goog-test')

    const body = forwardedBody()
    expect(body.model).toBe('gemini-3.1-pro-preview')
    expect(body.store).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[2].reasoning_details).toBeUndefined()
    expect(body.messages[2].tool_calls[0].extra_content).toEqual({ google: { thought_signature: SIG } })
  })

  test('non-streaming: the response signature comes back in reasoning_details', async () => {
    nextFetchResponses.push(() => new Response(JSON.stringify({
      id: 'chatcmpl_g',
      object: 'chat.completion',
      model: 'gemini-3.1-pro-preview',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_7', type: 'function', function: { name: 'exec', arguments: '{}' }, extra_content: { google: { thought_signature: SIG } } }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const res = await post({ model: 'gemini-3.1-pro-preview', messages: [{ role: 'user', content: 'run it' }] })
    expect(res.status).toBe(200)
    const data: any = await res.json()
    const message = data.choices[0].message
    expect(message.tool_calls[0].extra_content).toBeUndefined()
    expect(message.reasoning_details).toEqual([{ type: 'reasoning.encrypted', id: 'call_7', data: SIG }])
  })

  test('streaming: the signature is rewritten into reasoning_details on the delta', async () => {
    nextFetchResponses.push(() => sseResponse([
      JSON.stringify({ id: 's1', object: 'chat.completion.chunk', model: 'gemini-3.1-pro-preview', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_3', type: 'function', function: { name: 'exec', arguments: '{}' }, extra_content: { google: { thought_signature: SIG } } }] } }] }),
      JSON.stringify({ id: 's1', object: 'chat.completion.chunk', model: 'gemini-3.1-pro-preview', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }),
      '[DONE]',
    ]))

    const res = await post({ model: 'gemini-3.1-pro-preview', stream: true, messages: [{ role: 'user', content: 'go' }] })
    expect(res.status).toBe(200)
    const payloads = ssePayloads(await drain(res))
    const withCall = payloads.find((p) => p.choices?.[0]?.delta?.tool_calls)
    expect(withCall).toBeDefined()
    expect(withCall.choices[0].delta.tool_calls[0].extra_content).toBeUndefined()
    expect(withCall.choices[0].delta.reasoning_details).toEqual([{ type: 'reasoning.encrypted', id: 'call_3', data: SIG }])
  })
})
