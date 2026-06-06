// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Regression suite for the OpenAI-compatible → Anthropic conversion path
// (`convertToAnthropicFormat`). The Diablo 4 tactician
// (`workspaces/<projectId>/src/lib/pilot/tactician.ts`) sets
// `providerOptions.anthropic.cacheControl` on its system message via the
// Vercel AI SDK; before this fix the proxy's allow-list rebuild discarded
// the field, so Anthropic reported `cache_creation_input_tokens: 0` and
// `ephemeral_5m_input_tokens: 0` no matter how many times the bot reused the
// same prompt. The assertions below pin down the wire body the proxy sends
// to Anthropic so future refactors can't silently regress prompt caching.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// Snapshot env vars we mutate so we can restore them in afterAll. Several
// other test files (ai-proxy-e2e, ai-proxy-image-endpoints) gate real API
// calls on `process.env.ANTHROPIC_API_KEY` being unset; leaking our stub key
// would cause those tests to attempt real fetches and fail.
const ORIGINAL_ENV = {
  AI_PROXY_SECRET: process.env.AI_PROXY_SECRET,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  SHOGO_LOCAL_MODE: process.env.SHOGO_LOCAL_MODE,
  SHOGO_API_KEY: process.env.SHOGO_API_KEY,
  SHOGO_CLOUD_URL: process.env.SHOGO_CLOUD_URL,
  AI_MODE: process.env.AI_MODE,
}

process.env.AI_PROXY_SECRET = 'provider-options-test-secret'
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.SHOGO_LOCAL_MODE = 'true'
// Explicitly disable Shogo Cloud forwarding so the proxy runs
// `convertToAnthropicFormat` itself instead of pass-through to the cloud.
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
    return (next ? next() : new Response(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any
  }) as any
})

beforeEach(() => {
  lastFetchUrl = null
  lastFetchInit = undefined
  nextFetchResponses = []
  delete process.env.SHOGO_API_KEY
  delete process.env.SHOGO_CLOUD_URL
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

/** Posts a chat-completion body and returns the JSON the proxy forwarded to Anthropic. */
async function postAndCapture(body: unknown): Promise<any> {
  const app = buildApp()
  const res = await app.fetch(new Request('http://x/api/ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  }))
  // Non-stream path goes through proxyAnthropicNonStream which makes one fetch.
  expect(res.status).toBeLessThan(500)
  return JSON.parse(String(lastFetchInit?.body))
}

describe('AI proxy: providerOptions.anthropic.cacheControl on OpenAI-compatible path', () => {
  test('system message with providerOptions.anthropic.cacheControl → system becomes a block array with cache_control', async () => {
    const forwarded = await postAndCapture({
      model: 'claude-haiku-4-5',
      messages: [
        {
          role: 'system',
          content: 'You are the tactician.',
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        },
        { role: 'user', content: 'pick a primitive' },
      ],
    })

    expect(lastFetchUrl).toBe('https://api.anthropic.com/v1/messages')
    expect(Array.isArray(forwarded.system)).toBe(true)
    expect(forwarded.system).toEqual([
      { type: 'text', text: 'You are the tactician.', cache_control: { type: 'ephemeral' } },
    ])
    // No leftover providerOptions on the outbound body.
    expect(forwarded.providerOptions).toBeUndefined()
    expect(forwarded.messages[0].providerOptions).toBeUndefined()
  })

  test('top-level providerOptions.anthropic.cacheControl → applied to last system block AND last user content block', async () => {
    const forwarded = await postAndCapture({
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'system', content: 'System.' },
        { role: 'user', content: 'User.' },
      ],
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '5m' } } },
    })

    expect(forwarded.system).toEqual([
      { type: 'text', text: 'System.', cache_control: { type: 'ephemeral', ttl: '5m' } },
    ])
    // User string content is promoted to a single text block so the cache
    // anchor has somewhere to live.
    expect(forwarded.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'User.', cache_control: { type: 'ephemeral', ttl: '5m' } }],
      },
    ])
  })

  test('per-content-block providerOptions → cache_control only on that block, siblings untouched', async () => {
    const forwarded = await postAndCapture({
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'system', content: 'Sys.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'first' },
            {
              type: 'text',
              text: 'cached middle',
              providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
            },
            { type: 'text', text: 'last' },
          ],
        },
      ],
    })

    const userBlocks = forwarded.messages[0].content
    expect(userBlocks).toHaveLength(3)
    expect(userBlocks[0]).toEqual({ type: 'text', text: 'first' })
    expect(userBlocks[1]).toEqual({
      type: 'text',
      text: 'cached middle',
      cache_control: { type: 'ephemeral' },
    })
    expect(userBlocks[2]).toEqual({ type: 'text', text: 'last' })
    // providerOptions never leaks onto the wire.
    expect(userBlocks.some((b: any) => 'providerOptions' in b)).toBe(false)
  })

  test('pre-translated cache_control on content blocks is preserved verbatim', async () => {
    const forwarded = await postAndCapture({
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'system', content: 'Sys.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'cached', cache_control: { type: 'ephemeral', ttl: '1h' } },
            { type: 'text', text: 'tail' },
          ],
        },
      ],
    })

    const userBlocks = forwarded.messages[0].content
    expect(userBlocks[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(userBlocks[1].cache_control).toBeUndefined()
  })

  test('per-message providerOptions on a user message → cache_control on the last block of that message', async () => {
    const forwarded = await postAndCapture({
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'system', content: 'Sys.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        },
      ],
    })

    const blocks = forwarded.messages[0].content
    expect(blocks[0].cache_control).toBeUndefined()
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' })
  })

  test('no cache metadata anywhere → fast-path: system stays a plain string, messages pass through unchanged', async () => {
    const forwarded = await postAndCapture({
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'system', content: 'Sys.' },
        { role: 'user', content: 'hi' },
      ],
    })

    expect(typeof forwarded.system).toBe('string')
    expect(forwarded.system).toBe('Sys.')
    expect(forwarded.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  test('tools, temperature, max_tokens still flow through when cache metadata is present', async () => {
    const forwarded = await postAndCapture({
      model: 'claude-haiku-4-5',
      temperature: 0.1,
      max_tokens: 1024,
      tools: [{
        type: 'function',
        function: {
          name: 'noop',
          description: 'does nothing',
          parameters: { type: 'object', properties: {} },
        },
      }],
      tool_choice: 'auto',
      messages: [
        {
          role: 'system',
          content: 'Sys.',
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        },
        { role: 'user', content: 'hi' },
      ],
    })

    expect(forwarded.temperature).toBe(0.1)
    expect(forwarded.max_tokens).toBe(1024)
    expect(forwarded.tools).toEqual([{
      name: 'noop',
      description: 'does nothing',
      input_schema: { type: 'object', properties: {} },
    }])
    expect(forwarded.tool_choice).toEqual({ type: 'auto' })
    expect(forwarded.system[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  test('does not overwrite pre-existing cache_control with a different per-message directive', async () => {
    const forwarded = await postAndCapture({
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'system', content: 'Sys.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'pre', cache_control: { type: 'ephemeral', ttl: '1h' } },
          ],
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        },
      ],
    })

    // Pre-existing wire cache_control (with ttl=1h) must win over the
    // per-message providerOptions (which has no ttl).
    expect(forwarded.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })
})

// Regression: OpenAI reasoning models (and pi-ai's openai-completions provider)
// carry the system prompt under the `developer` role. When the proxy resolves a
// model to Anthropic it must fold `developer` into the `system` parameter
// instead of forwarding it verbatim — Anthropic rejects unknown roles with
// `400 messages: Unexpected role "developer"`.
describe('AI proxy: developer role (OpenAI reasoning) → Anthropic system', () => {
  test('developer message becomes the system prompt; no developer role on the wire', async () => {
    const forwarded = await postAndCapture({
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'developer', content: 'You are a careful assistant.' },
        { role: 'user', content: 'hi' },
      ],
    })

    expect(lastFetchUrl).toBe('https://api.anthropic.com/v1/messages')
    // Fast path (no cache metadata): system stays a plain string.
    expect(forwarded.system).toBe('You are a careful assistant.')
    expect(forwarded.messages).toEqual([{ role: 'user', content: 'hi' }])
    // The forbidden role must not appear anywhere in the outbound messages.
    expect(forwarded.messages.some((m: any) => m.role === 'developer')).toBe(false)
  })

  test('developer message merges with a system message into one system param', async () => {
    const forwarded = await postAndCapture({
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'system', content: 'Base policy.' },
        { role: 'developer', content: 'Extra developer instructions.' },
        { role: 'user', content: 'go' },
      ],
    })

    expect(forwarded.system).toBe('Base policy.\nExtra developer instructions.')
    expect(forwarded.messages).toEqual([{ role: 'user', content: 'go' }])
  })

  test('developer message honors providerOptions cacheControl (hoisted into a system block)', async () => {
    const forwarded = await postAndCapture({
      model: 'claude-haiku-4-5',
      messages: [
        {
          role: 'developer',
          content: 'Cacheable developer prompt.',
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        },
        { role: 'user', content: 'hi' },
      ],
    })

    expect(forwarded.system).toEqual([
      { type: 'text', text: 'Cacheable developer prompt.', cache_control: { type: 'ephemeral' } },
    ])
    expect(forwarded.messages.some((m: any) => m.role === 'developer')).toBe(false)
  })

  test('a tool role is coerced to user (defensive: only user/assistant reach Anthropic)', async () => {
    const forwarded = await postAndCapture({
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'system', content: 'Sys.' },
        { role: 'assistant', content: 'calling a tool' },
        { role: 'tool', content: 'tool output', tool_call_id: 'call_1' },
      ],
    })

    const roles = forwarded.messages.map((m: any) => m.role)
    expect(roles).toEqual(['assistant', 'user'])
    expect(roles.every((r: string) => r === 'user' || r === 'assistant')).toBe(true)
  })
})

afterAll(() => {
  globalThis.fetch = originalFetch
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})
