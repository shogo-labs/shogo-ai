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
const {
  aiProxyRoutes,
  liftGoogleThoughtSignatures,
  applyGoogleThoughtSignatures,
  createGoogleSseRewriter,
  splitGoogleThoughtMessage,
  googleThinkingLevel,
  buildOpenAICompatibleBody,
} = aiProxyModule
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

// =========================================================================
// Thinking summaries — request body
// =========================================================================

const effortLevels: Array<[string | undefined, string, string]> = [
  // [reasoning_effort sent, model, expected thinking_level]
  ['off', 'gemini-4-carbon', 'low'],
  ['none', 'gemini-4-carbon', 'low'],
  ['minimal', 'gemini-4-carbon', 'low'],
  ['low', 'gemini-4-carbon', 'low'],
  ['medium', 'gemini-4-carbon', 'medium'],
  ['high', 'gemini-4-carbon', 'high'],
  ['xhigh', 'gemini-4-carbon', 'high'],
  [undefined, 'gemini-4-carbon', 'medium'],
]

describe('Gemini thinking summaries — request body', () => {
  for (const [effort, model, level] of effortLevels) {
    test(`effort ${effort ?? '(missing)'} on ${model} → thinking_level ${level}`, async () => {
      const res = await post({
        model,
        ...(effort ? { reasoning_effort: effort } : {}),
        messages: [{ role: 'user', content: 'hi' }],
      })
      expect(res.status).toBe(200)
      const body = forwardedBody()
      expect(body.extra_body.google.thinking_config).toEqual({ thinking_level: level, include_thoughts: true })
      // Google rejects the two controls together.
      expect(body.reasoning_effort).toBeUndefined()
    })
  }

  test('xhigh is kept on the models that accept it', async () => {
    await post({ model: 'gemini-4-neon', reasoning_effort: 'xhigh', messages: [{ role: 'user', content: 'hi' }] })
    expect(forwardedBody().extra_body.google.thinking_config.thinking_level).toBe('xhigh')
    await post({ model: 'gemini-4-hydrogen', reasoning_effort: 'xhigh', messages: [{ role: 'user', content: 'hi' }] })
    expect(forwardedBody().extra_body.google.thinking_config.thinking_level).toBe('xhigh')
  })

  test('the Flash family keeps minimal so flash-lite does not get more expensive', async () => {
    await post({ model: 'gemini-3.5-flash-lite', reasoning_effort: 'minimal', messages: [{ role: 'user', content: 'hi' }] })
    expect(forwardedBody().extra_body.google.thinking_config.thinking_level).toBe('minimal')
    await post({ model: 'gemini-3.5-flash-lite', reasoning_effort: 'off', messages: [{ role: 'user', content: 'hi' }] })
    expect(forwardedBody().extra_body.google.thinking_config.thinking_level).toBe('minimal')
    await post({ model: 'gemini-3.8-flash', reasoning_effort: 'none', messages: [{ role: 'user', content: 'hi' }] })
    expect(forwardedBody().extra_body.google.thinking_config.thinking_level).toBe('minimal')
  })

  test('a caller that sends no effort at all gets the catalog default', async () => {
    // pi-ai sends no `reasoning_effort` for a thinking-off caller (compaction,
    // plan translation, local LLM). Flash-Lite's catalog default is minimal —
    // flooring it at low would quietly raise the cost of every summary.
    await post({ model: 'gemini-3.5-flash-lite', messages: [{ role: 'user', content: 'summarise' }] })
    expect(forwardedBody().extra_body.google.thinking_config.thinking_level).toBe('minimal')
    await post({ model: 'gemini-4-argon', messages: [{ role: 'user', content: 'summarise' }] })
    expect(forwardedBody().extra_body.google.thinking_config.thinking_level).toBe('high')
  })

  test('providerOptions.shogo.reasoning_effort wins over the field pi-ai sent', async () => {
    await post({
      model: 'gemini-4-carbon',
      reasoning_effort: 'high',
      providerOptions: { shogo: { reasoning_effort: 'low' } },
      messages: [{ role: 'user', content: 'hi' }],
    })
    const body = forwardedBody()
    expect(body.extra_body.google.thinking_config.thinking_level).toBe('low')
    expect(body.providerOptions).toBeUndefined()
  })

  test('a caller-supplied thinking_config is merged, not replaced', async () => {
    await post({
      model: 'gemini-4-carbon',
      reasoning_effort: 'high',
      extra_body: { google: { thinking_config: { thinking_budget: 1234 }, safety_settings: [{ category: 'x' }] } },
      messages: [{ role: 'user', content: 'hi' }],
    })
    const body = forwardedBody()
    expect(body.extra_body.google.thinking_config).toEqual({
      thinking_budget: 1234,
      thinking_level: 'high',
      include_thoughts: true,
    })
    expect(body.extra_body.google.safety_settings).toEqual([{ category: 'x' }])
  })

  test('googleThinkingLevel maps the unknown-model fallback', () => {
    expect(googleThinkingLevel('gemini-9-unheard-of', 'xhigh')).toBe('high')
    expect(googleThinkingLevel('gemini-9-unheard-of', 'minimal')).toBe('low')
    expect(googleThinkingLevel('gemini-9-unheard-of', undefined)).toBe('medium')
  })
})

// =========================================================================
// Thinking summaries — stream rewriter
// =========================================================================

/** QA's 2026-11-23 capture: gemini-4-carbon, OpenAI-compatible endpoint. */
const thoughtChunks = [
  JSON.stringify({
    id: 'chatcmpl-t',
    object: 'chat.completion.chunk',
    model: 'gemini-4-carbon',
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        content: '<thought>**Solving the Riddle**\n\nBall plus bat is $1.10.',
        extra_content: { google: { thought: true } },
      },
    }],
  }),
  JSON.stringify({
    id: 'chatcmpl-t',
    object: 'chat.completion.chunk',
    model: 'gemini-4-carbon',
    choices: [{ index: 0, delta: { content: '</thought>The ball costs **5 cents**.' } }],
  }),
  JSON.stringify({
    id: 'chatcmpl-t',
    object: 'chat.completion.chunk',
    model: 'gemini-4-carbon',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 },
  }),
  '[DONE]',
]

const rewriteAll = (chunks: string[]): any[] => {
  const rewrite = createGoogleSseRewriter()
  const out: any[] = []
  for (const chunk of chunks) {
    const rewritten = rewrite(`data: ${chunk}`)
    for (const line of Array.isArray(rewritten) ? rewritten : [rewritten]) {
      if (line === 'data: [DONE]') continue
      out.push(JSON.parse(line.slice(6)))
    }
  }
  const flushed = rewrite.flush?.()
  for (const line of Array.isArray(flushed) ? flushed : flushed ? [flushed] : []) {
    out.push(JSON.parse(line.slice(6)))
  }
  return out
}

const deltas = (payloads: any[]): any[] => payloads.map((p) => p.choices[0].delta)

describe('Gemini thinking summaries — stream rewriter', () => {
  test('a thought chunk becomes reasoning_content with the tag removed', async () => {
    nextFetchResponses.push(() => sseResponse(thoughtChunks))
    const res = await post({ model: 'gemini-4-carbon', stream: true, messages: [{ role: 'user', content: 'riddle' }] })
    expect(res.status).toBe(200)
    const body = await drain(res)
    const payloads = ssePayloads(body)

    const reasoning = payloads.filter((p) => p.choices?.[0]?.delta?.reasoning_content)
    expect(reasoning).toHaveLength(1)
    expect(reasoning[0].choices[0].delta.reasoning_content).toBe('**Solving the Riddle**\n\nBall plus bat is $1.10.')

    const answer = payloads.find((p) => typeof p.choices?.[0]?.delta?.content === 'string' && p.choices[0].delta.content)
    expect(answer.choices[0].delta.content).toBe('The ball costs **5 cents**.')
    // The answer must come *after* the thinking, not inside it and not before.
    expect(payloads.indexOf(answer)).toBeGreaterThan(payloads.indexOf(reasoning[0]))

    for (const payload of payloads) {
      expect(JSON.stringify(payload)).not.toContain('<thought>')
      expect(JSON.stringify(payload)).not.toContain('</thought>')
    }
    // The Google marker is consumed, not forwarded.
    expect(JSON.stringify(payloads)).not.toContain('"thought":true')
  })

  test('a closing tag with no open thought is literal text', async () => {
    const payloads = rewriteAll([
      JSON.stringify({ choices: [{ index: 0, delta: { content: '</thought>just text' } }] }),
    ])
    expect(deltas(payloads)[0].content).toBe('</thought>just text')
  })

  test('a closing tag and its answer in one chunk are emitted as two lines', () => {
    const rewrite = createGoogleSseRewriter()
    rewrite(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '<thought>thinking, ', extra_content: { google: { thought: true } } } }] })}`)
    const out = rewrite(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'still thinking</thought>the answer' } }] })}`)
    expect(Array.isArray(out)).toBe(true)
    const lines = out as string[]
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0].slice(6)).choices[0].delta
    const second = JSON.parse(lines[1].slice(6)).choices[0].delta
    expect(first.reasoning_content).toBe('still thinking')
    expect(first.content).toBeUndefined()
    expect(second.content).toBe('the answer')
    expect(second.reasoning_content).toBeUndefined()
  })

  test('a tag split across two chunks is released across them', async () => {
    nextFetchResponses.push(() => sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: '<thought>first half</thou', extra_content: { google: { thought: true } } } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'ght>the answer' } }] }),
      '[DONE]',
    ]))
    const res = await post({ model: 'gemini-4-carbon', stream: true, messages: [{ role: 'user', content: 'go' }] })
    const payloads = ssePayloads(await drain(res))
    const reasoning = payloads.map((p) => p.choices?.[0]?.delta?.reasoning_content).filter(Boolean)
    expect(reasoning).toEqual(['first half'])
    const content = payloads.map((p) => p.choices?.[0]?.delta?.content).filter(Boolean)
    expect(content).toEqual(['the answer'])
  })

  test('held text is flushed when the stream ends without closing the tag', async () => {
    nextFetchResponses.push(() => sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: '<thought>a thought ending in </thou', extra_content: { google: { thought: true } } } }] }),
      '[DONE]',
    ]))
    const res = await post({ model: 'gemini-4-carbon', stream: true, messages: [{ role: 'user', content: 'go' }] })
    const payloads = ssePayloads(await drain(res))
    const reasoning = payloads.map((p) => p.choices?.[0]?.delta?.reasoning_content).filter(Boolean).join('')
    expect(reasoning).toBe('a thought ending in </thou')
  })

  test('a reply that quotes <thought> mid-answer passes through untouched', async () => {
    const quoted = 'Use the literal <thought> and </thought> tags.'
    const payloads = rewriteAll([
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'Answer first.' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: quoted } }] }),
    ])
    expect(deltas(payloads).map((d) => d.content).filter(Boolean)).toEqual(['Answer first.', quoted])
  })

  test('a tool-call-only stream is byte-identical', async () => {
    const chunks = [
      JSON.stringify({ id: 's1', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'exec', arguments: '' } }] } }] }),
      JSON.stringify({ id: 's1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }] } }] }),
      JSON.stringify({ id: 's1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }),
      '[DONE]',
    ]
    nextFetchResponses.push(() => sseResponse(chunks))
    const res = await post({ model: 'gemini-4-carbon', stream: true, messages: [{ role: 'user', content: 'list' }] })
    const out = await drain(res)
    expect(out).toBe(chunks.map((c) => `data: ${c}\n\n`).join(''))
  })

  test('non-streaming: one message is split into reasoning_content and content', async () => {
    nextFetchResponses.push(() => new Response(JSON.stringify({
      id: 'chatcmpl-n',
      object: 'chat.completion',
      model: 'gemini-4-carbon',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: '<thought>Let me solve it.</thought>The ball costs **5 cents**.',
          extra_content: { google: { thought: false } },
        },
      }],
      usage: { prompt_tokens: 11, completion_tokens: 9, total_tokens: 20 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const res = await post({ model: 'gemini-4-carbon', messages: [{ role: 'user', content: 'riddle' }] })
    const data: any = await res.json()
    const message = data.choices[0].message
    expect(message.reasoning_content).toBe('Let me solve it.')
    expect(message.content).toBe('The ball costs **5 cents**.')
    expect(message.extra_content).toBeUndefined()
  })

  test('splitGoogleThoughtMessage leaves a plain message alone', () => {
    const payload = { choices: [{ message: { role: 'assistant', content: 'no thinking here' } }] }
    expect(splitGoogleThoughtMessage(payload)).toBe(false)
    expect(payload.choices[0].message.content).toBe('no thinking here')
  })
})

// =========================================================================
// Replay
// =========================================================================

describe('Gemini thinking summaries — replay', () => {
  const modelConfig = { provider: 'google' as const, apiModel: 'gemini-4-carbon', displayName: 'Carbon' }

  test('thought text from pi-ai never goes back to Google as content', () => {
    const body: any = buildOpenAICompatibleBody(
      {
        model: 'gemini-4-carbon',
        messages: [
          { role: 'user', content: 'riddle' },
          {
            role: 'assistant',
            content: null,
            reasoning_content: 'thinking out loud',
            reasoning_details: [{ type: 'reasoning.encrypted', id: 'call_1', data: SIG }],
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
        ],
      },
      modelConfig as any,
      {},
    )
    const assistant = body.messages[1]
    expect(assistant.reasoning_content).toBeUndefined()
    expect(assistant.reasoning_details).toBeUndefined()
    expect(assistant.content).toBeNull()
    expect(JSON.stringify(assistant)).not.toContain('thinking out loud')
    // …and the turn-1 signature is still on the turn-2 tool call.
    expect(assistant.tool_calls[0].extra_content).toEqual({ google: { thought_signature: SIG } })
  })

  test('every Gemini request asks for a thought summary, including a thinking-off caller', () => {
    const body: any = buildOpenAICompatibleBody(
      {
        model: 'gemini-4-carbon',
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: 'summarise' }],
      },
      modelConfig as any,
      {},
    )
    expect(body.thinking).toBeUndefined()
    expect(body.extra_body.google.thinking_config).toEqual({ thinking_level: 'medium', include_thoughts: true })
  })
})

const CAPTURE_TEXT_CHUNKS = [
  "{\"choices\":[{\"delta\":{\"content\":\"<thought>**Solving the Riddle**\\n\\nI've got the riddle now. I'm focusing on breaking it down mathematically. I'm letting 'x' represent the ball's cost. Next, I need to express the bat's cost in terms of 'x'. Then, I can set up an equation using the total cost.\\n\\n\\n\",\"extra_content\":{\"google\":{\"thought\":true}},\"role\":\"assistant\"},\"index\":0}],\"created\":1795399391,\"id\":\"2Z4Da7HUGue-vr0P7f3b2QU\",\"model\":\"gemini-4-carbon\",\"object\":\"chat.completion.chunk\",\"usage\":{\"completion_tokens\":0,\"prompt_tokens\":110,\"total_tokens\":233}}",
  "{\"choices\":[{\"delta\":{\"content\":\"</thought>The ball costs **5 cents ($0.05)**.\",\"role\":\"assistant\"},\"index\":0}],\"created\":1795399393,\"id\":\"2Z4Da7HUGue-vr0P7f3b2QU\",\"model\":\"gemini-4-carbon\",\"object\":\"chat.completion.chunk\",\"usage\":{\"completion_tokens\":12,\"prompt_tokens\":110,\"total_tokens\":426}}",
  "{\"choices\":[{\"delta\":{\"content\":\" \\n\\n**Explanation:** \\nIf the ball costs $0.05, and the bat costs $1.00\",\"role\":\"assistant\"},\"index\":0}],\"created\":1795399393,\"id\":\"2Z4Da7HUGue-vr0P7f3b2QU\",\"model\":\"gemini-4-carbon\",\"object\":\"chat.completion.chunk\",\"usage\":{\"completion_tokens\":38,\"prompt_tokens\":110,\"total_tokens\":452}}",
  "{\"choices\":[{\"delta\":{\"content\":\" more than the ball, then the bat costs $1.05. Together, $0.05 + $1.\",\"role\":\"assistant\"},\"index\":0}],\"created\":1795399393,\"id\":\"2Z4Da7HUGue-vr0P7f3b2QU\",\"model\":\"gemini-4-carbon\",\"object\":\"chat.completion.chunk\",\"usage\":{\"completion_tokens\":64,\"prompt_tokens\":110,\"total_tokens\":478}}",
  "{\"choices\":[{\"delta\":{\"content\":\"05 = $1.10. \\n\\n*(Note: A common intuitive guess is $0.10,\",\"role\":\"assistant\"},\"index\":0}],\"created\":1795399393,\"id\":\"2Z4Da7HUGue-vr0P7f3b2QU\",\"model\":\"gemini-4-carbon\",\"object\":\"chat.completion.chunk\",\"usage\":{\"completion_tokens\":89,\"prompt_tokens\":110,\"total_tokens\":503}}",
  "{\"choices\":[{\"delta\":{\"content\":\" which doesn't work because the bat would then cost $1.10, bringing the total to $1.20.)*\",\"role\":\"assistant\"},\"index\":0}],\"created\":1795399394,\"id\":\"2Z4Da7HUGue-vr0P7f3b2QU\",\"model\":\"gemini-4-carbon\",\"object\":\"chat.completion.chunk\",\"usage\":{\"completion_tokens\":117,\"prompt_tokens\":110,\"total_tokens\":531}}",
]

const CAPTURE_TOOL_CHUNKS = [
  "{\"choices\":[{\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"extra_content\":{\"google\":{\"thought_signature\":\"EtEBCs4BAWkUfRPUvNtIYsBYFWTFhu9sFLMB640l8gg0WkieGVnypfF05Yxdz+E1AyvRIkhBL8yq4rBRo9FacoEQJT6poy1By/H5c5coFhaVjBpDoRw6AFZ4z14uiPE6xc39xOPkKk6oJ6z0HY8HoKCz+w5bk+iGEyW4yWOm5ynLiLvtZY6ixSeqOdcxgSPcOaIOpIebeqfu6m4Gz5vT5mqQKQAc5S7l6AbEFqj5Qflm38Oogoz6KECCPZXb1FY7NaMHudUarmh+IB9QYgOPG4goew4=\"}},\"function\":{\"arguments\":\"{\\\"path\\\":\\\"src/App.tsx\\\"}\",\"name\":\"read_file\"},\"id\":\"call_11906536371955678501\",\"type\":\"function\"}]},\"index\":0}],\"created\":1795399387,\"id\":\"2Z4Da9bGEMCw2roPk76t6Q4\",\"model\":\"gemini-4-carbon\",\"object\":\"chat.completion.chunk\",\"usage\":{\"completion_tokens\":20,\"prompt_tokens\":102,\"total_tokens\":137}}",
  "{\"choices\":[{\"delta\":{\"role\":\"assistant\"},\"finish_reason\":\"stop\",\"index\":0}],\"created\":1795399387,\"id\":\"2Z4Da9bGEMCw2roPk76t6Q4\",\"model\":\"gemini-4-carbon\",\"object\":\"chat.completion.chunk\",\"usage\":{\"completion_tokens\":26,\"prompt_tokens\":102,\"total_tokens\":143}}",
]

// =========================================================================
// QA gate: the live 2026-11-23 capture, replayed through the route
// =========================================================================
//
// `gemini-4-carbon` on Google's OpenAI-compatible endpoint, captured live by QA
// on 2026-11-23 with `extra_body.google.thinking_config = { thinking_level:
// 'medium', include_thoughts: true }`. These are the exact bytes the endpoint
// sent; the unit-level fixtures above are hand-built, these are not.
//
// The capture's last line is a message-level `thought_signature` chunk, which
// the capture script truncated at 900 characters, so it is rebuilt here with a
// stand-in signature — the rewriter treats it as opaque.

const CAPTURE_SIGNATURE_CHUNK = JSON.stringify({
  choices: [{ delta: { extra_content: { google: { thought_signature: 'Ep0JCpoJ-capture' } }, role: 'assistant' }, index: 0 }],
  created: 1795399394,
  id: '2Z4Da7HUGue-vr0P7f3b2QU',
  model: 'gemini-4-carbon',
  object: 'chat.completion.chunk',
})

const CAPTURE_THOUGHT =
  '**Solving the Riddle**\n\n' +
  "I've got the riddle now. I'm focusing on breaking it down mathematically. " +
  "I'm letting 'x' represent the ball's cost. Next, I need to express the bat's cost in terms of 'x'. " +
  'Then, I can set up an equation using the total cost.\n\n\n'

const CAPTURE_ANSWER =
  'The ball costs **5 cents ($0.05)**.' +
  ' \n\n**Explanation:** \nIf the ball costs $0.05, and the bat costs $1.00' +
  ' more than the ball, then the bat costs $1.05. Together, $0.05 + $1.' +
  '05 = $1.10. \n\n*(Note: A common intuitive guess is $0.10,' +
  " which doesn't work because the bat would then cost $1.10, bringing the total to $1.20.)*"

describe('Gemini thinking summaries — the live capture', () => {
  test('the thought is reasoning, the answer follows it, no tags survive', async () => {
    nextFetchResponses.push(() => sseResponse([...CAPTURE_TEXT_CHUNKS, CAPTURE_SIGNATURE_CHUNK, '[DONE]']))
    const res = await post({ model: 'gemini-4-carbon', stream: true, messages: [{ role: 'user', content: 'riddle' }] })
    expect(res.status).toBe(200)
    const payloads = ssePayloads(await drain(res))
    const chunks = deltas(payloads)

    const reasoning = chunks.map((d: any) => d.reasoning_content).filter(Boolean)
    expect(reasoning).toEqual([CAPTURE_THOUGHT])

    const answer = chunks.map((d: any) => d.content).filter(Boolean)
    expect(answer.join('')).toBe(CAPTURE_ANSWER)

    // pi-ai builds the text block from `content` before it builds the thinking
    // block, so a delta carrying both would show the answer above its thinking.
    // The reasoning line therefore has to come first.
    const reasoningAt = chunks.findIndex((d: any) => d.reasoning_content)
    const answerAt = chunks.findIndex((d: any) => typeof d.content === 'string' && d.content.length > 0)
    expect(reasoningAt).toBeGreaterThanOrEqual(0)
    expect(answerAt).toBeGreaterThan(reasoningAt)

    const wire = JSON.stringify(payloads)
    expect(wire).not.toContain('<thought>')
    expect(wire).not.toContain('</thought>')
    expect(wire).not.toContain('"thought":true')

    // The turn's signature chunk is untouched — replay needs it for any tool
    // call in the same turn.
    expect(payloads.at(-1)?.choices[0].delta.extra_content).toEqual({
      google: { thought_signature: 'Ep0JCpoJ-capture' },
    })
  })

  test('a held opener prefix is reply text when the stream dies before it completes', async () => {
    // A reply that begins "<thou" is held back in case the tag is about to
    // complete. If the stream ends there, the held text is reply content — a
    // thinking block would lose it from the answer.
    nextFetchResponses.push(() => sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: '<thou' } }] }),
      '[DONE]',
    ]))
    const res = await post({ model: 'gemini-4-carbon', stream: true, messages: [{ role: 'user', content: 'go' }] })
    const payloads = ssePayloads(await drain(res))
    expect(deltas(payloads).map((d: any) => d.content).filter(Boolean)).toEqual(['<thou'])
    expect(deltas(payloads).map((d: any) => d.reasoning_content).filter(Boolean)).toEqual([])
  })

  test('the tool-only capture gains no thought rewriting', async () => {
    // A turn that goes straight to a tool call had no thought chunk, so the
    // only change to its stream is the thought-signature lift this proxy has
    // always done — no reasoning, no content, nothing re-ordered.
    nextFetchResponses.push(() => sseResponse([...CAPTURE_TOOL_CHUNKS, '[DONE]']))
    const res = await post({ model: 'gemini-4-carbon', stream: true, messages: [{ role: 'user', content: 'read App.tsx' }] })
    const payloads = ssePayloads(await drain(res))
    const chunks = deltas(payloads)

    expect(chunks).toHaveLength(CAPTURE_TOOL_CHUNKS.length)
    for (const delta of chunks) {
      expect(delta.reasoning_content).toBeUndefined()
      expect(delta.content).toBeUndefined()
    }
    expect(JSON.stringify(payloads)).not.toContain('<thought>')

    const call = chunks[0].tool_calls[0]
    expect(call.id).toBe('call_11906536371955678501')
    expect(call.function).toEqual({ arguments: '{"path":"src/App.tsx"}', name: 'read_file' })
    expect(call.extra_content).toBeUndefined()
    expect(chunks[0].reasoning_details).toEqual([
      {
        type: 'reasoning.encrypted',
        id: 'call_11906536371955678501',
        data: 'EtEBCs4BAWkUfRPUvNtIYsBYFWTFhu9sFLMB640l8gg0WkieGVnypfF05Yxdz+E1AyvRIkhBL8yq4rBRo9FacoEQJT6poy1By/H5c5coFhaVjBpDoRw6AFZ4z14uiPE6xc39xOPkKk6oJ6z0HY8HoKCz+w5bk+iGEyW4yWOm5ynLiLvtZY6ixSeqOdcxgSPcOaIOpIebeqfu6m4Gz5vT5mqQKQAc5S7l6AbEFqj5Qflm38Oogoz6KECCPZXb1FY7NaMHudUarmh+IB9QYgOPG4goew4=',
      },
    ])
  })
})

