// SPDX-License-Identifier: Apache-2.0
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
