// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-556 QA acceptance — the compaction map/reduce, driven from the *outside*.
 *
 * The developer's suite (`sho-556-parallel-summarize.test.ts`) asserts the happy
 * paths with sleep-based fakes. This file pins the three things a regression can
 * quietly undo without any of those failing:
 *
 *   1. Concurrency is a real bound, not "usually 3": the pool starts a call only
 *      when an earlier one settles, measured with deferred promises (AC 1), and
 *      the merge still sees chunk order when the calls finish in reverse (AC 2).
 *   2. Tripping the breaker stops the map at `maxSummarizeFailures` calls and
 *      answers the head with **one** extractive summary — not a join of the
 *      parts that already failed (AC 4). The developer's test only asserted
 *      "breaker open + some extract"; a mutant that lets the pool drain every
 *      failing chunk still passed.
 *   3. `previousSummary` survives the no-merge join too, which is the path the
 *      evals and every runtime without a merge prompt take (AC 3/AC 4).
 *   4. The configured budget and the summarizer-window clamp compose as a
 *      `min`, so a large configured chunk cannot outvote a small summarizer
 *      window (AC 5).
 */
import { describe, test, expect } from 'bun:test'
import type { AssistantMessage, Message, UserMessage } from '@mariozechner/pi-ai'
import {
  DEFAULT_SUMMARIZE_CHUNK_TOKENS,
  DEFAULT_SUMMARIZE_CONCURRENCY,
  SessionManager,
  joinPartialSummaries,
} from '../session-manager'

function user(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: Date.now() }
}

function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'mock',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as AssistantMessage
}

/** A message of ~`tokens` tokens (4 chars/token) tagged so chunk identity is checkable. */
function tagged(tag: string, tokens = 10_000): Message {
  return user(`${tag} ` + 'x'.repeat(Math.max(1, tokens * 4 - tag.length - 1)))
}

/** A head of `count` 10k-token messages: 35 of them is a ~350k head. */
function head(count: number, tag: string): Message[] {
  return Array.from({ length: count }, (_, i) => tagged(`${tag}${i}`))
}

/** Let queued microtasks and timers run so the pool can start its next call. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function firstWord(chunk: Message[]): string {
  return String((chunk[0] as any).content).split(' ')[0]!
}

/**
 * A summarizer whose every call blocks until the test releases it, so "how many
 * are in flight right now" is a fact rather than a race.
 */
function gatedSummarizer() {
  const gates: Array<{ tag: string; resolve: (text: string) => void; reject: (err: Error) => void }> = []
  const started: string[] = []
  let inFlight = 0
  let peak = 0
  const merges: Array<{ partials: string[]; previousSummary?: string }> = []

  const summarize = (chunk: Message[]): Promise<string> => {
    const tag = firstWord(chunk)
    started.push(tag)
    inFlight++
    peak = Math.max(peak, inFlight)
    return new Promise<string>((resolve, reject) => {
      gates.push({
        tag,
        resolve: (text) => { inFlight--; resolve(text) },
        reject: (err) => { inFlight--; reject(err) },
      })
    })
  }

  const merge = async (partials: string[], previousSummary?: string): Promise<string> => {
    merges.push({ partials: [...partials], previousSummary })
    return `MERGED(${partials.join('|')})`
  }

  return {
    summarize,
    merge,
    gates,
    started,
    merges,
    get peak() { return peak },
  }
}

describe('SHO-556 QA: concurrency is a real bound (AC 1, AC 2)', () => {
  test('a 350k head starts exactly 3 calls, starts the 4th only after one settles, and merges in chunk order when they finish in reverse', async () => {
    const fake = gatedSummarizer()
    const sm = new SessionManager()
    sm.setSummarizeFn(fake.summarize, { merge: fake.merge })

    // The budget the plan asks for: 100k a call, 3 at a time.
    expect(DEFAULT_SUMMARIZE_CHUNK_TOKENS).toBe(100_000)
    expect(DEFAULT_SUMMARIZE_CONCURRENCY).toBe(3)

    const chunked = head(35, 'q350')
    expect(sm.planSummarizeChunks(chunked).count).toBe(4)

    const run = sm.summarizeHead(chunked)
    await flush()

    // Three in flight, and the 4th has NOT been started: the pool is bounded.
    expect(fake.started).toHaveLength(3)
    expect(fake.gates).toHaveLength(3)
    expect(fake.peak).toBe(3)

    // Finish them in REVERSE order. Each settle frees a worker for the next chunk.
    fake.gates[2]!.resolve('PART-C')
    await flush()
    expect(fake.started).toHaveLength(4)
    expect(fake.peak).toBe(3)
    fake.gates[3]!.resolve('PART-D')
    await flush()
    fake.gates[1]!.resolve('PART-B')
    await flush()
    fake.gates[0]!.resolve('PART-A')

    const result = await run

    // Chunk order, not completion order.
    expect(fake.merges).toHaveLength(1)
    expect(fake.merges[0]!.partials).toEqual(['PART-A', 'PART-B', 'PART-C', 'PART-D'])
    expect(result).toBe('MERGED(PART-A|PART-B|PART-C|PART-D)')
  })

  test('an 80k head never opens a second call and never calls merge (AC 1)', async () => {
    const fake = gatedSummarizer()
    const sm = new SessionManager()
    sm.setSummarizeFn(fake.summarize, { merge: fake.merge })

    const run = sm.summarizeHead(head(8, 'q80'))
    await flush()
    expect(fake.started).toHaveLength(1)
    fake.gates[0]!.resolve('ONLY-PART')

    expect(await run).toBe('ONLY-PART')
    expect(fake.merges).toHaveLength(0)
  })
})

describe('SHO-556 QA: the breaker stops the map and answers once (AC 4)', () => {
  test('a head whose chunks all fail is answered with ONE extractive summary, not a join of the failed parts', async () => {
    let calls = 0
    let merges = 0
    const sm = new SessionManager({ maxSummarizeFailures: 3 })
    sm.setSummarizeFn(
      async () => { calls++; throw new Error('summarizer down') },
      { merge: async () => { merges++; return 'unused' } },
    )

    const failing = head(75, 'qfail')
    const chunkCount = sm.planSummarizeChunks(failing).count
    expect(chunkCount).toBe(8)

    const result = await sm.summarizeHead(failing)

    expect(sm.isSummarizeCircuitOpen).toBe(true)
    // The pool stops starting calls once the breaker trips — the three workers
    // are already in flight, so the bound is maxFailures + concurrency − 1, and
    // it never drains the whole head. (Sequential on main: exactly 3.)
    expect(calls).toBeLessThanOrEqual(3 + DEFAULT_SUMMARIZE_CONCURRENCY - 1)
    expect(calls).toBeLessThan(chunkCount)
    // One extractive summary of the *whole* head, not a join of the failed
    // parts: `joinPartialSummaries` heading a half-summarized head is the
    // regression this pins.
    expect(result.startsWith('[Compacted 75 messages]')).toBe(true)
    expect(result).not.toContain('### Part')
    // Half a head is never merged.
    expect(merges).toBe(0)
  })

  test('an open breaker short-circuits the next head without calling the summarizer', async () => {
    let calls = 0
    const sm = new SessionManager({ maxSummarizeFailures: 3 })
    sm.setSummarizeFn(async () => { calls++; throw new Error('summarizer down') })

    const result = await sm.summarizeHead(head(35, 'qopen1'))
    expect(sm.isSummarizeCircuitOpen).toBe(true)
    expect(calls).toBeLessThanOrEqual(3 + DEFAULT_SUMMARIZE_CONCURRENCY - 1)
    const callsAtTrip = calls

    const again = await sm.summarizeHead(head(35, 'qopen2'))
    expect(calls).toBe(callsAtTrip)
    expect(again.startsWith('[Compacted 35 messages]')).toBe(true)
  })

  test('previousSummary is kept when the map result is joined instead of merged (AC 3)', async () => {
    const sm = new SessionManager()
    // No merge installed — the shape every eval and any runtime without the
    // merge prompt uses.
    sm.setSummarizeFn(async (chunk) => `part(${firstWord(chunk)})`)

    const result = await sm.summarizeHead(head(15, 'qjoin'), 'EARLIER FOLD')

    expect(result.startsWith('EARLIER FOLD')).toBe(true)
    expect(result).toBe(joinPartialSummaries(['part(qjoin0)', 'part(qjoin10)'], 'EARLIER FOLD'))
  })
})

describe('SHO-556 QA: budget and window compose as a min (AC 5)', () => {
  test('a configured 200k chunk cannot outvote a 40k summarizer window', () => {
    const sm = new SessionManager({ summarizeChunkTokens: 200_000 })
    // 40k window − 16k output − 8k prompt overhead.
    sm.setSummarizeFn(async () => 'summary', { contextWindowTokens: 40_000 })
    expect(sm.summarizeChunkBudgetTokens).toBe(16_000)
    // 4 × 10k messages at 16k a call: one message per chunk.
    expect(sm.planSummarizeChunks(head(4, 'qwin')).count).toBe(4)
  })

  test('an unknown window leaves the configured budget alone', () => {
    const sm = new SessionManager({ summarizeChunkTokens: 60_000 })
    sm.setSummarizeFn(async () => 'summary')
    expect(sm.summarizeChunkBudgetTokens).toBe(60_000)
  })

  test('a summarizer window smaller than its own reserves falls back to the budget rather than a negative chunk', () => {
    const sm = new SessionManager()
    // 10k window can never hold 16k of output + 8k of prompt: the clamp has no
    // answer, so the configured budget stands rather than a negative chunk size.
    sm.setSummarizeFn(async () => 'summary', { contextWindowTokens: 10_000 })
    expect(sm.summarizeChunkBudgetTokens).toBe(DEFAULT_SUMMARIZE_CHUNK_TOKENS)
    expect(sm.planSummarizeChunks(head(2, 'qtiny')).count).toBe(1)
  })
})

describe('SHO-556 QA: the merge call itself', () => {
  test('the merge gets every partial exactly once, in order, with no map call carrying the running fold', async () => {
    const seenByMap: Array<string | undefined> = []
    let merged: { partials: string[]; previousSummary?: string } | null = null
    const sm = new SessionManager()
    sm.setSummarizeFn(
      async (chunk, previousSummary) => {
        seenByMap.push(previousSummary)
        return `part(${firstWord(chunk)})`
      },
      {
        merge: async (partials, previousSummary) => {
          merged = { partials: [...partials], previousSummary }
          return 'COMBINED'
        },
      },
    )

    const result = await sm.summarizeHead(head(15, 'qmrg'), 'EARLIER FOLD')

    expect(result).toBe('COMBINED')
    expect(seenByMap).toEqual([undefined, undefined])
    expect(merged!.partials).toEqual(['part(qmrg0)', 'part(qmrg10)'])
    expect(merged!.previousSummary).toBe('EARLIER FOLD')
  })

  test('an empty merge result falls back to the ordered join instead of wiping the summary', async () => {
    const sm = new SessionManager()
    sm.setSummarizeFn(
      async (chunk) => `part(${firstWord(chunk)})`,
      { merge: async () => '   ' },
    )

    const result = await sm.summarizeHead(head(15, 'qempty'))

    expect(result).toBe(joinPartialSummaries(['part(qempty0)', 'part(qempty10)']))
  })
})

describe('SHO-556 QA: what the status row is told', () => {
  test('compact announces the chunk count it is about to run, before any call', async () => {
    const sm = new SessionManager()
    const order: string[] = []
    sm.setSummarizeFn(async () => { order.push('summarize'); return 'S' })

    const session = sm.getOrCreate('qa-556-announce')
    for (let i = 0; i < 20; i++) {
      session.messages.push(user(`u${i} ` + 'y'.repeat(40_000)))
      session.messages.push(assistant(`a${i} ` + 'y'.repeat(40_000)))
    }

    let announced: { chunks: number; budget: number } | null = null
    await sm.compact('qa-556-announce', undefined, undefined, ({ chunks, chunkBudgetTokens }) => {
      order.push('start')
      announced = { chunks, budget: chunkBudgetTokens }
    })

    expect(order[0]).toBe('start')
    expect(order).toContain('summarize')
    expect(announced!.chunks).toBeGreaterThan(1)
    expect(announced!.budget).toBe(DEFAULT_SUMMARIZE_CHUNK_TOKENS)
  })
})
