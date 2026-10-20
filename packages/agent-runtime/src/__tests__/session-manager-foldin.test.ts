// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-96 — the fold-in summarizer.
 *
 * A 400k head used to be summarized from its first 12k characters, so a
 * "successful" summarize dropped the decisions it exists to preserve. The head
 * is now chunked and folded: every chunk reaches the summarizer, each one
 * receives the running summary, and a failure falls back to extraction instead
 * of silently losing that chunk.
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
      // The real summarizer folds the running summary into its prompt.
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
    // Every chunk was folded in, ending with the last one's text.
    expect(summary).toContain(`chunk-${seen.length}`)
    expect(summary).toContain('chunk-1')
  })

  test('each chunk receives the running summary so nothing is dropped between chunks', async () => {
    const carries: Array<string | undefined> = []
    const sm = new SessionManager({ summarizeChunkTokens: 6_000 })
    sm.setSummarizeFn(async (_chunk, previousSummary) => {
      carries.push(previousSummary)
      return `${previousSummary ?? 'ROOT'} > next`
    })

    const head: Message[] = Array.from({ length: 4 }, (_, i) =>
      user(`segment ${i} ` + 'b'.repeat(11_990)),
    )
    const summary = await sm.summarizeHead(head)

    expect(carries.length).toBeGreaterThan(1)
    expect(carries[0]).toBeUndefined()
    expect(carries.slice(1).every((c) => typeof c === 'string' && c.length > 0)).toBe(true)
    expect(summary).toContain('ROOT')
  })

  test('a thrown chunk falls back to extraction and keeps folding', async () => {
    let calls = 0
    const sm = new SessionManager({ summarizeChunkTokens: 6_000 })
    sm.setSummarizeFn(async (_chunk, previousSummary) => {
      calls++
      if (calls === 1) throw new Error('summarizer down')
      return `${previousSummary ?? ''} second-chunk`.trim()
    })

    const head: Message[] = Array.from({ length: 4 }, (_, i) =>
      user(`MARKER_${i} ` + 'c'.repeat(11_990)),
    )
    const summary = await sm.summarizeHead(head)

    // The failed first chunk is preserved extractively rather than dropped.
    expect(summary).toContain('MARKER_0')
    expect(summary).toContain('second-chunk')
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
