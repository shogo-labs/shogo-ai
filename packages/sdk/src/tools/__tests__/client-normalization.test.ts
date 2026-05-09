// SPDX-License-Identifier: Apache-2.0
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

import { describe, expect, test } from 'bun:test'

import { ToolsClient } from '../client'

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
