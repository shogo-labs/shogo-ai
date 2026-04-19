// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * End-to-end scenarios for the memory module.
 *
 * Simulates a travel-assistant voice agent across a multi-day call history for
 * two isolated users, exercising every layer:
 *   - MemoryStore.add / addDaily with explicit dates
 *   - Hybrid search across MEMORY.md + memory/*.md
 *   - Post-call transcript ingestion through a stub Summarizer
 *   - ElevenLabs-shaped HTTP handlers (/retrieve + /add)
 *   - Persistence across engine close / reopen
 *   - Cross-user isolation
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryHandlers } from '../server'
import { MemoryStore } from '../store'
import type { Summarizer } from '../types'

interface RetrieveResult {
  query: string
  results: Array<{
    file: string
    lines: string
    score: number
    matchType: 'keyword' | 'semantic' | 'hybrid'
    content: string
  }>
  totalMatches: number
}

/** Canned summarizer that keeps tests deterministic without needing a real LLM. */
const travelSummarizer: Summarizer = {
  summarize: async (transcript: string) => {
    const out: string[] = []
    if (/shibuya/i.test(transcript)) out.push('- interest: Shibuya hotel recommendations')
    if (/april 30|return date/i.test(transcript)) out.push('- travel: return date changed to 2026-04-30')
    if (/ana/i.test(transcript)) out.push('- loyalty: ANA Mileage Club member')
    if (out.length === 0) out.push('- note: (no structured facts extracted)')
    return out.join('\n')
  },
}

describe('memory e2e: multi-day travel assistant', () => {
  let root: string
  let alice: MemoryStore
  let bob: MemoryStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'shogo-mem-e2e-'))
    alice = new MemoryStore({ dir: root, userId: 'alice_555_0100', summarizer: travelSummarizer })
    bob = new MemoryStore({ dir: root, userId: 'bob_555_0200', summarizer: travelSummarizer })
  })

  afterEach(() => {
    alice.close()
    bob.close()
    rmSync(root, { recursive: true, force: true })
  })

  test('writes daily logs with distinct date filenames', () => {
    alice.addDaily('Booked flight to Tokyo for April 20', '2026-04-01')
    alice.addDaily('Requested window seat for Tokyo trip', '2026-04-10')
    alice.addDaily('Changed return date to April 30', '2026-04-15')
    alice.addDaily('Asked about hotel recommendations in Shibuya', '2026-04-18')

    const memDir = join(alice.workspaceDir, 'memory')
    const files = readdirSync(memDir).sort()
    expect(files).toEqual([
      '2026-04-01.md',
      '2026-04-10.md',
      '2026-04-15.md',
      '2026-04-18.md',
    ])

    // Each daily file carries its own ISO timestamped bullet
    for (const f of files) {
      const contents = readFileSync(join(memDir, f), 'utf-8')
      expect(contents).toContain('# Daily log')
      expect(contents).toMatch(/- \(\d{4}-\d{2}-\d{2}T/)
    }
  })

  test('searches find memories across the full multi-day history', () => {
    // Long-term facts
    alice.add('prefers_window_seat: true')
    alice.add('dietary: pescatarian')
    alice.add('loyalty_program: ANA Mileage Club')
    alice.add('home_airport: HNL')

    // Daily call history
    alice.addDaily('Booked flight from HNL to Tokyo Narita for April 20', '2026-04-01')
    alice.addDaily('Requested window seat for the Tokyo trip', '2026-04-10')
    alice.addDaily('Changed return date to April 30 on the Tokyo booking', '2026-04-15')
    alice.addDaily('Asked about Tokyo hotel recommendations in Shibuya near Hachiko', '2026-04-18')

    // Broad query should surface entries across multiple daily logs
    const tokyoHits = alice.search('Tokyo', { limit: 10 })
    const tokyoFiles = new Set(tokyoHits.map(h => h.file))
    expect(tokyoFiles.has('memory/2026-04-01.md')).toBe(true)
    expect(tokyoFiles.has('memory/2026-04-10.md')).toBe(true)
    expect(tokyoFiles.has('memory/2026-04-15.md')).toBe(true)
    expect(tokyoFiles.has('memory/2026-04-18.md')).toBe(true)

    // A "window seat" query should find both the MEMORY.md preference and the 2026-04-10 daily log
    const windowHits = alice.search('window seat', { limit: 10 })
    const windowFiles = new Set(windowHits.map(h => h.file))
    expect(windowFiles.has('MEMORY.md')).toBe(true)
    expect(windowFiles.has('memory/2026-04-10.md')).toBe(true)

    // A time-specific fact only lives on 2026-04-15; the unique term "return" pins it
    const returnHits = alice.search('return date changed', { limit: 5 })
    expect(returnHits.length).toBeGreaterThan(0)
    const returnFiles = new Set(returnHits.map(h => h.file))
    expect(returnFiles.has('memory/2026-04-15.md')).toBe(true)
    // The top hit must actually mention "return"
    expect(returnHits[0]!.chunk.toLowerCase()).toContain('return')

    // Shibuya is only in the 2026-04-18 log
    const shibuyaHits = alice.search('Shibuya Hachiko', { limit: 5 })
    expect(shibuyaHits.length).toBeGreaterThan(0)
    expect(shibuyaHits[0]!.file).toBe('memory/2026-04-18.md')

    // Long-term fact is reachable
    const loyaltyHits = alice.search('ANA Mileage Club', { limit: 3 })
    expect(loyaltyHits.length).toBeGreaterThan(0)
    expect(loyaltyHits[0]!.file).toBe('MEMORY.md')
  })

  test('top-k ranks more relevant chunks above less relevant ones', () => {
    alice.add('prefers_window_seat: true')
    alice.addDaily('Booked Tokyo trip with window seat request', '2026-04-10')
    alice.addDaily('Wondered aloud about jet lag remedies', '2026-04-11')
    alice.addDaily('Confirmed vegetarian meal preference for flight', '2026-04-12')

    const hits = alice.search('window seat Tokyo', { limit: 4 })
    expect(hits.length).toBeGreaterThan(0)
    // Top hit must be about window seats, not jet lag or vegetarian meals
    expect(hits[0]!.chunk.toLowerCase()).toContain('window')
    // Scores must be weakly descending
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score >= hits[i]!.score).toBe(true)
    }
  })

  test('ingestTranscript(summarize) writes structured bullets searchable in MEMORY.md', async () => {
    const transcript = `
      Agent: How can I help you today?
      User: I'd love to know what hotels are in Shibuya near the station.
      Agent: I can recommend a few. Also, about your return — last time you mentioned April 30.
      User: Yes, April 30 is the correct return date. And please use my ANA account.
    `
    await alice.ingestTranscript(transcript, { summarize: true })

    const shibuya = alice.search('Shibuya hotel', { limit: 3 })
    const loyalty = alice.search('ANA Mileage Club', { limit: 3 })
    const travel = alice.search('return date 2026-04-30', { limit: 3 })

    expect(shibuya.length).toBeGreaterThan(0)
    expect(shibuya[0]!.file).toBe('MEMORY.md')
    expect(loyalty.length).toBeGreaterThan(0)
    expect(travel.length).toBeGreaterThan(0)
  })

  test('memories persist across engine close and reopen', () => {
    alice.add('home_airport: HNL')
    alice.addDaily('Booked flight HNL to Tokyo', '2026-04-01')

    // First search to build the .memory-index.db
    expect(alice.search('HNL', { limit: 3 }).length).toBeGreaterThan(0)

    // Close & reopen the store; markdown files + SQLite index live on disk
    alice.close()
    const alice2 = new MemoryStore({ dir: root, userId: 'alice_555_0100' })

    const hits = alice2.search('HNL Tokyo', { limit: 5 })
    expect(hits.length).toBeGreaterThan(0)
    const files = new Set(hits.map(h => h.file))
    expect(files.has('MEMORY.md') || files.has('memory/2026-04-01.md')).toBe(true)
    alice2.close()
  })

  test('consolidation resolves a fact conflict (cerulean → turquoise) and rewrites MEMORY.md', async () => {
    // Arrange: a summarizer whose consolidate() simulates an LLM that prefers the
    // most recent value when facts conflict.
    const conflictAwareSummarizer: Summarizer = {
      summarize: async () => '',
      consolidate: async ({ existingBullets, transcript }) => {
        const out: string[] = []
        const mentionsTurquoise = /turquoise/i.test(transcript)
        for (const b of existingBullets) {
          if (mentionsTurquoise && /favorite color:/i.test(b)) continue
          out.push(`- ${b}`)
        }
        if (mentionsTurquoise) out.push('- favorite color: turquoise')
        return out.join('\n')
      },
    }
    const carol = new MemoryStore({
      dir: root,
      userId: 'carol_555_0300',
      summarizer: conflictAwareSummarizer,
    })
    carol.add('favorite color: cerulean')
    carol.add('lives in Honolulu')

    const result = await carol.ingestTranscript(
      'User: Actually I changed my mind — my favorite color is turquoise now.',
      { consolidate: true },
    )
    expect(result.unchanged).toBe(false)
    expect(result.previous).toBe(2)
    expect(result.bullets).toBe(2)

    const contents = readFileSync(join(carol.workspaceDir, 'MEMORY.md'), 'utf-8')
    expect(contents).toContain('turquoise')
    expect(contents).not.toContain('cerulean')
    expect(contents).toContain('lives in Honolulu')

    expect(carol.search('cerulean').length).toBe(0)
    const turquoiseHits = carol.search('turquoise', { limit: 3 })
    expect(turquoiseHits.length).toBeGreaterThan(0)
    expect(turquoiseHits[0]!.file).toBe('MEMORY.md')

    carol.close()
  })

  test('cross-user isolation end-to-end: Alice never sees Bob', () => {
    alice.add('prefers_window_seat: true')
    alice.addDaily('Booked Tokyo trip', '2026-04-01')

    bob.add('prefers_aisle_seat: true')
    bob.addDaily('Booked Berlin trip', '2026-04-02')

    // Alice cannot find Bob's data
    expect(alice.search('aisle').length).toBe(0)
    expect(alice.search('Berlin').length).toBe(0)

    // Bob cannot find Alice's data
    expect(bob.search('window').length).toBe(0)
    expect(bob.search('Tokyo').length).toBe(0)

    // Physical disk layout is also isolated
    const aliceDir = alice.workspaceDir
    const bobDir = bob.workspaceDir
    expect(aliceDir).not.toBe(bobDir)
    expect(existsSync(join(aliceDir, 'MEMORY.md'))).toBe(true)
    expect(existsSync(join(bobDir, 'MEMORY.md'))).toBe(true)
  })
})

describe('memory e2e: ElevenLabs HTTP round-trip across many turns', () => {
  let root: string
  let stores: Map<string, MemoryStore>
  let handlers: ReturnType<typeof createMemoryHandlers>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'shogo-mem-e2e-http-'))
    stores = new Map<string, MemoryStore>()
    handlers = createMemoryHandlers(({ userId }) => {
      if (!stores.has(userId)) {
        stores.set(userId, new MemoryStore({ dir: root, userId }))
      }
      return stores.get(userId)!
    })
  })

  afterEach(() => {
    for (const s of stores.values()) s.close()
    rmSync(root, { recursive: true, force: true })
  })

  async function addFact(user_id: string, fact: string): Promise<Response> {
    return handlers.add(
      new Request('http://localhost/add', {
        method: 'POST',
        body: JSON.stringify({ user_id, fact }),
      }),
    )
  }

  async function retrieve(user_id: string, query: string, limit?: number): Promise<RetrieveResult> {
    const res = await handlers.retrieve(
      new Request('http://localhost/retrieve', {
        method: 'POST',
        body: JSON.stringify({ user_id, query, limit }),
      }),
    )
    expect(res.status).toBe(200)
    return (await res.json()) as RetrieveResult
  }

  test('agent accumulates facts across calls and retrieves them in later calls', async () => {
    const user = 'user_phone_+14155550100'

    // --- Call 1: user introduces themselves (2026-04-01) ---
    expect((await addFact(user, 'name: Alice Chen')).status).toBe(200)
    expect((await addFact(user, 'home_airport: HNL (Honolulu)')).status).toBe(200)
    expect((await addFact(user, 'loyalty_program: ANA Mileage Club member')).status).toBe(200)

    // --- Call 2: travel booking (2026-04-10) ---
    expect((await addFact(user, 'trip_booked: HNL to Tokyo Narita on 2026-04-20')).status).toBe(200)
    expect((await addFact(user, 'seat_preference: window on long-haul flights')).status).toBe(200)

    // --- Call 3: itinerary change (2026-04-15) ---
    expect((await addFact(user, 'trip_update: return date changed to 2026-04-30')).status).toBe(200)

    // --- Call 4: new call days later asks "what was my return date again?" ---
    const returnRes = await retrieve(user, 'return date')
    expect(returnRes.totalMatches).toBeGreaterThan(0)
    expect(returnRes.results[0]!.content.toLowerCase()).toContain('return date')
    expect(returnRes.results[0]!.content).toContain('2026-04-30')
    expect(returnRes.results[0]!.file).toBe('MEMORY.md')
    expect(returnRes.results[0]!.lines).toMatch(/^\d+-\d+$/)

    // Agent retrieves seat preference at the start of the next call
    const seatRes = await retrieve(user, 'seat preference window')
    expect(seatRes.totalMatches).toBeGreaterThan(0)
    expect(seatRes.results[0]!.content.toLowerCase()).toContain('window')

    // Loyalty lookup
    const loyaltyRes = await retrieve(user, 'loyalty ANA')
    expect(loyaltyRes.totalMatches).toBeGreaterThan(0)
    expect(loyaltyRes.results[0]!.content).toContain('ANA Mileage Club')
  })

  test('retrieve limit caps returned results', async () => {
    const user = 'user_bulk'
    for (let i = 0; i < 8; i++) {
      await addFact(user, `flight_${i}: booked flight number SH${i} to destination ${i}`)
    }
    const res = await retrieve(user, 'flight booked destination', 3)
    expect(res.results.length).toBeLessThanOrEqual(3)
    // Every hit must be a bona fide match
    for (const r of res.results) {
      expect(r.content.toLowerCase()).toContain('flight')
    }
  })

  test('two users in concurrent sessions get fully isolated retrieval', async () => {
    await addFact('alice', 'allergy: shellfish')
    await addFact('alice', 'trip_booked: HNL to Tokyo 2026-04-20')

    await addFact('bob', 'allergy: peanuts')
    await addFact('bob', 'trip_booked: SFO to Berlin 2026-06-15')

    const aliceAllergy = await retrieve('alice', 'allergy')
    const bobAllergy = await retrieve('bob', 'allergy')

    expect(aliceAllergy.results[0]!.content).toContain('shellfish')
    expect(bobAllergy.results[0]!.content).toContain('peanuts')

    // Alice must never see Bob's trip, and vice versa
    const aliceBerlin = await retrieve('alice', 'Berlin')
    const bobTokyo = await retrieve('bob', 'Tokyo')
    expect(aliceBerlin.totalMatches).toBe(0)
    expect(bobTokyo.totalMatches).toBe(0)
  })
})

describe('memory e2e: longitudinal history at scale', () => {
  let root: string
  let store: MemoryStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'shogo-mem-e2e-scale-'))
    store = new MemoryStore({ dir: root, userId: 'long_history_user' })
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  test('30 daily logs across a month are all independently searchable', () => {
    const topics: Array<[string, string]> = [
      ['kayaking', 'weekend'],
      ['sushi', 'dinner'],
      ['hiking', 'trail'],
      ['painting', 'watercolor'],
      ['guitar', 'practice'],
      ['coding', 'project'],
      ['movie', 'theater'],
      ['meditation', 'morning'],
      ['running', 'marathon'],
      ['reading', 'novel'],
      ['coffee', 'roast'],
      ['cycling', 'mountain'],
      ['photography', 'landscape'],
      ['gardening', 'tomatoes'],
      ['baking', 'sourdough'],
      ['yoga', 'flexibility'],
      ['chess', 'opening'],
      ['swimming', 'laps'],
      ['board_games', 'strategy'],
      ['podcast', 'episode'],
      ['language', 'japanese'],
      ['volunteering', 'shelter'],
      ['woodworking', 'chair'],
      ['astronomy', 'telescope'],
      ['cooking', 'ramen'],
      ['tennis', 'serve'],
      ['birdwatching', 'binoculars'],
      ['archery', 'bullseye'],
      ['calligraphy', 'brushwork'],
      ['pottery', 'wheel'],
    ]

    // Write 30 daily logs: 2026-04-01 through 2026-04-30
    for (let i = 0; i < topics.length; i++) {
      const day = String(i + 1).padStart(2, '0')
      const [primary, secondary] = topics[i]!
      store.addDaily(`Discussed ${primary} ${secondary} session in depth`, `2026-04-${day}`)
    }

    // Pick 5 random-ish days and verify each topic is retrievable + routed to the right file
    const checks: Array<[number, string, string]> = [
      [1, 'kayaking weekend', '2026-04-01.md'],
      [7, 'movie theater', '2026-04-07.md'],
      [15, 'baking sourdough', '2026-04-15.md'],
      [23, 'woodworking chair', '2026-04-23.md'],
      [30, 'pottery wheel', '2026-04-30.md'],
    ]

    for (const [, query, expectedFileSuffix] of checks) {
      const hits = store.search(query, { limit: 3 })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0]!.file.endsWith(expectedFileSuffix)).toBe(true)
      expect(hits[0]!.chunk.toLowerCase()).toContain(query.split(' ')[0]!)
    }

    // A term that appears in exactly one daily log ranks that log first
    const uniqueHit = store.search('calligraphy brushwork', { limit: 5 })
    expect(uniqueHit[0]!.file).toBe('memory/2026-04-29.md')

    // A term that doesn't appear anywhere returns nothing
    expect(store.search('quantum entanglement').length).toBe(0)
  })

  test('updates to MEMORY.md after initial indexing are picked up in the next search', async () => {
    store.add('initial_fact: user owns a blue kayak')
    expect(store.search('kayak').length).toBeGreaterThan(0)
    expect(store.search('ukulele').length).toBe(0)

    // Wait a tick so the markdown mtime advances past the indexed mtime
    await new Promise(r => setTimeout(r, 15))
    store.add('new_fact: also learning ukulele on weekends')

    const ukuleleHits = store.search('ukulele weekends', { limit: 3 })
    expect(ukuleleHits.length).toBeGreaterThan(0)
    expect(ukuleleHits[0]!.chunk.toLowerCase()).toContain('ukulele')

    // Earlier fact is still reachable
    expect(store.search('blue kayak').length).toBeGreaterThan(0)
  })
})
