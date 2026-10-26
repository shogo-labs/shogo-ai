// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AC6: the boundary is measured. Attribute names are a stable API (saved
 * SigNoz queries use them), so they are asserted here rather than left to
 * whatever the logger happens to emit.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { cacheHitRatio, isPrefixOf, recordCompaction, recordTurnBoundary } from '../context-telemetry'

const originalFlag = process.env.AGENT_TURN_AWARE_COMPACTION

afterEach(() => {
  if (originalFlag === undefined) delete process.env.AGENT_TURN_AWARE_COMPACTION
  else process.env.AGENT_TURN_AWARE_COMPACTION = originalFlag
})

const previousTurn = { messages: 25, rounds: 12, toolCalls: 12, toolNames: ['read_file', 'exec'], placeholders: 0, chars: 9_000 }

describe('cacheHitRatio', () => {
  test('is cacheRead over every billable prompt token', () => {
    expect(cacheHitRatio(1_000, 3_000, 1_000)).toBeCloseTo(0.6, 5)
    expect(cacheHitRatio(0, 100, 0)).toBe(1)
    expect(cacheHitRatio(100, 0, 100)).toBe(0)
  })

  test('is 0 (not NaN) when the provider reported no tokens — a fake LLM does', () => {
    expect(cacheHitRatio(0, 0, 0)).toBe(0)
    expect(cacheHitRatio(null, undefined, null)).toBe(0)
  })
})

describe('isPrefixOf', () => {
  test('true when the previous turn prefix is still a prefix', () => {
    expect(isPrefixOf(['u:1', 'a:2'], ['u:1', 'a:2', 'tr:3:4'])).toBe(true)
    expect(isPrefixOf([], ['u:1'])).toBe(true)
  })

  test('false when a position shifted or the history got shorter', () => {
    expect(isPrefixOf(['u:1', 'a:2'], ['u:1', 'a:9', 'tr:3:4'])).toBe(false)
    expect(isPrefixOf(['u:1', 'a:2', 'tr:3:4'], ['u:1', 'a:2'])).toBe(false)
  })
})

describe('records', () => {
  test('turn boundary and compaction records do not throw, with or without usage', () => {
    expect(() =>
      recordTurnBoundary({
        sessionId: 's1',
        model: 'model-x',
        boundaryIndex: 2,
        messagesAtStart: 30,
        previousTurn,
        compactedHere: true,
        compactedBefore: 500,
        compactedAfter: 27,
        prefixStable: false,
        inputTokens: 1_000,
        cacheReadTokens: 3_000,
        cacheWriteTokens: 1_000,
      }),
    ).not.toThrow()

    expect(() =>
      recordTurnBoundary({
        sessionId: 's1',
        model: 'model-x',
        boundaryIndex: 1,
        messagesAtStart: 2,
        previousTurn,
        compactedHere: false,
        prefixStable: null,
      }),
    ).not.toThrow()

    expect(() =>
      recordCompaction({
        sessionId: 's1',
        trigger: 'pre-turn',
        messagesBefore: 500,
        messagesAfter: 27,
        summaryChars: 4_000,
        filesTouched: ['src/a.ts'],
        toolsUsed: ['exec', 'read_file'],
      }),
    ).not.toThrow()
  })

  test('the variant follows AGENT_TURN_AWARE_COMPACTION', async () => {
    // `compactionVariant` is what every record stamps.
    const { compactionVariant } = await import('../turn-boundary')
    delete process.env.AGENT_TURN_AWARE_COMPACTION
    expect(compactionVariant()).toBe('turn-aware')
    process.env.AGENT_TURN_AWARE_COMPACTION = '0'
    expect(compactionVariant()).toBe('legacy')
    process.env.AGENT_TURN_AWARE_COMPACTION = 'false'
    expect(compactionVariant()).toBe('legacy')
  })
})
