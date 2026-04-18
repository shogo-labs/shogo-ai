// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, sanitizeUserId } from '../store'
import type { Summarizer } from '../types'

describe('sanitizeUserId', () => {
  test('strips unsafe path characters', () => {
    expect(sanitizeUserId('user/123')).toBe('user_123')
    // Leading `..` path-traversal is neutralized (exact underscore count is an impl detail)
    expect(sanitizeUserId('../evil').startsWith('_')).toBe(true)
    expect(sanitizeUserId('../evil')).not.toContain('..')
    expect(sanitizeUserId('../evil')).not.toContain('/')
    expect(sanitizeUserId('  alice@x.com  ')).toBe('alice@x.com')
  })

  test('throws on empty userId', () => {
    expect(() => sanitizeUserId('')).toThrow()
    expect(() => sanitizeUserId('   ')).toThrow()
  })
})

describe('MemoryStore', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shogo-mem-store-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('namespaces workspaces by userId', () => {
    const a = new MemoryStore({ dir, userId: 'alice' })
    const b = new MemoryStore({ dir, userId: 'bob' })
    expect(a.workspaceDir).toBe(join(dir, 'alice'))
    expect(b.workspaceDir).toBe(join(dir, 'bob'))
    a.close()
    b.close()
  })

  test('add() writes MEMORY.md with ISO timestamped bullet', () => {
    const store = new MemoryStore({ dir, userId: 'alice' })
    store.add('prefers window seats')
    const contents = readFileSync(join(store.workspaceDir, 'MEMORY.md'), 'utf-8')
    expect(contents).toContain('# Memory')
    expect(contents).toContain('prefers window seats')
    expect(contents).toMatch(/- \(\d{4}-\d{2}-\d{2}T/)
    store.close()
  })

  test('addDaily() creates memory/YYYY-MM-DD.md', () => {
    const store = new MemoryStore({ dir, userId: 'alice' })
    store.addDaily('Discussed refund for order 4821', '2026-04-18')
    const path = join(store.workspaceDir, 'memory', '2026-04-18.md')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toContain('Discussed refund')
    store.close()
  })

  test('search() round-trips facts written through add()', () => {
    const store = new MemoryStore({ dir, userId: 'alice' })
    store.add('User prefers window seats on long-haul flights')
    store.add('Favorite drink is oolong tea')
    const hits = store.search('window seat', { limit: 3 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.chunk.toLowerCase()).toContain('window')
    store.close()
  })

  test('namespacing: users never see each other memories', () => {
    const alice = new MemoryStore({ dir, userId: 'alice' })
    const bob = new MemoryStore({ dir, userId: 'bob' })
    alice.add('alice loves kayaking')
    bob.add('bob loves guitar')

    const aliceHits = alice.search('guitar')
    const bobHits = bob.search('kayaking')
    expect(aliceHits).toEqual([])
    expect(bobHits).toEqual([])

    expect(alice.search('kayak').length).toBeGreaterThan(0)
    expect(bob.search('guitar').length).toBeGreaterThan(0)

    alice.close()
    bob.close()
  })

  test('ingestTranscript(summarize: true) routes through Summarizer and stores bullets', async () => {
    const stubSummarizer: Summarizer = {
      summarize: async () =>
        '- prefers_window_seat: true\n- favorite_meal: miso salmon\n- relocated_to: Honolulu (2026-04-18)\n',
    }
    const store = new MemoryStore({ dir, userId: 'alice', summarizer: stubSummarizer })
    await store.ingestTranscript('... arbitrary voice call transcript ...', { summarize: true })
    const contents = readFileSync(join(store.workspaceDir, 'MEMORY.md'), 'utf-8')
    expect(contents).toContain('prefers_window_seat: true')
    expect(contents).toContain('favorite_meal: miso salmon')
    expect(contents).toContain('relocated_to: Honolulu')

    const hits = store.search('Honolulu', { limit: 3 })
    expect(hits.length).toBeGreaterThan(0)
    store.close()
  })

  test('ingestTranscript without summarize stores the raw text as a single fact', async () => {
    const store = new MemoryStore({ dir, userId: 'alice' })
    await store.ingestTranscript('User is traveling to Tokyo next month')
    const hits = store.search('Tokyo', { limit: 3 })
    expect(hits.length).toBeGreaterThan(0)
    store.close()
  })

  test('ingestTranscript ignores empty input', async () => {
    const store = new MemoryStore({ dir, userId: 'alice' })
    await store.ingestTranscript('   ')
    expect(existsSync(join(store.workspaceDir, 'MEMORY.md'))).toBe(false)
    store.close()
  })
})
