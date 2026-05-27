// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test'

import * as aiClient from '../ai-client.js'
const { sendMessage, sendMessages, sendMessageJSON } = aiClient

const originalFetch = globalThis.fetch
let savedEnv: Record<string, string | undefined>
const ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']

function makeResponse(body: any, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  } as any
}

function withResponse(body: any, ok = true, status = 200) {
  return mock(async () => makeResponse(body, ok, status))
}

beforeEach(() => {
  savedEnv = {}
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]!
  }
  globalThis.fetch = originalFetch
})

const okBody = {
  content: [
    { type: 'text', text: 'Hello ' },
    { type: 'text', text: 'World' },
    { type: 'tool_use', text: 'IGNORED' },
  ],
  usage: { input_tokens: 12, output_tokens: 34 },
  stop_reason: 'end_turn',
}

describe('resolveConfig (via sendMessages)', () => {
  it('throws when no API key in env or options', async () => {
    await expect(sendMessage('hi')).rejects.toThrow(/No Anthropic API key/)
  })
  it('reads ANTHROPIC_API_KEY from env', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-key'
    const f = withResponse(okBody)
    globalThis.fetch = f as any
    await sendMessage('hi')
    expect(f).toHaveBeenCalled()
    const headers = (f.mock.calls[0][1] as any).headers
    expect(headers['x-api-key']).toBe('env-key')
  })
  it('options.apiKey overrides env', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-key'
    const f = withResponse(okBody)
    globalThis.fetch = f as any
    await sendMessage('hi', { apiKey: 'opt-key' })
    const headers = (f.mock.calls[0][1] as any).headers
    expect(headers['x-api-key']).toBe('opt-key')
  })
  it('defaults base URL to anthropic.com when not set', async () => {
    process.env.ANTHROPIC_API_KEY = 'k'
    const f = withResponse(okBody)
    globalThis.fetch = f as any
    await sendMessage('hi')
    expect(f.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages')
  })
  it('reads ANTHROPIC_BASE_URL from env', async () => {
    process.env.ANTHROPIC_API_KEY = 'k'
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com'
    const f = withResponse(okBody)
    globalThis.fetch = f as any
    await sendMessage('hi')
    expect(f.mock.calls[0][0]).toBe('https://proxy.example.com/v1/messages')
  })
  it('options.baseUrl overrides env (and strips trailing slash)', async () => {
    process.env.ANTHROPIC_API_KEY = 'k'
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com'
    const f = withResponse(okBody)
    globalThis.fetch = f as any
    await sendMessage('hi', { baseUrl: 'https://override.example.com/' })
    expect(f.mock.calls[0][0]).toBe('https://override.example.com/v1/messages')
  })
})

describe('sendMessages (and sendMessage delegation)', () => {
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'k' })

  it('returns text concatenated from text content blocks only', async () => {
    globalThis.fetch = withResponse(okBody) as any
    const r = await sendMessage('hi')
    expect(r.text).toBe('Hello World')
    expect(r.inputTokens).toBe(12)
    expect(r.outputTokens).toBe(34)
    expect(r.stopReason).toBe('end_turn')
  })

  it('passes model + max_tokens + temperature + messages in body', async () => {
    const f = withResponse(okBody)
    globalThis.fetch = f as any
    await sendMessages([{ role: 'user', content: 'q' }], {
      model: 'claude-haiku-4-5',
      maxTokens: 999,
      temperature: 0.7,
    })
    const body = JSON.parse((f.mock.calls[0][1] as any).body)
    expect(body.model).toBe('claude-haiku-4-5')
    expect(body.max_tokens).toBe(999)
    expect(body.temperature).toBe(0.7)
    expect(body.messages).toEqual([{ role: 'user', content: 'q' }])
  })

  it('falls back to default model + catalog max_tokens + temp=0 when options omitted', async () => {
    const f = withResponse(okBody)
    globalThis.fetch = f as any
    await sendMessage('q')
    const body = JSON.parse((f.mock.calls[0][1] as any).body)
    expect(body.model).toBe('claude-sonnet-4-6')
    expect(body.temperature).toBe(0)
    expect(typeof body.max_tokens).toBe('number')
    expect(body.max_tokens).toBeGreaterThan(0)
  })

  it('includes system field when provided, omits when not', async () => {
    const f1 = withResponse(okBody); globalThis.fetch = f1 as any
    await sendMessage('q', { system: 'be concise' })
    expect(JSON.parse((f1.mock.calls[0][1] as any).body).system).toBe('be concise')

    const f2 = withResponse(okBody); globalThis.fetch = f2 as any
    await sendMessage('q')
    expect(JSON.parse((f2.mock.calls[0][1] as any).body).system).toBeUndefined()
  })

  it('sends Anthropic-version + content-type headers', async () => {
    const f = withResponse(okBody)
    globalThis.fetch = f as any
    await sendMessage('q')
    const h = (f.mock.calls[0][1] as any).headers
    expect(h['Content-Type']).toBe('application/json')
    expect(h['anthropic-version']).toBe('2023-06-01')
    expect(h['x-api-key']).toBe('k')
  })

  it('throws when response !ok including the error body in message', async () => {
    globalThis.fetch = (async () => makeResponse('rate limited', false, 429)) as any
    await expect(sendMessage('q')).rejects.toThrow(/Anthropic API error 429.*rate limited/)
  })

  it('handles empty content array (no text blocks)', async () => {
    globalThis.fetch = withResponse({
      content: [],
      usage: { input_tokens: 1, output_tokens: 0 },
      stop_reason: 'end_turn',
    }) as any
    const r = await sendMessage('q')
    expect(r.text).toBe('')
  })
})

describe('sendMessageJSON', () => {
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'k' })

  const withTextBody = (text: string) => withResponse({
    content: [{ type: 'text', text }],
    usage: { input_tokens: 1, output_tokens: 2 },
    stop_reason: 'end_turn',
  })

  it('parses plain JSON response', async () => {
    globalThis.fetch = withTextBody('{"items":[1,2,3]}') as any
    const r = await sendMessageJSON<{ items: number[] }>('q')
    expect(r.data.items).toEqual([1, 2, 3])
    expect(r.usage).toEqual({ inputTokens: 1, outputTokens: 2 })
  })

  it('strips ```json ... ``` code fences', async () => {
    globalThis.fetch = withTextBody('```json\n{"ok":true}\n```') as any
    const r = await sendMessageJSON<{ ok: boolean }>('q')
    expect(r.data).toEqual({ ok: true })
  })

  it('strips bare ``` ... ``` fences', async () => {
    globalThis.fetch = withTextBody('```\n{"x":1}\n```') as any
    const r = await sendMessageJSON<{ x: number }>('q')
    expect(r.data).toEqual({ x: 1 })
  })

  it('throws on malformed JSON body', async () => {
    globalThis.fetch = withTextBody('not json at all') as any
    await expect(sendMessageJSON('q')).rejects.toThrow()
  })
})
