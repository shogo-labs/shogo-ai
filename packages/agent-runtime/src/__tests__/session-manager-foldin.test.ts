// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-96 — the fold-in summarizer, as the parallel map (SHO-556).
 *
 * A 400k head used to be summarized from its first 12k characters, so a
 * "successful" summarize dropped the decisions it exists to preserve. The head
 * is chunked so every chunk reaches the summarizer, the partials are combined
 * in chunk order, and a failure falls back to extraction for that chunk instead
 * of silently losing it.
 */
import { describe, test, expect } from 'bun:test'
import type { Message, UserMessage } from '@mariozechner/pi-ai'
import { SessionManager, estimateMessageTokens } from '../session-manager'

function user(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: Date.now() }
}

describe('SessionManager.summarizeHead (fold-in)', () => {
  test('chunks the head at the configured budget instead of truncating it', async () => {
    const seen: number[] = []
    const sm = new SessionManager({ summarizeChunkTokens: 12_000 })
    sm.setSummarizeFn(async (chunk, previousSummary) => {
      const tokens = chunk.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
      seen.push(tokens)
      // A chunk summary is the fold of its own excerpt; the caller carries the
      // running summary across chunks in the merge call, not here.
      return `${previousSummary ?? ''} chunk-${seen.length}`.trim()
    })

    // 12 messages × 3,000 tokens (12k chars each) = 36k tokens.
    const head: Message[] = Array.from({ length: 12 }, (_, i) =>
      user(`step ${i} ` + 'a'.repeat(11_990)),
    )
    const summary = await sm.summarizeHead(head)

    expect(seen.length).toBeGreaterThan(1)
    // No chunk is over budget (a single oversized message is the only case
    // allowed to exceed it, and there is none here).
    for (const tokens of seen) expect(tokens).toBeLessThanOrEqual(12_000)
    // Every chunk's summary is in the result, in chunk order — nothing dropped.
    for (let i = 1; i <= seen.length; i++) expect(summary).toContain(`chunk-${i}`)
    expect(summary.indexOf('chunk-1')).toBeLessThan(summary.indexOf(`chunk-${seen.length}`))
  })

  test('the merge receives the running summary and every chunk, in order', async () => {
    const carries: Array<string | undefined> = []
    const merged: string[][] = []
    const sm = new SessionManager({ summarizeChunkTokens: 6_000 })
    sm.setSummarizeFn(async (_chunk, previousSummary) => {
      carries.push(previousSummary)
      return `segment-${carries.length}`
    }, {
      merge: async (partials, previousSummary) => {
        merged.push(partials)
        return `${previousSummary ?? 'ROOT'} | ${partials.join(' + ')}`
      },
    })

    const head: Message[] = Array.from({ length: 4 }, (_, i) =>
      user(`segment ${i} ` + 'b'.repeat(11_990)),
    )
    const summary = await sm.summarizeHead(head, 'EARLIER')

    expect(carries.length).toBeGreaterThan(1)
    // The map calls carry no shared state: the running summary is the merge's.
    expect(carries.every((c) => c === undefined)).toBe(true)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toEqual(carries.map((_, i) => `segment-${i + 1}`))
    expect(summary).toContain('EARLIER')
  })

  test('a thrown chunk falls back to extraction, in its own slot', async () => {
    let calls = 0
    const sm = new SessionManager({ summarizeChunkTokens: 6_000, summarizeConcurrency: 1 })
    sm.setSummarizeFn(async () => {
      calls++
      if (calls === 1) throw new Error('summarizer down')
      return `chunk-${calls}`
    })

    const head: Message[] = Array.from({ length: 4 }, (_, i) =>
      user(`MARKER_${i} ` + 'c'.repeat(11_990)),
    )
    const summary = await sm.summarizeHead(head)

    // The failed first chunk is preserved extractively rather than dropped, and
    // it stays ahead of the chunk that did summarize.
    expect(summary).toContain('MARKER_0')
    expect(summary).toContain('chunk-2')
    expect(summary.indexOf('MARKER_0')).toBeLessThan(summary.indexOf('chunk-2'))
  })

  test('a failed single-chunk summarize keeps the earlier fold instead of dropping it', async () => {
    const sm = new SessionManager()
    sm.setSummarizeFn(async () => {
      throw new Error('summarizer down')
    })

    // One message is one chunk under the 100k default budget.
    const summary = await sm.summarizeHead([user('LATEST_DECISION ' + 'e'.repeat(11_990))], 'EARLIER_FOLD')

    expect(summary).toContain('EARLIER_FOLD')
    expect(summary).toContain('LATEST_DECISION')
    expect(summary.indexOf('EARLIER_FOLD')).toBeLessThan(summary.indexOf('LATEST_DECISION'))
  })

  test('a breaker trip mid-map keeps the earlier fold too', async () => {
    const sm = new SessionManager({ summarizeChunkTokens: 6_000, maxSummarizeFailures: 2 })
    sm.setSummarizeFn(async () => {
      throw new Error('nope')
    })

    const head: Message[] = Array.from({ length: 4 }, (_, i) => user(`MARKER_${i} ` + 'f'.repeat(11_990)))
    const summary = await sm.summarizeHead(head, 'EARLIER_FOLD')

    expect(sm.isSummarizeCircuitOpen).toBe(true)
    expect(summary).toContain('EARLIER_FOLD')
    expect(summary.length).toBeGreaterThan('EARLIER_FOLD'.length)
  })

  test('trips the circuit breaker after repeated failures', async () => {
    const sm = new SessionManager({ summarizeChunkTokens: 6_000, maxSummarizeFailures: 2 })
    sm.setSummarizeFn(async () => {
      throw new Error('nope')
    })

    const head: Message[] = Array.from({ length: 4 }, (_, i) => user(`x ${i} ` + 'd'.repeat(11_990)))
    const summary = await sm.summarizeHead(head)

    expect(sm.isSummarizeCircuitOpen).toBe(true)
    expect(summary.length).toBeGreaterThan(0)
  })
})
