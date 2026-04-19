// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, sanitizeUserId } from '../store'
import type { ConsolidateInput, Summarizer } from '../types'

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
    const result = await store.ingestTranscript('   ')
    expect(result.unchanged).toBe(true)
    expect(result.bullets).toBe(0)
    expect(existsSync(join(store.workspaceDir, 'MEMORY.md'))).toBe(false)
    store.close()
  })

  test('readMemoryBullets strips ISO timestamps and ignores non-bullet lines', () => {
    const store = new MemoryStore({ dir, userId: 'alice' })
    store.add('favorite color: cerulean')
    store.add('lives in Honolulu')
    const bullets = store.readMemoryBullets()
    expect(bullets).toEqual(['favorite color: cerulean', 'lives in Honolulu'])
    store.close()
  })

  test('readMemoryBullets returns [] when MEMORY.md is absent', () => {
    const store = new MemoryStore({ dir, userId: 'ghost' })
    expect(store.readMemoryBullets()).toEqual([])
    store.close()
  })

  describe('ingestTranscript({ consolidate: true })', () => {
    let seen: ConsolidateInput | null
    let consolidator: Summarizer

    beforeEach(() => {
      seen = null
      consolidator = {
        summarize: async () => '',
        consolidate: async input => {
          seen = input
          return '- favorite color: turquoise\n- lives in Honolulu'
        },
      }
    })

    test('rewrites MEMORY.md (does not append) and returns counts', async () => {
      const store = new MemoryStore({ dir, userId: 'alice', summarizer: consolidator })
      store.add('favorite color: cerulean')
      store.add('old_fact: to be dropped')

      const result = await store.ingestTranscript('User: actually turquoise now', {
        consolidate: true,
      })

      expect(result.previous).toBe(2)
      expect(result.bullets).toBe(2)
      expect(result.unchanged).toBe(false)

      const contents = readFileSync(join(store.workspaceDir, 'MEMORY.md'), 'utf-8')
      expect(contents).toContain('turquoise')
      expect(contents).not.toContain('cerulean')
      expect(contents).not.toContain('to be dropped')
      expect(contents.split('\n').filter(l => l.startsWith('-')).length).toBe(2)
      store.close()
    })

    test('passes existing bullets (timestamp-stripped) to the consolidator', async () => {
      const store = new MemoryStore({ dir, userId: 'alice', summarizer: consolidator })
      store.add('favorite color: cerulean')
      store.add('lives in Honolulu')

      await store.ingestTranscript('new transcript', { consolidate: true })

      expect(seen).not.toBeNull()
      expect(seen!.existingBullets).toEqual(['favorite color: cerulean', 'lives in Honolulu'])
      expect(seen!.transcript).toBe('new transcript')
      store.close()
    })

    test('empty consolidator output leaves MEMORY.md untouched', async () => {
      const emptyConsolidator: Summarizer = {
        summarize: async () => '',
        consolidate: async () => '',
      }
      const store = new MemoryStore({ dir, userId: 'alice', summarizer: emptyConsolidator })
      store.add('keep_me: yes')
      const before = readFileSync(join(store.workspaceDir, 'MEMORY.md'), 'utf-8')

      const result = await store.ingestTranscript('small talk', { consolidate: true })

      expect(result.unchanged).toBe(true)
      expect(result.bullets).toBe(0)
      expect(result.previous).toBe(1)
      expect(readFileSync(join(store.workspaceDir, 'MEMORY.md'), 'utf-8')).toBe(before)
      store.close()
    })

    test('reindexes so dropped bullets no longer match searches', async () => {
      const store = new MemoryStore({ dir, userId: 'alice', summarizer: consolidator })
      store.add('favorite color: cerulean')
      expect(store.search('cerulean').length).toBeGreaterThan(0)

      await store.ingestTranscript('turquoise now', { consolidate: true })
      expect(store.search('cerulean').length).toBe(0)
      expect(store.search('turquoise').length).toBeGreaterThan(0)
      store.close()
    })

    test('falls back to summarize() when the summarizer has no consolidate method', async () => {
      let seenPrompt = ''
      const summarizeOnly: Summarizer = {
        summarize: async text => {
          seenPrompt = text
          return '- merged_fact: foo'
        },
      }
      const store = new MemoryStore({ dir, userId: 'alice', summarizer: summarizeOnly })
      store.add('prior_fact: bar')

      const result = await store.ingestTranscript('new transcript text', { consolidate: true })

      expect(result.bullets).toBe(1)
      expect(seenPrompt).toContain('prior_fact: bar')
      expect(seenPrompt).toContain('new transcript text')
      expect(seenPrompt).toContain('Existing memory')
      const contents = readFileSync(join(store.workspaceDir, 'MEMORY.md'), 'utf-8')
      expect(contents).toContain('merged_fact: foo')
      expect(contents).not.toContain('prior_fact: bar')
      store.close()
    })

    test('consolidates onto empty MEMORY.md (first run)', async () => {
      const store = new MemoryStore({ dir, userId: 'fresh', summarizer: consolidator })
      const result = await store.ingestTranscript('hello there', { consolidate: true })
      expect(result.previous).toBe(0)
      expect(result.bullets).toBe(2)
      expect(result.unchanged).toBe(false)
      store.close()
    })

    test('does not clobber MEMORY.md on partial/garbage consolidator output', async () => {
      const noisy: Summarizer = {
        summarize: async () => '',
        consolidate: async () => 'Sure, here are the bullets:\n(no bullets parsed)\n',
      }
      const store = new MemoryStore({ dir, userId: 'alice', summarizer: noisy })
      store.add('keep_me: yes')
      const before = readFileSync(join(store.workspaceDir, 'MEMORY.md'), 'utf-8')

      const result = await store.ingestTranscript('transcript', { consolidate: true })

      expect(result.unchanged).toBe(true)
      expect(readFileSync(join(store.workspaceDir, 'MEMORY.md'), 'utf-8')).toBe(before)
      store.close()
    })

    test('tolerates manually-edited MEMORY.md without timestamps', async () => {
      const store = new MemoryStore({ dir, userId: 'alice', summarizer: consolidator })
      store.add('placeholder')
      writeFileSync(
        join(store.workspaceDir, 'MEMORY.md'),
        '# Memory\n\n- raw bullet without timestamp\n- another one\n',
      )

      const bullets = store.readMemoryBullets()
      expect(bullets).toEqual(['raw bullet without timestamp', 'another one'])

      await store.ingestTranscript('hi', { consolidate: true })
      expect(seen!.existingBullets).toEqual(['raw bullet without timestamp', 'another one'])
      store.close()
    })
  })
})
