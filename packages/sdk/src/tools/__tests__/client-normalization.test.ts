// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ToolsClient.execute() data-normalization tests.
 *
 * Pins the contract that `data` arrives as a JSON string (the runtime
 * always JSON.stringifies the underlying tool response) and is
 * auto-parsed into its natural JS shape. Plain-text payloads fall back
 * to the original string. Error payloads are passed through untouched.
 *
 * Run: bun test packages/sdk/src/tools/__tests__/client-normalization.test.ts
 */

import { afterEach, describe, expect, test } from 'bun:test'

import { ToolsClient, getServerToolsClient, getToolsClient } from '../client'

function stubFetch(body: unknown, init: ResponseInit = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })) as typeof fetch
}

function client(body: unknown, init?: ResponseInit): ToolsClient {
  return new ToolsClient({ baseUrl: 'http://test.local', fetch: stubFetch(body, init) })
}

const ENV_KEYS = ['RUNTIME_AUTH_SECRET', 'RUNTIME_PORT'] as const
const savedEnv: Record<string, string | undefined> = {}

for (const key of ENV_KEYS) savedEnv[key] = process.env[key]

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe('ToolsClient.execute() — data normalization', () => {
  test('parses string data of an object literal', async () => {
    const c = client({ ok: true, data: JSON.stringify({ accountId: 'acc_1', email: 'a@b.com' }) })
    const res = await c.execute<{ accountId: string; email: string }>('JIRA_GET_CURRENT_USER', {})
    expect(res.ok).toBe(true)
    expect(res.data).toEqual({ accountId: 'acc_1', email: 'a@b.com' })
    expect(res.data?.accountId).toBe('acc_1')
  })

  test('parses string data of an array literal', async () => {
    const issues = [{ key: 'PROJ-1' }, { key: 'PROJ-2' }]
    const c = client({ ok: true, data: JSON.stringify(issues) })
    const res = await c.execute<typeof issues>('JIRA_SEARCH_ISSUES', {})
    expect(res.ok).toBe(true)
    expect(Array.isArray(res.data)).toBe(true)
    expect(res.data).toEqual(issues)
  })

  test('JSON-encoded primitive number → number', async () => {
    const c = client({ ok: true, data: JSON.stringify(42) })
    const res = await c.execute<number>('TOOL', {})
    expect(res.ok).toBe(true)
    expect(res.data).toBe(42)
  })

  test('JSON-encoded primitive boolean → boolean', async () => {
    const c = client({ ok: true, data: JSON.stringify(true) })
    const res = await c.execute<boolean>('TOOL', {})
    expect(res.ok).toBe(true)
    expect(res.data).toBe(true)
  })

  test('JSON-encoded null → null', async () => {
    const c = client({ ok: true, data: JSON.stringify(null) })
    const res = await c.execute('TOOL', {})
    expect(res.ok).toBe(true)
    expect(res.data).toBeNull()
  })

  test('JSON-encoded string round-trips to the natural string', async () => {
    const c = client({ ok: true, data: JSON.stringify('hello world') })
    const res = await c.execute<string>('TOOL', {})
    expect(res.ok).toBe(true)
    expect(res.data).toBe('hello world')
  })

  test('non-JSON string (plain markdown) is left unchanged', async () => {
    const c = client({ ok: true, data: '# Hello\n\nThis is markdown.' })
    const res = await c.execute<string>('TOOL', {})
    expect(res.ok).toBe(true)
    expect(res.data).toBe('# Hello\n\nThis is markdown.')
  })

  test('malformed JSON is left unchanged (no throw)', async () => {
    const c = client({ ok: true, data: '{invalid' })
    const res = await c.execute<string>('TOOL', {})
    expect(res.ok).toBe(true)
    expect(res.data).toBe('{invalid')
  })

  test('already-object data is passed through untouched', async () => {
    const c = client({ ok: true, data: { already: 'parsed' } })
    const res = await c.execute<{ already: string }>('TOOL', {})
    expect(res.ok).toBe(true)
    expect(res.data).toEqual({ already: 'parsed' })
  })

  test('ok:false with string error and string data leaves data untouched', async () => {
    const c = client({ ok: false, error: 'Not authenticated', data: '{"would":"parse"}' })
    const res = await c.execute('TOOL', {})
    expect(res.ok).toBe(false)
    expect(res.error).toBe('Not authenticated')
    expect(res.data).toBe('{"would":"parse"}')
  })

  test('omitted data stays undefined', async () => {
    const c = client({ ok: true })
    const res = await c.execute('TOOL', {})
    expect(res.ok).toBe(true)
    expect(res.data).toBeUndefined()
  })

  test('non-2xx HTTP status returns error envelope (no parse attempt)', async () => {
    const c = new ToolsClient({
      baseUrl: 'http://test.local',
      fetch: (async () => new Response('upstream blew up', { status: 502 })) as typeof fetch,
    })
    const res = await c.execute('TOOL', {})
    expect(res.ok).toBe(false)
    expect(res.error).toContain('502')
    expect(res.error).toContain('upstream blew up')
  })
})

describe('ToolsClient listTools()', () => {
  test('fetches tool schemas from the configured base URL with headers', async () => {
    const calls: Array<{ url: string; headers: HeadersInit | undefined }> = []
    const c = new ToolsClient({
      baseUrl: 'http://runtime.local/',
      headers: { 'x-test': 'yes' },
      fetch: (async (url, init) => {
        calls.push({ url: String(url), headers: init?.headers })
        return new Response(JSON.stringify({
          tools: [
            { name: 'JIRA_SEARCH_ISSUES', description: 'Search issues', parameters: { type: 'object' } },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }) as typeof fetch,
    })

    const tools = await c.listTools()

    expect(calls[0].url).toBe('http://runtime.local/api/tools/schemas')
    expect(calls[0].headers).toEqual({ 'x-test': 'yes' })
    expect(tools[0].name).toBe('JIRA_SEARCH_ISSUES')
  })

  test('returns an empty list when the response omits tools', async () => {
    const c = client({})
    await expect(c.listTools()).resolves.toEqual([])
  })

  test('throws a useful error for non-2xx schema responses', async () => {
    const c = new ToolsClient({
      fetch: (async () => new Response('nope', { status: 503, statusText: 'Service Unavailable' })) as typeof fetch,
    })

    await expect(c.listTools()).rejects.toThrow('Tools list failed (503): nope')
  })
})

describe('ToolsClient singletons and server-side config', () => {
  test('getToolsClient reuses default client unless config is passed', () => {
    const first = getToolsClient({ fetch: stubFetch({ tools: [] }) })
    const second = getToolsClient()
    const third = getToolsClient({ fetch: stubFetch({ tools: [] }) })

    expect(second).toBe(first)
    expect(third).not.toBe(first)
  })

  test('getServerToolsClient requires runtime env vars', () => {
    delete process.env.RUNTIME_AUTH_SECRET
    delete process.env.RUNTIME_PORT

    expect(() => getServerToolsClient()).toThrow('RUNTIME_AUTH_SECRET and RUNTIME_PORT must be set')
  })

  test('getServerToolsClient validates runtime port', () => {
    process.env.RUNTIME_AUTH_SECRET = 'secret'
    process.env.RUNTIME_PORT = 'not-a-port'

    expect(() => getServerToolsClient()).toThrow('invalid RUNTIME_PORT')
  })

  test('getServerToolsClient targets the runtime path and injects token', async () => {
    process.env.RUNTIME_AUTH_SECRET = 'runtime-secret'
    process.env.RUNTIME_PORT = '7123'
    const calls: Array<{ url: string; headers: HeadersInit | undefined; body?: BodyInit | null }> = []

    const c = getServerToolsClient({
      fetch: (async (url, init) => {
        calls.push({ url: String(url), headers: init?.headers, body: init?.body })
        return new Response(JSON.stringify({ ok: true, data: '{"done":true}' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch,
    })

    const result = await c.execute<{ done: boolean }>('TOOL_NAME', { a: 1 })

    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ done: true })
    expect(calls[0].url).toBe('http://127.0.0.1:7123/agent/tools/execute')
    expect(calls[0].headers).toEqual({
      'Content-Type': 'application/json',
      'x-runtime-token': 'runtime-secret',
    })
    expect(JSON.parse(String(calls[0].body))).toEqual({ tool: 'TOOL_NAME', args: { a: 1 } })
  })
})
