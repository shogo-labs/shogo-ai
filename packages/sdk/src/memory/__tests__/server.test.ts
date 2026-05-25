// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryHandlers } from '../server'
import { MemoryStore } from '../store'
import type { Summarizer } from '../types'

describe('createMemoryHandlers', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shogo-mem-server-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function handlers(summarizer?: Summarizer) {
    const stores = new Map<string, MemoryStore>()
    const h = createMemoryHandlers(({ userId }) => {
      if (!stores.has(userId)) {
        stores.set(userId, new MemoryStore({ dir, userId, summarizer }))
      }
      return stores.get(userId)!
    })
    return {
      stores,
      ...h,
      cleanup() {
        for (const s of stores.values()) s.close()
      },
    }
  }

  test('/add persists a fact and /retrieve finds it', async () => {
    const h = handlers()

    const addRes = await h.add(
      new Request('http://localhost/add', {
        method: 'POST',
        body: JSON.stringify({ user_id: 'user_123', fact: 'prefers window seats on flights' }),
      }),
    )
    expect(addRes.status).toBe(200)
    expect(await addRes.json()).toEqual({ ok: true })

    const retRes = await h.retrieve(
      new Request('http://localhost/retrieve', {
        method: 'POST',
        body: JSON.stringify({ user_id: 'user_123', query: 'window seat' }),
      }),
    )
    expect(retRes.status).toBe(200)
    const body = (await retRes.json()) as {
      query: string
      results: Array<{ content: string; lines: string; score: number; matchType: string }>
      totalMatches: number
    }
    expect(body.query).toBe('window seat')
    expect(body.totalMatches).toBeGreaterThan(0)
    expect(body.results[0]!.content.toLowerCase()).toContain('window')
    expect(body.results[0]!.lines).toMatch(/^\d+-\d+$/)

    h.cleanup()
  })

  test('/retrieve isolates memories across users', async () => {
    const h = handlers()
    await h.add(
      new Request('http://localhost/add', {
        method: 'POST',
        body: JSON.stringify({ user_id: 'alice', fact: 'alice goes kayaking on weekends' }),
      }),
    )
    await h.add(
      new Request('http://localhost/add', {
        method: 'POST',
        body: JSON.stringify({ user_id: 'bob', fact: 'bob plays the electric guitar' }),
      }),
    )

    const aliceLooksForBob = await h.retrieve(
      new Request('http://localhost/retrieve', {
        method: 'POST',
        body: JSON.stringify({ user_id: 'alice', query: 'guitar' }),
      }),
    )
    const body = (await aliceLooksForBob.json()) as { totalMatches: number }
    expect(body.totalMatches).toBe(0)

    h.cleanup()
  })

  test('rejects non-POST methods with 405', async () => {
    const h = handlers()
    const res = await h.retrieve(new Request('http://localhost/retrieve', { method: 'GET' }))
    expect(res.status).toBe(405)
    h.cleanup()
  })

  test('400 on missing user_id or query/fact', async () => {
    const h = handlers()

    const badAdd = await h.add(
      new Request('http://localhost/add', {
        method: 'POST',
        body: JSON.stringify({ user_id: 'alice' }),
      }),
    )
    expect(badAdd.status).toBe(400)

    const badRetrieve = await h.retrieve(
      new Request('http://localhost/retrieve', {
        method: 'POST',
        body: JSON.stringify({ query: 'lonely query' }),
      }),
    )
    expect(badRetrieve.status).toBe(400)

    h.cleanup()
  })

  test('400 on invalid JSON body', async () => {
    const h = handlers()
    const res = await h.add(
      new Request('http://localhost/add', {
        method: 'POST',
        body: '{not json',
      }),
    )
    expect(res.status).toBe(400)
    h.cleanup()
  })

  describe('/ingest', () => {
    const merger: Summarizer = {
      summarize: async () => '',
      consolidate: async () => '- favorite color: turquoise\n- lives in Honolulu',
    }

    test('consolidates a transcript and returns bullet counts', async () => {
      const h = handlers(merger)
      await h.add(
        new Request('http://localhost/add', {
          method: 'POST',
          body: JSON.stringify({ user_id: 'alice', fact: 'favorite color: cerulean' }),
        }),
      )

      const res = await h.ingest(
        new Request('http://localhost/ingest', {
          method: 'POST',
          body: JSON.stringify({ user_id: 'alice', transcript: 'now turquoise' }),
        }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        bullets: number
        previous: number
        unchanged: boolean
      }
      expect(body.ok).toBe(true)
      expect(body.bullets).toBe(2)
      expect(body.previous).toBe(1)
      expect(body.unchanged).toBe(false)

      const store = h.stores.get('alice')!
      const contents = readFileSync(join(store.workspaceDir, 'MEMORY.md'), 'utf-8')
      expect(contents).toContain('turquoise')
      expect(contents).not.toContain('cerulean')
      h.cleanup()
    })

    test('400 on missing user_id or transcript', async () => {
      const h = handlers(merger)
      const bad1 = await h.ingest(
        new Request('http://localhost/ingest', {
          method: 'POST',
          body: JSON.stringify({ transcript: 'abc' }),
        }),
      )
      expect(bad1.status).toBe(400)
      const bad2 = await h.ingest(
        new Request('http://localhost/ingest', {
          method: 'POST',
          body: JSON.stringify({ user_id: 'alice' }),
        }),
      )
      expect(bad2.status).toBe(400)
      h.cleanup()
    })

    test('405 on non-POST', async () => {
      const h = handlers(merger)
      const res = await h.ingest(new Request('http://localhost/ingest', { method: 'GET' }))
      expect(res.status).toBe(405)
      h.cleanup()
    })

    test('502 with consolidation_failed when the summarizer throws', async () => {
      const broken: Summarizer = {
        summarize: async () => '',
        consolidate: async () => {
          throw new Error('upstream timeout')
        },
      }
      const h = handlers(broken)
      const res = await h.ingest(
        new Request('http://localhost/ingest', {
          method: 'POST',
          body: JSON.stringify({ user_id: 'alice', transcript: 'anything' }),
        }),
      )
      expect(res.status).toBe(502)
      const body = (await res.json()) as { ok: boolean; error: string; detail: string }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('consolidation_failed')
      expect(body.detail).toContain('upstream timeout')
      h.cleanup()
    })
  })
})

describe('createMemoryHandlers — v3 gap-close', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shogo-mem-gapclose-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function handlers() {
    const stores = new Map<string, MemoryStore>()
    const h = createMemoryHandlers(({ userId }) => {
      if (!stores.has(userId)) stores.set(userId, new MemoryStore({ dir, userId }))
      return stores.get(userId)!
    })
    return { ...h, cleanup() { for (const s of stores.values()) s.close() } }
  }

  // Line 63: retrieve invalid JSON
  test('retrieve: 400 on invalid JSON body', async () => {
    const h = handlers()
    const res = await h.retrieve(new Request('http://localhost/retrieve', {
      method: 'POST',
      body: 'not-json!!!',
      headers: { 'content-type': 'application/json' },
    }))
    expect(res.status).toBe(400)
    h.cleanup()
  })

  // Line 74: retrieve missing query
  test('retrieve: 400 when query is missing', async () => {
    const h = handlers()
    const res = await h.retrieve(new Request('http://localhost/retrieve', {
      method: 'POST',
      body: JSON.stringify({ user_id: 'alice' }),
    }))
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toContain('query')
    h.cleanup()
  })

  // Lines 91-92: retrieve store.search throws
  test('retrieve: 500 when getStore throws', async () => {
    const h2 = createMemoryHandlers(() => { throw new Error('store exploded') })
    const res = await h2.retrieve(new Request('http://localhost/retrieve', {
      method: 'POST',
      body: JSON.stringify({ user_id: 'u', query: 'q' }),
    }))
    expect(res.status).toBe(500)
  })

  // Line 99: add non-POST
  test('add: 405 on GET', async () => {
    const h = handlers()
    const res = await h.add(new Request('http://localhost/add', { method: 'GET' }))
    expect(res.status).toBe(405)
    h.cleanup()
  })

  // Line 110: add missing user_id
  test('add: 400 when user_id is missing', async () => {
    const h = handlers()
    const res = await h.add(new Request('http://localhost/add', {
      method: 'POST',
      body: JSON.stringify({ fact: 'hello' }),
    }))
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toContain('user_id')
    h.cleanup()
  })

  // Lines 120-121: add store.add throws
  test('add: 500 when getStore throws', async () => {
    const h2 = createMemoryHandlers(() => { throw new Error('boom') })
    const res = await h2.add(new Request('http://localhost/add', {
      method: 'POST',
      body: JSON.stringify({ user_id: 'u', fact: 'f' }),
    }))
    expect(res.status).toBe(500)
  })

  // Line 132: ingest invalid JSON
  test('ingest: 400 on invalid JSON body', async () => {
    const h = handlers()
    const res = await h.ingest(new Request('http://localhost/ingest', {
      method: 'POST',
      body: '{{bad}}',
    }))
    expect(res.status).toBe(400)
    h.cleanup()
  })

  // Lines 150-151: ingest getStore throws
  test('ingest: 500 when getStore throws', async () => {
    const h2 = createMemoryHandlers(() => { throw new Error('store init fail') })
    const res = await h2.ingest(new Request('http://localhost/ingest', {
      method: 'POST',
      body: JSON.stringify({ user_id: 'u', transcript: 'hello world' }),
    }))
    expect(res.status).toBe(500)
  })
})

describe('toNodeListener — v3 gap-close', () => {
  // Lines 167-195: toNodeListener wraps a handler for Node-style http.
  test('passes request through and writes status + headers + body to nodeRes', async () => {
    const { toNodeListener } = await import('../server')
    const handler = async (_req: Request) =>
      new Response(JSON.stringify({ hi: 1 }), {
        status: 201,
        headers: { 'content-type': 'application/json', 'x-custom': 'yes' },
      })

    const listener = toNodeListener(handler)

    // Minimal fake IncomingMessage
    const chunks: Buffer[] = [Buffer.from('{"a":1}')]
    let chunkIdx = 0
    const nodeReq: any = {
      method: 'POST',
      url: '/test',
      headers: { host: 'localhost' },
      [Symbol.asyncIterator]: async function* () {
        for (const c of chunks) yield c
      },
    }

    // Minimal fake ServerResponse
    let statusCode = 0
    const setHeaders: Record<string, string> = {}
    let endBuf: Buffer | null = null
    const nodeRes: any = {
      set statusCode(v: number) { statusCode = v },
      get statusCode() { return statusCode },
      setHeader(k: string, v: string) { setHeaders[k] = v },
      end(buf: Buffer) { endBuf = buf },
    }

    listener(nodeReq, nodeRes)
    await new Promise(r => setTimeout(r, 50))

    expect(statusCode).toBe(201)
    expect(setHeaders['x-custom']).toBe('yes')
    expect(endBuf).not.toBeNull()
    const parsed = JSON.parse(endBuf!.toString())
    expect(parsed.hi).toBe(1)
  })

  test('catches async errors from the handler and returns 500', async () => {
    const { toNodeListener } = await import('../server')
    const handler = async () => { throw new Error('inner crash') }
    const listener = toNodeListener(handler)

    let statusCode = 0
    let endBody = ''
    const nodeReq: any = {
      method: 'GET',
      url: '/',
      headers: { host: 'localhost' },
      [Symbol.asyncIterator]: async function* () {},
    }
    const nodeRes: any = {
      set statusCode(v: number) { statusCode = v },
      get statusCode() { return statusCode },
      setHeader() {},
      end(v: any) { endBody = v instanceof Buffer ? v.toString() : String(v) },
    }

    listener(nodeReq, nodeRes)
    await new Promise(r => setTimeout(r, 50))

    expect(statusCode).toBe(500)
    expect(endBody).toContain('inner crash')
  })
})
