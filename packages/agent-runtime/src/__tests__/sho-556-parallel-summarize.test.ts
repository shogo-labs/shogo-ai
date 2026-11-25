// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-556 — the compaction map/reduce.
 *
 * A 350k head used to be ~15 sequential summarizer calls (2–5 minutes before
 * the turn could start). It is now 100k chunks, at most 3 in flight, plus ONE
 * merge call: two round-trips instead of fourteen. The fold still exists for
 * the single-chunk case, which is the common one.
 */
import { describe, test, expect } from 'bun:test'
import type { AssistantMessage, Message, UserMessage } from '@mariozechner/pi-ai'
import {
  DEFAULT_SUMMARIZE_CHUNK_TOKENS,
  SessionManager,
  estimateMessageTokens,
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

/** A message of ~`tokens` tokens (4 chars per token), tagged so order is checkable. */
function chunkMessage(tag: string, tokens: number): Message {
  return user(`${tag} ` + 'x'.repeat(Math.max(1, tokens * 4 - tag.length - 1)))
}

/** `count` messages of 10k tokens each — a 150k head is 15 of them. */
function head(count: number, tag = 'm'): Message[] {
  return Array.from({ length: count }, (_, i) => chunkMessage(`${tag}${i}`, 10_000))
}

interface Call {
  kind: 'map' | 'merge'
  /** Peak concurrent map calls observed when this call started. */
  inFlight: number
  partials?: string[]
  previousSummary?: string
}

/**
 * A fake summarizer that records what it was asked, tracks concurrency, and can
 * be made to finish in reverse order (later chunks first).
 */
function recordingSummarizer(opts: { reverse?: boolean; failOn?: (index: number) => boolean } = {}) {
  const calls: Call[] = []
  let inFlight = 0
  let peak = 0
  let mapCalls = 0

  const summarize = async (chunk: Message[], previousSummary?: string) => {
    const index = mapCalls++
    inFlight++
    peak = Math.max(peak, inFlight)
    calls.push({ kind: 'map', inFlight, previousSummary })
    const wait = opts.reverse ? Math.max(1, 40 - index * 10) : index * 5
    await new Promise((resolve) => setTimeout(resolve, wait))
    inFlight--
    if (opts.failOn?.(index)) throw new Error(`chunk ${index} failed`)
    const tag = String((chunk[0] as any).content).split(' ')[0]
    return `part(${tag})`
  }
  const merge = async (partials: string[], previousSummary?: string) => {
    calls.push({ kind: 'merge', inFlight, partials, previousSummary })
    return `merged(${partials.length})`
  }
  return {
    summarize,
    merge,
    calls,
    get mapCalls() {
      return mapCalls
    },
    get peak() {
      return peak
    },
  }
}

describe('SHO-556: chunk budget', () => {
  test('one call is 100k by default', () => {
    expect(DEFAULT_SUMMARIZE_CHUNK_TOKENS).toBe(100_000)
    const sm = new SessionManager()
    expect(sm.summarizeChunkBudgetTokens).toBe(100_000)
  })

  test('the configured budget and concurrency take effect', async () => {
    const fake = recordingSummarizer()
    const sm = new SessionManager({ summarizeChunkTokens: 10_000, summarizeConcurrency: 2 })
    sm.setSummarizeFn(fake.summarize, { merge: fake.merge })

    // 50k of head at a 10k budget = 5 chunks, never more than 2 in flight.
    await sm.summarizeHead(head(5, 'cfg'))
    expect(fake.mapCalls).toBe(5)
    expect(fake.peak).toBe(2)
  })

  test('the summarizer window clamps the budget so a chunk cannot overflow it', async () => {
    const sm = new SessionManager()
    // 40k window − 16k output − 8k prompt overhead = 16k of transcript per call.
    sm.setSummarizeFn(async () => 'summary', { contextWindowTokens: 40_000 })
    expect(sm.summarizeChunkBudgetTokens).toBe(16_000)
    // 40k of head at 16k per call: two 10k messages would be 20k, so each
    // chunk holds exactly one — 4 calls, not the 1 a 100k budget would make.
    const plan = sm.planSummarizeChunks(head(4, 'win'))
    expect(plan.chunkBudgetTokens).toBe(16_000)
    expect(plan.count).toBe(4)
  })

  test('a large window leaves the default budget alone', () => {
    const sm = new SessionManager()
    sm.setSummarizeFn(async () => 'summary', { contextWindowTokens: 1_000_000 })
    expect(sm.summarizeChunkBudgetTokens).toBe(100_000)
  })
})

describe('SHO-556: map then merge', () => {
  test('a 150k head makes 2 map calls and 1 merge call', async () => {
    const fake = recordingSummarizer()
    const sm = new SessionManager()
    sm.setSummarizeFn(fake.summarize, { merge: fake.merge })

    const result = await sm.summarizeHead(head(15, 'p150'))

    expect(fake.mapCalls).toBe(2)
    expect(fake.calls.filter((c) => c.kind === 'merge')).toHaveLength(1)
    expect(result).toBe('merged(2)')
  })

  test('a 350k head makes 4 map calls with never more than 3 in flight, then 1 merge', async () => {
    const fake = recordingSummarizer()
    const sm = new SessionManager()
    sm.setSummarizeFn(fake.summarize, { merge: fake.merge })

    await sm.summarizeHead(head(35, 'p350'))

    expect(fake.mapCalls).toBe(4)
    expect(fake.peak).toBe(3)
    expect(fake.calls.filter((c) => c.kind === 'merge')).toHaveLength(1)
  })

  test('an 80k head makes exactly one call and no merge call', async () => {
    const fake = recordingSummarizer()
    const sm = new SessionManager()
    sm.setSummarizeFn(fake.summarize, { merge: fake.merge })

    const result = await sm.summarizeHead(head(8, 'p80'))

    expect(fake.mapCalls).toBe(1)
    expect(fake.calls.some((c) => c.kind === 'merge')).toBe(false)
    expect(result).toBe('part(p800)')
  })

  test('partials reach the merge in chunk order even when the calls finish in reverse', async () => {
    const fake = recordingSummarizer({ reverse: true })
    const sm = new SessionManager()
    sm.setSummarizeFn(fake.summarize, { merge: fake.merge })

    await sm.summarizeHead(head(35, 'rev'))

    const merge = fake.calls.find((c) => c.kind === 'merge')!
    expect(merge.partials).toEqual(['part(rev0)', 'part(rev10)', 'part(rev20)', 'part(rev30)'])
  })

  test('with no merge installed the parts are joined in chunk order, with no model call', async () => {
    const fake = recordingSummarizer({ reverse: true })
    const sm = new SessionManager()
    sm.setSummarizeFn(fake.summarize)

    const result = await sm.summarizeHead(head(35, 'join'))

    expect(fake.calls.some((c) => c.kind === 'merge')).toBe(false)
    expect(result).toBe(
      joinPartialSummaries(['part(join0)', 'part(join10)', 'part(join20)', 'part(join30)']),
    )
    expect(result.indexOf('### Part 1')).toBeLessThan(result.indexOf('### Part 4'))
  })
})

describe('SHO-556: previousSummary survives both shapes', () => {
  test('one chunk passes it to the single call', async () => {
    const seen: Array<string | undefined> = []
    const sm = new SessionManager()
    sm.setSummarizeFn(async (_chunk, previousSummary) => {
      seen.push(previousSummary)
      return 'folded'
    })

    await sm.summarizeHead(head(8, 'one'), 'EARLIER RUNNING SUMMARY')

    expect(seen).toEqual(['EARLIER RUNNING SUMMARY'])
  })

  test('many chunks pass it to the merge, never to the map calls', async () => {
    const fake = recordingSummarizer()
    const sm = new SessionManager()
    sm.setSummarizeFn(fake.summarize, { merge: fake.merge })

    await sm.summarizeHead(head(20, 'many'), 'EARLIER RUNNING SUMMARY')

    expect(fake.calls.filter((c) => c.kind === 'map').every((c) => c.previousSummary === undefined)).toBe(true)
    expect(fake.calls.find((c) => c.kind === 'merge')?.previousSummary).toBe('EARLIER RUNNING SUMMARY')
  })
})

describe('SHO-556: failures keep their place', () => {
  test('a failed chunk leaves its extractive text at its own position', async () => {
    const fake = recordingSummarizer({ failOn: (i) => i === 1 })
    const sm = new SessionManager()
    sm.setSummarizeFn(fake.summarize, { merge: fake.merge })

    await sm.summarizeHead(head(35, 'FAILMARK'))

    const merge = fake.calls.find((c) => c.kind === 'merge')!
    expect(merge.partials).toHaveLength(4)
    // Chunk 2 (index 1) is the extractive fallback of its own messages, in its
    // own slot — the others are still the model's part summaries.
    expect(merge.partials![0]).toBe('part(FAILMARK0)')
    expect(merge.partials![1]).toContain('FAILMARK10')
    expect(merge.partials![1]).toContain('[Compacted')
    expect(merge.partials![2]).toBe('part(FAILMARK20)')
    expect(merge.partials![3]).toBe('part(FAILMARK30)')
    expect(sm.isSummarizeCircuitOpen).toBe(false)
  })

  test('three failed chunks trip the breaker and the head falls back extractively', async () => {
    const fake = recordingSummarizer({ failOn: () => true })
    const sm = new SessionManager({ summarizeConcurrency: 1 })
    sm.setSummarizeFn(fake.summarize, { merge: fake.merge })

    const result = await sm.summarizeHead(head(35, 'TRIP'))

    expect(sm.isSummarizeCircuitOpen).toBe(true)
    // One extractive summary of the whole head, and no merge of half a head.
    expect(result).toContain('[Compacted')
    expect(fake.calls.some((c) => c.kind === 'merge')).toBe(false)
  })

  test('a failed merge falls back to the ordered join', async () => {
    const fake = recordingSummarizer()
    const sm = new SessionManager()
    sm.setSummarizeFn(fake.summarize, {
      merge: async () => {
        throw new Error('merge down')
      },
    })

    const result = await sm.summarizeHead(head(35, 'mrg'))

    expect(result).toBe(
      joinPartialSummaries(['part(mrg0)', 'part(mrg10)', 'part(mrg20)', 'part(mrg30)']),
    )
  })
})

describe('SHO-556: the caller can show a status row', () => {
  test('compact announces how many calls are coming, before the first one', async () => {
    let announced: { head: number; chunks: number } | null = null
    const order: string[] = []
    const sm = new SessionManager()
    sm.setSummarizeFn(async () => {
      order.push('summarize')
      return 'S'
    })

    // A turn-boundary split needs user/assistant pairs: 20 of them, 10k each.
    const session = sm.getOrCreate('s1')
    for (let i = 0; i < 20; i++) {
      session.messages.push(user(`u${i} ` + 'y'.repeat(40_000)))
      session.messages.push(assistant(`a${i} ` + 'y'.repeat(40_000)))
    }
    await sm.compact('s1', undefined, undefined, ({ head: h, chunks }) => {
      order.push('start')
      announced = { head: h.length, chunks }
    })

    expect(announced).not.toBeNull()
    expect(announced!.chunks).toBeGreaterThan(1)
    expect(order[0]).toBe('start')
    expect(order).toContain('summarize')
  })

  test('planSummarizeChunks reports the same count summarizeHead then uses', async () => {
    const fake = recordingSummarizer()
    const sm = new SessionManager()
    sm.setSummarizeFn(fake.summarize, { merge: fake.merge })
    const h = head(35, 'plan')
    const plan = sm.planSummarizeChunks(h)
    await sm.summarizeHead(h)
    expect(plan.count).toBe(fake.mapCalls)
  })

  test('estimateMessageTokens is the ruler the chunker uses', () => {
    expect(estimateMessageTokens(chunkMessage('x', 1_000))).toBeGreaterThanOrEqual(1_000)
  })
})
