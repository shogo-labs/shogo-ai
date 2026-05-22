// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * HttpClient comprehensive coverage tests.
 *
 *   bun test packages/sdk/src/http/__tests__/client.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { HttpClient } from '../client'
import { ShogoError } from '../../errors.js'

type FetchCall = { url: string; init: RequestInit }

function makeJsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  const headers = new Headers({ 'content-type': 'application/json', ...(init.headers ?? {}) })
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers })
}

function makeTextResponse(text: string, init: { status?: number } = {}): Response {
  return new Response(text, {
    status: init.status ?? 200,
    headers: new Headers({ 'content-type': 'text/plain' }),
  })
}

const ORIGINAL_FETCH = globalThis.fetch

let fetchCalls: FetchCall[] = []
let fetchImpl: (url: string, init: RequestInit) => Promise<Response>

beforeEach(() => {
  fetchCalls = []
  fetchImpl = async () => makeJsonResponse({ ok: true })
  globalThis.fetch = ((url: any, init: any = {}) => {
    fetchCalls.push({ url: String(url), init })
    return fetchImpl(String(url), init)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

describe('HttpClient — constructor', () => {
  test('strips trailing slash from baseUrl', () => {
    const client = new HttpClient({ baseUrl: 'https://api.test/' })
    expect((client as any).baseUrl).toBe('https://api.test')
  })

  test('falls back to window.location.origin when baseUrl is empty', () => {
    const originalWindow = (globalThis as any).window
    ;(globalThis as any).window = { location: { origin: 'https://win.test' } }
    try {
      const client = new HttpClient({ baseUrl: '' })
      expect((client as any).baseUrl).toBe('https://win.test')
    } finally {
      if (originalWindow === undefined) delete (globalThis as any).window
      else (globalThis as any).window = originalWindow
    }
  })

  test('uses empty baseUrl when no window and no baseUrl provided', () => {
    const originalWindow = (globalThis as any).window
    delete (globalThis as any).window
    try {
      const client = new HttpClient({ baseUrl: '' })
      expect((client as any).baseUrl).toBe('')
    } finally {
      if (originalWindow !== undefined) (globalThis as any).window = originalWindow
    }
  })

  test('default config values are applied', () => {
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    expect((client as any).mcpPath).toBe('/mcp')
    expect((client as any).authPath).toBe('/api/auth')
    expect((client as any).dedupWindowMs).toBe(100)
    expect((client as any).credentials).toBe('same-origin')
    expect((client as any).getAuthCookie).toBeNull()
  })

  test('custom config overrides defaults', () => {
    const client = new HttpClient({
      baseUrl: 'https://api.test',
      mcpPath: '/m',
      authPath: '/a',
      dedupWindowMs: 500,
      credentials: 'include',
    })
    expect((client as any).mcpPath).toBe('/m')
    expect((client as any).authPath).toBe('/a')
    expect((client as any).dedupWindowMs).toBe(500)
    expect((client as any).credentials).toBe('include')
  })

  test('getAuthCookie forces credentials to omit', () => {
    const client = new HttpClient({
      baseUrl: 'https://api.test',
      credentials: 'include',
      getAuthCookie: () => 'cookie=1',
    })
    expect((client as any).credentials).toBe('omit')
  })
})

describe('HttpClient — request / GET', () => {
  test('GET returns parsed JSON, status, headers', async () => {
    fetchImpl = async () => makeJsonResponse({ hello: 'world' }, { status: 200 })
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    const res = await client.get<{ hello: string }>('/things')
    expect(res.data).toEqual({ hello: 'world' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(fetchCalls[0].url).toBe('https://api.test/things')
    expect((fetchCalls[0].init as any).method).toBe('GET')
  })

  test('GET applies searchParams', async () => {
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    await client.get('/things', { a: '1', b: 'two' })
    expect(fetchCalls[0].url).toContain('a=1')
    expect(fetchCalls[0].url).toContain('b=two')
  })

  test('injects Authorization header from getToken', async () => {
    const client = new HttpClient({ baseUrl: 'https://api.test', getToken: () => 'tok' })
    await client.get('/x')
    const headers = (fetchCalls[0].init.headers as Record<string, string>) ?? {}
    expect(headers['Authorization']).toBe('Bearer tok')
    expect(headers['Content-Type']).toBe('application/json')
  })

  test('omits Authorization header when getToken returns null', async () => {
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    await client.get('/x')
    const headers = (fetchCalls[0].init.headers as Record<string, string>) ?? {}
    expect(headers['Authorization']).toBeUndefined()
  })

  test('injects Cookie header from getAuthCookie', async () => {
    const client = new HttpClient({
      baseUrl: 'https://api.test',
      getAuthCookie: () => 'session=abc',
    })
    await client.get('/x')
    const headers = (fetchCalls[0].init.headers as Record<string, string>) ?? {}
    expect(headers['Cookie']).toBe('session=abc')
    expect((fetchCalls[0].init as any).credentials).toBe('omit')
  })

  test('omits Cookie header when getAuthCookie returns null', async () => {
    const client = new HttpClient({
      baseUrl: 'https://api.test',
      getAuthCookie: () => null,
    })
    await client.get('/x')
    const headers = (fetchCalls[0].init.headers as Record<string, string>) ?? {}
    expect(headers['Cookie']).toBeUndefined()
  })

  test('setTokenGetter updates auth token source', async () => {
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    client.setTokenGetter(() => 'new')
    await client.get('/x')
    const headers = (fetchCalls[0].init.headers as Record<string, string>) ?? {}
    expect(headers['Authorization']).toBe('Bearer new')
  })
})

describe('HttpClient — POST/PATCH/DELETE', () => {
  test('POST serializes body and sends correct method', async () => {
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    await client.post('/things', { name: 'x' }, { 'X-Custom': '1' })
    expect((fetchCalls[0].init as any).method).toBe('POST')
    expect((fetchCalls[0].init as any).body).toBe(JSON.stringify({ name: 'x' }))
    const headers = (fetchCalls[0].init.headers as Record<string, string>) ?? {}
    expect(headers['X-Custom']).toBe('1')
  })

  test('POST with no body sends undefined body', async () => {
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    await client.post('/things')
    expect((fetchCalls[0].init as any).body).toBeUndefined()
  })

  test('PATCH serializes body', async () => {
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    await client.patch('/things/1', { a: 1 })
    expect((fetchCalls[0].init as any).method).toBe('PATCH')
    expect((fetchCalls[0].init as any).body).toBe(JSON.stringify({ a: 1 }))
  })

  test('DELETE passes searchParams', async () => {
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    await client.delete('/things', { id: '5' })
    expect((fetchCalls[0].init as any).method).toBe('DELETE')
    expect(fetchCalls[0].url).toContain('id=5')
  })
})

describe('HttpClient — response parsing', () => {
  test('non-JSON content-type returns text body', async () => {
    fetchImpl = async () => makeTextResponse('plain hello')
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    const res = await client.get<string>('/text')
    expect(res.data).toBe('plain hello')
  })

  test('missing content-type returns text body', async () => {
    fetchImpl = async () =>
      new Response('raw', { status: 200, headers: new Headers() })
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    const res = await client.get<string>('/raw')
    expect(res.data).toBe('raw')
  })
})

describe('HttpClient — error handling', () => {
  test('non-ok with message field throws ShogoError using that message', async () => {
    fetchImpl = async () => makeJsonResponse({ message: 'oops' }, { status: 400 })
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    let err: unknown
    try {
      await client.get('/x')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ShogoError)
    expect((err as ShogoError).message).toBe('oops')
    expect((err as ShogoError).status).toBe(400)
    expect((err as ShogoError).code).toBe('VALIDATION_ERROR')
  })

  test('non-ok with error string field uses it as message', async () => {
    fetchImpl = async () => makeJsonResponse({ error: 'bad' }, { status: 401 })
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    try {
      await client.get('/x')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ShogoError)
      expect((e as ShogoError).message).toBe('bad')
      expect((e as ShogoError).code).toBe('UNAUTHORIZED')
    }
  })

  test('non-ok with error object containing message uses that', async () => {
    fetchImpl = async () =>
      makeJsonResponse({ error: { message: 'nested' } }, { status: 403 })
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    try {
      await client.get('/x')
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ShogoError).message).toBe('nested')
      expect((e as ShogoError).code).toBe('FORBIDDEN')
    }
  })

  test('non-ok with error object but no message falls back to default', async () => {
    fetchImpl = async () => makeJsonResponse({ error: { foo: 'bar' } }, { status: 500 })
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    try {
      await client.get('/x')
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ShogoError).message).toContain('500')
      expect((e as ShogoError).code).toBe('SERVER_ERROR')
    }
  })

  test('non-ok with no parseable error body uses default message', async () => {
    fetchImpl = async () => makeJsonResponse({}, { status: 404 })
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    try {
      await client.get('/x')
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ShogoError).code).toBe('NOT_FOUND')
      expect((e as ShogoError).message).toContain('404')
    }
  })

  test('non-ok text response falls back to default message', async () => {
    fetchImpl = async () => makeTextResponse('server down', { status: 500 })
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    try {
      await client.get('/x')
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ShogoError).status).toBe(500)
    }
  })

  test('fetch network failure wraps in ShogoError.networkError', async () => {
    fetchImpl = async () => {
      throw new Error('boom')
    }
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    try {
      await client.post('/x', { a: 1 })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ShogoError)
      expect((e as ShogoError).code).toBe('NETWORK_ERROR')
      expect((e as ShogoError).message).toBe('boom')
    }
  })

  test('non-Error fetch rejection wraps with default message', async () => {
    fetchImpl = async () => {
      throw 'weird' as any
    }
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    try {
      await client.post('/x', {})
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ShogoError).code).toBe('NETWORK_ERROR')
      expect((e as ShogoError).message).toBe('Network request failed')
    }
  })

  test('AbortError is rethrown as-is', async () => {
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    fetchImpl = async () => {
      throw abortErr
    }
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    try {
      await client.post('/x', {})
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBe(abortErr)
    }
  })

  test('ShogoError thrown inside body is rethrown', async () => {
    fetchImpl = async () => makeJsonResponse({ message: 'unauth' }, { status: 401 })
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    try {
      await client.post('/x', {})
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ShogoError)
      expect((e as ShogoError).code).toBe('UNAUTHORIZED')
    }
  })
})

describe('HttpClient — request deduplication', () => {
  test('two concurrent GETs share one fetch call', async () => {
    let resolveFetch!: (r: Response) => void
    fetchImpl = () => new Promise<Response>((r) => (resolveFetch = r))
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    const p1 = client.get('/x')
    const p2 = client.get('/x')
    expect(fetchCalls.length).toBe(1)
    resolveFetch(makeJsonResponse({ ok: 1 }))
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.data).toEqual({ ok: 1 })
    expect(r2.data).toEqual({ ok: 1 })
  })

  test('different searchParams produce separate fetches', async () => {
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    await Promise.all([client.get('/x', { a: '1' }), client.get('/x', { a: '2' })])
    expect(fetchCalls.length).toBe(2)
  })

  test('POST is not deduplicated', async () => {
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    await Promise.all([client.post('/x', { a: 1 }), client.post('/x', { a: 1 })])
    expect(fetchCalls.length).toBe(2)
  })

  test('clearCache removes pending entries', async () => {
    const client = new HttpClient({ baseUrl: 'https://api.test', dedupWindowMs: 10000 })
    await client.get('/x')
    expect((client as any).requestCache.size).toBeGreaterThan(0)
    client.clearCache()
    expect((client as any).requestCache.size).toBe(0)
  })

  test('expired cache entry triggers fresh fetch', async () => {
    const client = new HttpClient({ baseUrl: 'https://api.test', dedupWindowMs: 1 })
    await client.get('/x')
    await new Promise((r) => setTimeout(r, 25))
    await client.get('/x')
    expect(fetchCalls.length).toBe(2)
  })

  test('setTimeout cleanup removes cache entry after window', async () => {
    const client = new HttpClient({ baseUrl: 'https://api.test', dedupWindowMs: 5 })
    await client.get('/x')
    await new Promise((r) => setTimeout(r, 40))
    expect((client as any).requestCache.size).toBe(0)
  })
})

describe('HttpClient — auth helpers', () => {
  test('getAuthUrl prefixes endpoint with authPath', () => {
    const client = new HttpClient({ baseUrl: 'https://api.test', authPath: '/auth' })
    expect(client.getAuthUrl('/login')).toBe('/auth/login')
  })

  test('authRequest hits authPath endpoint', async () => {
    const client = new HttpClient({ baseUrl: 'https://api.test', authPath: '/api/auth' })
    await client.authRequest('/me')
    expect(fetchCalls[0].url).toBe('https://api.test/api/auth/me')
  })
})

describe('HttpClient — MCP', () => {
  test('callTool initializes session then invokes tool', async () => {
    const responses: Response[] = [
      makeJsonResponse(
        { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } },
        { headers: { 'mcp-session-id': 'sess-1' } }
      ),
      makeJsonResponse({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: JSON.stringify({ rows: [1, 2] }) }] },
      }),
    ]
    fetchImpl = async () => responses.shift()!
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    const out = await client.callTool<{ rows: number[] }>('q', { sql: 'select 1' })
    expect(out).toEqual({ rows: [1, 2] })
    expect(fetchCalls.length).toBe(2)
    const headers2 = fetchCalls[1].init.headers as Record<string, string>
    expect(headers2['mcp-session-id']).toBe('sess-1')
  })

  test('callTool returns raw text when content is not JSON', async () => {
    const responses: Response[] = [
      makeJsonResponse({ jsonrpc: '2.0', id: 1, result: {} }, { headers: { 'mcp-session-id': 's' } }),
      makeJsonResponse({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: 'not-json' }] },
      }),
    ]
    fetchImpl = async () => responses.shift()!
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    const out = await client.callTool<string>('q', {})
    expect(out).toBe('not-json')
  })

  test('callTool returns result directly when no content array', async () => {
    const responses: Response[] = [
      makeJsonResponse({ jsonrpc: '2.0', id: 1, result: {} }, { headers: { 'mcp-session-id': 's' } }),
      makeJsonResponse({ jsonrpc: '2.0', id: 2, result: { ok: true } }),
    ]
    fetchImpl = async () => responses.shift()!
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    const out = await client.callTool<{ ok: boolean }>('q', {})
    expect(out).toEqual({ ok: true })
  })

  test('callTool throws ShogoError on tool error', async () => {
    const responses: Response[] = [
      makeJsonResponse({ jsonrpc: '2.0', id: 1, result: {} }, { headers: { 'mcp-session-id': 's' } }),
      makeJsonResponse({ jsonrpc: '2.0', id: 2, error: { code: -1, message: 'tool failed' } }),
    ]
    fetchImpl = async () => responses.shift()!
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    try {
      await client.callTool('q', {})
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ShogoError)
      expect((e as ShogoError).code).toBe('DB_QUERY_ERROR')
      expect((e as ShogoError).message).toBe('tool failed')
    }
  })

  test('initializeMcpSession throws ShogoError when init returns error', async () => {
    fetchImpl = async () =>
      makeJsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'init fail' } })
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    try {
      await client.callTool('q', {})
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ShogoError)
      expect((e as ShogoError).code).toBe('SERVER_ERROR')
      expect((e as ShogoError).message).toBe('init fail')
    }
  })

  test('init without session-id header still proceeds', async () => {
    const responses: Response[] = [
      makeJsonResponse({ jsonrpc: '2.0', id: 1, result: {} }),
      makeJsonResponse({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: '"hi"' }] },
      }),
    ]
    fetchImpl = async () => responses.shift()!
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    const out = await client.callTool<string>('q', {})
    expect(out).toBe('hi')
    const headers2 = fetchCalls[1].init.headers as Record<string, string>
    expect(headers2['mcp-session-id']).toBeUndefined()
  })

  test('ensureMcpInitialized short-circuits when session already exists', async () => {
    const responses: Response[] = [
      makeJsonResponse({ jsonrpc: '2.0', id: 1, result: {} }, { headers: { 'mcp-session-id': 's' } }),
      makeJsonResponse({ jsonrpc: '2.0', id: 2, result: { ok: 1 } }),
      makeJsonResponse({ jsonrpc: '2.0', id: 3, result: { ok: 2 } }),
    ]
    fetchImpl = async () => responses.shift()!
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    await client.callTool('q', {})
    const callsAfterInit = fetchCalls.length
    await client.callTool('q', {})
    expect(fetchCalls.length).toBe(callsAfterInit + 1)
  })

  test('concurrent callTool while init in-flight share init promise', async () => {
    let resolveInit!: (r: Response) => void
    const initPromise = new Promise<Response>((r) => (resolveInit = r))
    const responses: Array<Response | Promise<Response>> = [
      initPromise,
      makeJsonResponse({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '"a"' }] } }),
      makeJsonResponse({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: '"b"' }] } }),
    ]
    fetchImpl = async () => responses.shift() as any
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    const p1 = client.callTool<string>('q', {})
    const p2 = client.callTool<string>('q', {})
    await new Promise((r) => setTimeout(r, 0))
    resolveInit(
      makeJsonResponse(
        { jsonrpc: '2.0', id: 1, result: {} },
        { headers: { 'mcp-session-id': 'shared' } }
      )
    )
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe('a')
    expect(r2).toBe('b')
    expect(fetchCalls.length).toBe(3)
  })

  test('resetMcpSession clears sessionId so next callTool reinitializes', async () => {
    const responses: Response[] = [
      makeJsonResponse({ jsonrpc: '2.0', id: 1, result: {} }, { headers: { 'mcp-session-id': 's1' } }),
      makeJsonResponse({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '"x"' }] } }),
      makeJsonResponse({ jsonrpc: '2.0', id: 3, result: {} }, { headers: { 'mcp-session-id': 's2' } }),
      makeJsonResponse({ jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: '"y"' }] } }),
    ]
    fetchImpl = async () => responses.shift()!
    const client = new HttpClient({ baseUrl: 'https://api.test' })
    await client.callTool('q', {})
    client.resetMcpSession()
    await client.callTool('q', {})
    expect(fetchCalls.length).toBe(4)
  })

  test('MCP requests use configured credentials', async () => {
    const responses: Response[] = [
      makeJsonResponse({ jsonrpc: '2.0', id: 1, result: {} }, { headers: { 'mcp-session-id': 's' } }),
      makeJsonResponse({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '"k"' }] } }),
    ]
    fetchImpl = async () => responses.shift()!
    const client = new HttpClient({ baseUrl: 'https://api.test', credentials: 'include' })
    await client.callTool('q', {})
    expect((fetchCalls[0].init as any).credentials).toBe('include')
    expect((fetchCalls[1].init as any).credentials).toBe('include')
  })
})
