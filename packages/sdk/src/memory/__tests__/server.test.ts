// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryHandlers } from '../server'
import { MemoryStore } from '../store'

describe('createMemoryHandlers', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shogo-mem-server-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function handlers() {
    const stores = new Map<string, MemoryStore>()
    const h = createMemoryHandlers(({ userId }) => {
      if (!stores.has(userId)) {
        stores.set(userId, new MemoryStore({ dir, userId }))
      }
      return stores.get(userId)!
    })
    return {
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
})
