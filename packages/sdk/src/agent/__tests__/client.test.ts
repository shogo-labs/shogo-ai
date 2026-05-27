// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AgentClient coverage tests.
 *
 * Stubs `fetch` (per-instance) and the global `EventSource` so we can
 * exercise every method of AgentClient without an actual server. Pins the
 * contract that:
 *   - baseUrl trailing slash is stripped and prefixed onto every URL
 *   - `Content-Type` from ambient headers is dropped (FormData uploads
 *     must own their boundary)
 *   - non-2xx responses surface as `Agent <op> <status>: <text>` errors
 *   - `subscribeToWorkspace` parses JSON, filters reload by default, and
 *     reconnects with exponential backoff
 *   - `getAgentClient(config)` returns a singleton until called again
 *     with a config (which replaces it)
 */

import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'

import { AgentClient, getAgentClient, type WorkspaceEvent } from '../client'

// ---------------------------------------------------------------------------
// fetch helpers
// ---------------------------------------------------------------------------

type Call = { url: string; init?: RequestInit }

function makeFetch(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
  calls: Call[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, init })
    return responder(url, init)
  }) as unknown as typeof fetch
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

function emptyOk(): Response {
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
}

// ---------------------------------------------------------------------------
// EventSource fake
// ---------------------------------------------------------------------------

interface FakeEventSourceInstance {
  url: string
  withCredentials: boolean
  closed: boolean
  onmessage?: ((ev: MessageEvent) => void) | null
  onerror?: ((ev: Event) => void) | null
  onopen?: ((ev: Event) => void) | null
  close: () => void
  emit: (data: string) => void
  emitError: () => void
}

let esInstances: FakeEventSourceInstance[] = []
let originalEventSource: unknown

function installFakeEventSource() {
  originalEventSource = (globalThis as Record<string, unknown>).EventSource
  class FakeES implements FakeEventSourceInstance {
    url: string
    withCredentials: boolean
    closed = false
    onmessage: ((ev: MessageEvent) => void) | null = null
    onerror: ((ev: Event) => void) | null = null
    onopen: ((ev: Event) => void) | null = null
    constructor(url: string, init?: { withCredentials?: boolean }) {
      this.url = url
      this.withCredentials = init?.withCredentials ?? false
      esInstances.push(this)
    }
    close() { this.closed = true }
    emit(data: string) {
      this.onmessage?.({ data } as MessageEvent)
    }
    emitError() {
      this.onerror?.({} as Event)
    }
  }
  ;(globalThis as Record<string, unknown>).EventSource = FakeES as unknown
}

function restoreEventSource() {
  ;(globalThis as Record<string, unknown>).EventSource = originalEventSource
  esInstances = []
}

beforeEach(() => {
  installFakeEventSource()
})
afterEach(() => {
  restoreEventSource()
})

// ---------------------------------------------------------------------------
// constructor / config
// ---------------------------------------------------------------------------

describe('AgentClient — construction', () => {
  test('defaults baseUrl to empty (relative) and uses globalThis.fetch', () => {
    const c = new AgentClient()
    expect(c).toBeInstanceOf(AgentClient)
  })

  test('strips trailing slash from baseUrl', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => jsonResponse({ status: 'ok' }), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test/', fetch: f })
    await c.getStatus()
    expect(calls[0]!.url).toBe('http://x.test/agent/status')
  })

  test('drops ambient Content-Type (case-insensitive) so FormData uploads keep their boundary', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => jsonResponse({ uploaded: ['a'], count: 1 }), calls)
    const c = new AgentClient({
      baseUrl: 'http://x.test',
      fetch: f,
      headers: { Authorization: 'Bearer X', 'Content-Type': 'multipart/form-data' },
    })
    const fd = new FormData()
    fd.append('file', new Blob(['hi']), 'a.txt')
    await c.uploadWorkspaceFiles(fd)
    const sent = calls[0]!.init!.headers as Record<string, string>
    expect(sent.Authorization).toBe('Bearer X')
    expect(Object.keys(sent).some((k) => k.toLowerCase() === 'content-type')).toBe(false)
  })

  test('ambient headers are forwarded on JSON GETs', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => jsonResponse({ status: 'ok' }), calls)
    const c = new AgentClient({
      baseUrl: 'http://x.test',
      fetch: f,
      headers: { Authorization: 'Bearer T' },
    })
    await c.getStatus()
    const sent = calls[0]!.init!.headers as Record<string, string>
    expect(sent.Authorization).toBe('Bearer T')
  })
})

// ---------------------------------------------------------------------------
// fetchJson error path
// ---------------------------------------------------------------------------

describe('AgentClient — error handling', () => {
  test('non-ok response throws "Agent API <status>: <body>"', async () => {
    const f = makeFetch(() => new Response('boom', { status: 500 }))
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    await expect(c.getStatus()).rejects.toThrow(/Agent API 500: boom/)
  })

  test('non-ok response with unreadable body falls back to statusText', async () => {
    const f = makeFetch(() =>
      new Response(
        new ReadableStream({
          start(ctrl) { ctrl.error(new Error('stream broke')) },
        }),
        { status: 502, statusText: 'Bad Gateway' },
      ),
    )
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    await expect(c.getStatus()).rejects.toThrow(/Agent API 502/)
  })

  test('chat() surfaces non-ok as Agent chat error', async () => {
    const f = makeFetch(() => new Response('bad', { status: 400 }))
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    await expect(c.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/Agent chat 400: bad/)
  })

  test('readFile() surfaces non-ok as Agent readFile error', async () => {
    const f = makeFetch(() => new Response('nope', { status: 404 }))
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    await expect(c.readFile('a.txt')).rejects.toThrow(/Agent readFile 404: nope/)
  })

  test('readFileBlob() surfaces non-ok as Agent readFileBlob error', async () => {
    const f = makeFetch(() => new Response('nope', { status: 403 }))
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    await expect(c.readFileBlob('a.png')).rejects.toThrow(/Agent readFileBlob 403: nope/)
  })

  test('uploadWorkspaceFiles() surfaces non-ok as Agent upload error', async () => {
    const f = makeFetch(() => new Response('too big', { status: 413 }))
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    const fd = new FormData()
    await expect(c.uploadWorkspaceFiles(fd)).rejects.toThrow(/Agent upload 413: too big/)
  })
})

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

describe('AgentClient — chat', () => {
  test('POSTs JSON body with optional fields only when present', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => new Response('stream', { status: 200 }), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    const res = await c.chat([{ role: 'user', content: 'hi' }], {
      sessionId: 'sess',
      agentMode: 'fast',
      userId: 'u1',
      timezone: 'UTC',
    })
    expect(res.status).toBe(200)
    expect(calls[0]!.url).toBe('http://x.test/agent/chat')
    expect(calls[0]!.init!.method).toBe('POST')
    const body = JSON.parse(calls[0]!.init!.body as string)
    expect(body).toEqual({
      messages: [{ role: 'user', content: 'hi' }],
      sessionId: 'sess',
      agentMode: 'fast',
      userId: 'u1',
      timezone: 'UTC',
    })
  })

  test('chat() omits optional fields when not provided', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => new Response('stream', { status: 200 }), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    await c.chat([{ role: 'user', content: 'hi' }])
    const body = JSON.parse(calls[0]!.init!.body as string)
    expect(body).toEqual({ messages: [{ role: 'user', content: 'hi' }] })
  })

  test('chat() returns raw Response for stream consumption', async () => {
    const f = makeFetch(() => new Response('chunk1\nchunk2', { status: 200 }))
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    const res = await c.chat([{ role: 'user', content: 'hi' }])
    expect(await res.text()).toBe('chunk1\nchunk2')
  })

  test('getChatHistory() adds sessionId query param when provided', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => jsonResponse([{ role: 'user', content: 'a' }]), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    const out = await c.getChatHistory('s 1')
    expect(out).toEqual([{ role: 'user', content: 'a' }])
    expect(calls[0]!.url).toBe('http://x.test/agent/chat/history?sessionId=s%201')
  })

  test('getChatHistory() omits qs when no session', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => jsonResponse([]), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    await c.getChatHistory()
    expect(calls[0]!.url).toBe('http://x.test/agent/chat/history')
  })
})

// ---------------------------------------------------------------------------
// workspace event stream (SSE)
// ---------------------------------------------------------------------------

describe('AgentClient — subscribeToWorkspace', () => {
  test('parses JSON events and invokes onEvent with typed payload', () => {
    const c = new AgentClient({ baseUrl: 'http://x.test' })
    const events: WorkspaceEvent[] = []
    const dispose = c.subscribeToWorkspace((ev) => events.push(ev))
    const es = esInstances[0]!
    es.emit(JSON.stringify({ type: 'file.changed', path: 'a.ts', mtime: 1 }))
    es.emit(JSON.stringify({ type: 'file.deleted', path: 'b.ts' }))
    es.emit(JSON.stringify({ type: 'init' }))
    expect(events).toEqual([
      { type: 'file.changed', path: 'a.ts', mtime: 1 },
      { type: 'file.deleted', path: 'b.ts' },
      { type: 'init' },
    ])
    dispose()
    expect(es.closed).toBe(true)
  })

  test('drops reload events unless includeReload:true', () => {
    const c = new AgentClient({ baseUrl: 'http://x.test' })
    const events: WorkspaceEvent[] = []
    const dispose = c.subscribeToWorkspace((ev) => events.push(ev))
    const es = esInstances[0]!
    es.emit(JSON.stringify({ type: 'reload' }))
    es.emit(JSON.stringify({ type: 'file.changed', path: 'a.ts', mtime: 1 }))
    expect(events).toEqual([{ type: 'file.changed', path: 'a.ts', mtime: 1 }])
    dispose()
  })

  test('includes reload events when includeReload:true', () => {
    const c = new AgentClient({ baseUrl: 'http://x.test' })
    const events: WorkspaceEvent[] = []
    const dispose = c.subscribeToWorkspace((ev) => events.push(ev), { includeReload: true })
    esInstances[0]!.emit(JSON.stringify({ type: 'reload' }))
    expect(events).toEqual([{ type: 'reload' }])
    dispose()
  })

  test('ignores malformed JSON', () => {
    const c = new AgentClient({ baseUrl: 'http://x.test' })
    const events: WorkspaceEvent[] = []
    const dispose = c.subscribeToWorkspace((ev) => events.push(ev))
    const es = esInstances[0]!
    es.emit('not json{')
    es.emit('null')
    es.emit('"a string"')
    expect(events).toEqual([])
    dispose()
  })

  test('forwards listener errors to onError', () => {
    const c = new AgentClient({ baseUrl: 'http://x.test' })
    const errors: unknown[] = []
    const dispose = c.subscribeToWorkspace(
      () => { throw new Error('handler boom') },
      { onError: (e) => errors.push(e) },
    )
    esInstances[0]!.emit(JSON.stringify({ type: 'init' }))
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('handler boom')
    dispose()
  })

  test('reconnects with exponential backoff on error', async () => {
    const originalSetTimeout = globalThis.setTimeout
    const scheduled: Array<{ delay: number; fn: () => void }> = []
    const fakeSetTimeout = ((fn: () => void, delay: number) => {
      scheduled.push({ delay, fn })
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    ;(globalThis as Record<string, unknown>).setTimeout = fakeSetTimeout

    try {
      const c = new AgentClient({ baseUrl: 'http://x.test' })
      const errs: unknown[] = []
      const dispose = c.subscribeToWorkspace(() => {}, { onError: (e) => errs.push(e) })
      expect(esInstances).toHaveLength(1)
      esInstances[0]!.emitError()
      expect(esInstances[0]!.closed).toBe(true)
      expect(scheduled[0]!.delay).toBe(1000)
      scheduled[0]!.fn()
      expect(esInstances).toHaveLength(2)
      esInstances[1]!.emitError()
      expect(scheduled[1]!.delay).toBe(2000)
      scheduled[1]!.fn()
      expect(esInstances).toHaveLength(3)
      esInstances[2]!.emitError()
      expect(scheduled[2]!.delay).toBe(4000)
      dispose()
      expect(errs.length).toBeGreaterThanOrEqual(3)
    } finally {
      ;(globalThis as Record<string, unknown>).setTimeout = originalSetTimeout
    }
  })

  test('cleanup swallows close() errors (es.close() throws)', () => {
    const c = new AgentClient({ baseUrl: 'http://x.test' })
    const dispose = c.subscribeToWorkspace(() => {})
    const es = esInstances[0]!
    // Make close() throw so the inline `try { es?.close() } catch {}` swallow runs.
    es.close = (() => { throw new Error('close boom') }) as () => void
    expect(() => dispose()).not.toThrow()
  })

  test('reconnect path swallows close() errors during onerror', async () => {
    const originalSetTimeout = globalThis.setTimeout
    ;(globalThis as Record<string, unknown>).setTimeout = ((fn: () => void, _delay: number) => {
      // Don't auto-invoke fn — just return a fake handle so backoff math runs.
      void fn
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    try {
      const c = new AgentClient({ baseUrl: 'http://x.test' })
      const errors: unknown[] = []
      const dispose = c.subscribeToWorkspace(() => {}, { onError: (e) => errors.push(e) })
      const es = esInstances[0]!
      es.close = (() => { throw new Error('close boom inside onerror') }) as () => void
      expect(() => es.emitError()).not.toThrow()
      // onError should still have been notified despite the close() swallow.
      expect(errors).toHaveLength(1)
      dispose()
    } finally {
      ;(globalThis as Record<string, unknown>).setTimeout = originalSetTimeout
    }
  })

  test('successful event resets backoff', async () => {
    const originalSetTimeout = globalThis.setTimeout
    const scheduled: Array<{ delay: number; fn: () => void }> = []
    ;(globalThis as Record<string, unknown>).setTimeout = ((fn: () => void, delay: number) => {
      scheduled.push({ delay, fn })
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const c = new AgentClient({ baseUrl: 'http://x.test' })
      const dispose = c.subscribeToWorkspace(() => {})
      esInstances[0]!.emitError()      // -> 1000ms backoff scheduled
      scheduled[0]!.fn()
      esInstances[1]!.emitError()      // -> 2000ms
      scheduled[1]!.fn()
      esInstances[2]!.emit(JSON.stringify({ type: 'init' })) // success
      esInstances[2]!.emitError()      // back to 1000ms
      expect(scheduled[2]!.delay).toBe(1000)
      dispose()
    } finally {
      ;(globalThis as Record<string, unknown>).setTimeout = originalSetTimeout
    }
  })

  test('dispose is idempotent and cancels pending reconnect', async () => {
    const originalSetTimeout = globalThis.setTimeout
    const originalClear = globalThis.clearTimeout
    let cleared = 0
    ;(globalThis as Record<string, unknown>).setTimeout = ((_fn: () => void, _delay: number) =>
      99 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout
    ;(globalThis as Record<string, unknown>).clearTimeout = (() => { cleared++ }) as unknown as typeof clearTimeout
    try {
      const c = new AgentClient({ baseUrl: 'http://x.test' })
      const dispose = c.subscribeToWorkspace(() => {})
      esInstances[0]!.emitError()
      dispose()
      dispose() // idempotent
      expect(cleared).toBe(1)
    } finally {
      ;(globalThis as Record<string, unknown>).setTimeout = originalSetTimeout
      ;(globalThis as Record<string, unknown>).clearTimeout = originalClear
    }
  })

  test('dispose without prior error is safe', () => {
    const c = new AgentClient({ baseUrl: 'http://x.test' })
    const dispose = c.subscribeToWorkspace(() => {})
    expect(esInstances).toHaveLength(1)
    dispose()
    expect(esInstances[0]!.closed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// workspace tree / files
// ---------------------------------------------------------------------------

describe('AgentClient — workspace files', () => {
  test('getWorkspaceTree unwraps { tree } and defaults to []', async () => {
    const f1 = makeFetch(() => jsonResponse({ tree: [{ name: 'a', path: 'a', type: 'file' }] }))
    const c1 = new AgentClient({ baseUrl: 'http://x.test', fetch: f1 })
    expect(await c1.getWorkspaceTree()).toHaveLength(1)
    const f2 = makeFetch(() => jsonResponse({}))
    const c2 = new AgentClient({ baseUrl: 'http://x.test', fetch: f2 })
    expect(await c2.getWorkspaceTree()).toEqual([])
  })

  test('getWorkspaceBundle returns the raw bundle', async () => {
    const f = makeFetch(() => jsonResponse({ files: { 'a.ts': 'aGk=' } }))
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    const out = await c.getWorkspaceBundle()
    expect(out.files['a.ts']).toBe('aGk=')
  })

  test('readFile encodes each path segment individually (slashes preserved)', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => jsonResponse({ content: 'body' }), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    const out = await c.readFile('src/dir with space/a&b.ts')
    expect(out).toBe('body')
    expect(calls[0]!.url).toBe(
      'http://x.test/agent/workspace/files/src/dir%20with%20space/a%26b.ts',
    )
  })

  test('readFile defaults missing content to empty string', async () => {
    const f = makeFetch(() => jsonResponse({}))
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    expect(await c.readFile('x.ts')).toBe('')
  })

  test('writeFile PUTs JSON content', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => emptyOk(), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    await c.writeFile('a.ts', 'hello')
    expect(calls[0]!.url).toBe('http://x.test/agent/workspace/files/a.ts')
    expect(calls[0]!.init!.method).toBe('PUT')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ content: 'hello' })
  })

  test('deleteFile sends DELETE', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => emptyOk(), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    await c.deleteFile('a.ts')
    expect(calls[0]!.init!.method).toBe('DELETE')
  })

  test('searchFiles posts query + optional flags', async () => {
    const calls: Call[] = []
    const f = makeFetch(
      () => jsonResponse({ results: [{ path: 'a', chunk: 'hi', score: 1, lines: '1-2', matchType: 'fts' }] }),
      calls,
    )
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    const res = await c.searchFiles('hi', { limit: 5, pathFilter: 'src' })
    expect(res).toHaveLength(1)
    const body = JSON.parse(calls[0]!.init!.body as string)
    expect(body).toEqual({ query: 'hi', limit: 5, path_filter: 'src' })
  })

  test('searchFiles without options sends just the query', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => jsonResponse({}), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    const res = await c.searchFiles('hi')
    expect(res).toEqual([])
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ query: 'hi' })
  })

  test('uploadWorkspaceFiles defaults missing fields', async () => {
    const f = makeFetch(() => jsonResponse({}))
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    const res = await c.uploadWorkspaceFiles(new FormData())
    expect(res).toEqual({ uploaded: [], count: 0 })
  })

  test('uploadWorkspaceFiles returns server fields when present', async () => {
    const f = makeFetch(() => jsonResponse({ uploaded: ['a', 'b'], count: 2 }))
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    expect(await c.uploadWorkspaceFiles(new FormData())).toEqual({ uploaded: ['a', 'b'], count: 2 })
  })

  test('workspaceFileDownloadUrl encodes path segments', () => {
    const c = new AgentClient({ baseUrl: 'http://x.test' })
    expect(c.workspaceFileDownloadUrl('dir/a b.png')).toBe(
      'http://x.test/agent/workspace/download/dir/a%20b.png',
    )
  })

  test('readFileBlob returns the response Blob', async () => {
    const f = makeFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    const blob = await c.readFileBlob('a.png')
    expect(blob.size).toBe(3)
  })

  test('readFile rejects binary files served with encoding=base64', async () => {
    const f = makeFetch(() =>
      jsonResponse({ encoding: 'base64', contentBase64: 'aGk=' }),
    )
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    await expect(c.readFile('img.png')).rejects.toThrow(
      /Agent readFile: 'img.png' is a binary file — use readFileBlob/,
    )
  })

  test('readFile rejects binary files when only contentBase64 is set', async () => {
    const f = makeFetch(() => jsonResponse({ contentBase64: 'aGVsbG8=' }))
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    await expect(c.readFile('blob.bin')).rejects.toThrow(
      /is a binary file/,
    )
  })

  test('readFile returns content for plain text payloads (text branch)', async () => {
    const f = makeFetch(() => jsonResponse({ content: 'plain text body', encoding: 'utf-8' }))
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    expect(await c.readFile('a.ts')).toBe('plain text body')
  })

  test('readFileBytes returns Uint8Array of the underlying blob bytes', async () => {
    const f = makeFetch(() => new Response(new Uint8Array([7, 8, 9, 10]), { status: 200 }))
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    const bytes = await c.readFileBytes('a.bin')
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(Array.from(bytes)).toEqual([7, 8, 9, 10])
  })

  test('writeFileBytes from Uint8Array base64-encodes the payload and PUTs JSON', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => emptyOk(), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    await c.writeFileBytes('a.bin', new Uint8Array([72, 105])) // "Hi"
    expect(calls[0]!.url).toBe('http://x.test/agent/workspace/files/a.bin')
    expect(calls[0]!.init!.method).toBe('PUT')
    const body = JSON.parse(calls[0]!.init!.body as string)
    expect(body).toEqual({ contentBase64: 'SGk=' })
  })

  test('writeFileBytes accepts ArrayBuffer and base64-encodes it', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => emptyOk(), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    const ab = new Uint8Array([1, 2, 3]).buffer
    await c.writeFileBytes('a.bin', ab)
    const body = JSON.parse(calls[0]!.init!.body as string)
    expect(body).toEqual({ contentBase64: 'AQID' })
  })

  test('writeFileBytes falls back to Buffer.from when btoa is unavailable', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => emptyOk(), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    const originalBtoa = globalThis.btoa
    // Pretend we're in a runtime without btoa
    delete (globalThis as { btoa?: unknown }).btoa
    try {
      await c.writeFileBytes('a.bin', new Uint8Array([72, 105]))
      const body = JSON.parse(calls[0]!.init!.body as string)
      expect(body).toEqual({ contentBase64: 'SGk=' })
    } finally {
      ;(globalThis as { btoa: typeof originalBtoa }).btoa = originalBtoa
    }
  })


  test('mkdirWorkspace posts the path', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => jsonResponse({}), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    await c.mkdirWorkspace('newdir/sub')
    expect(calls[0]!.url).toBe('http://x.test/agent/workspace/mkdir')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ path: 'newdir/sub' })
  })

  test('readWorkspaceConfigFile encodes filename and defaults content', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => jsonResponse({}), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    expect(await c.readWorkspaceConfigFile('AGENTS.md')).toBe('')
    expect(calls[0]!.url).toBe('http://x.test/agent/files/AGENTS.md')
  })

  test('writeWorkspaceConfigFile PUTs JSON content', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => emptyOk(), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    await c.writeWorkspaceConfigFile('AGENTS.md', 'body')
    expect(calls[0]!.init!.method).toBe('PUT')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ content: 'body' })
  })
})

// ---------------------------------------------------------------------------
// plans, mode, control
// ---------------------------------------------------------------------------

describe('AgentClient — plans', () => {
  test('listPlans unwraps { plans }', async () => {
    const f = makeFetch(() =>
      jsonResponse({
        plans: [{ filename: 'a.plan.md', name: 'a', overview: 'o', createdAt: 't', status: 'open' }],
      }),
    )
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    expect(await c.listPlans()).toHaveLength(1)
  })

  test('listPlans defaults to [] when missing', async () => {
    const f = makeFetch(() => jsonResponse({}))
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    expect(await c.listPlans()).toEqual([])
  })

  test('getPlan fetches a single plan', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => jsonResponse({ filename: 'a', content: 'b' }), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    const p = await c.getPlan('a.plan.md')
    expect(p.filename).toBe('a')
    expect(calls[0]!.url).toBe('http://x.test/agent/plans/a.plan.md')
  })

  test('deletePlan and summarizePlan hit the right URLs', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => jsonResponse({ summary: 'sum' }), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    await c.deletePlan('a.plan.md')
    const res = await c.summarizePlan('a.plan.md')
    expect(res.summary).toBe('sum')
    expect(calls[0]!.init!.method).toBe('DELETE')
    expect(calls[1]!.init!.method).toBe('POST')
    expect(calls[1]!.url).toBe('http://x.test/agent/plans/a.plan.md/summarize')
  })
})

describe('AgentClient — export/import', () => {
  test('exportAgentBundle returns the bundle', async () => {
    const f = makeFetch(() =>
      jsonResponse({ version: '1', exportedAt: 'now', projectId: 'p', files: { a: 'b' } }),
    )
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    const b = await c.exportAgentBundle()
    expect(b.projectId).toBe('p')
  })

  test('importAgentBundle POSTs JSON body', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => jsonResponse({ ok: true, imported: 2, files: ['a', 'b'] }), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    const res = await c.importAgentBundle({ version: '1', exportedAt: '', projectId: 'p', files: {} })
    expect(res.imported).toBe(2)
    expect(calls[0]!.init!.method).toBe('POST')
  })
})

describe('AgentClient — mode + control', () => {
  test('getMode unwraps { mode }', async () => {
    const f = makeFetch(() => jsonResponse({ mode: 'canvas' }))
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    expect(await c.getMode()).toBe('canvas')
  })

  test('setMode POSTs the mode', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => jsonResponse({}), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    await c.setMode('app')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ mode: 'app' })
  })

  test('triggerHeartbeat / stop / resetSession POST to right URLs', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => jsonResponse({}), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    await c.triggerHeartbeat()
    await c.stop()
    await c.resetSession()
    expect(calls.map((c) => c.url)).toEqual([
      'http://x.test/agent/heartbeat/trigger',
      'http://x.test/agent/stop',
      'http://x.test/agent/session/reset',
    ])
    for (const call of calls) expect(call.init!.method).toBe('POST')
  })

  test('updateConfig PATCHes the body', async () => {
    const calls: Call[] = []
    const f = makeFetch(() => jsonResponse({}), calls)
    const c = new AgentClient({ baseUrl: 'http://x.test', fetch: f })
    await c.updateConfig({ heartbeat: { enabled: true } })
    expect(calls[0]!.init!.method).toBe('PATCH')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ heartbeat: { enabled: true } })
  })
})

// ---------------------------------------------------------------------------
// getAgentClient singleton
// ---------------------------------------------------------------------------

describe('getAgentClient()', () => {
  test('returns the same instance on subsequent no-arg calls', () => {
    const a = getAgentClient()
    const b = getAgentClient()
    expect(a).toBe(b)
  })

  test('passing a config replaces the singleton', () => {
    const a = getAgentClient()
    const b = getAgentClient({ baseUrl: 'http://other.test' })
    expect(b).not.toBe(a)
    const c = getAgentClient() // no-arg -> reuses the most recent
    expect(c).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// uses globalThis.fetch when no fetch is supplied
// ---------------------------------------------------------------------------

describe('AgentClient — default fetch wiring', () => {
  test('falls back to globalThis.fetch when config.fetch is omitted', async () => {
    const originalFetch = globalThis.fetch
    const stub = mock(async () => jsonResponse({ status: 'ok' }))
    ;(globalThis as Record<string, unknown>).fetch = stub as unknown as typeof fetch
    try {
      const c = new AgentClient({ baseUrl: 'http://x.test' })
      const out = await c.getStatus()
      expect(out).toEqual({ status: 'ok' })
      expect(stub).toHaveBeenCalledTimes(1)
    } finally {
      ;(globalThis as Record<string, unknown>).fetch = originalFetch
    }
  })
})
