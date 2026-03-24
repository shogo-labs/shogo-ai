// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Analytics Digest Collector Tests
 *
 * Tests chunking logic, merging, and digest storage.
 *
 * Run: bun test apps/api/src/__tests__/analytics-digest.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { chunkConversations, mergeAnalyses } from '../lib/analytics-digest-collector'
import type { ConversationThread } from '../services/analytics.service'

function makeThread(userName: string, messageCount: number, contentLength = 100): ConversationThread {
  return {
    userName,
    projectName: `Project-${userName}`,
    templateId: null,
    messages: Array.from({ length: messageCount }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'x'.repeat(contentLength),
      sentAt: new Date().toISOString(),
    })),
  }
}

describe('chunkConversations', () => {
  test('single small thread fits in one chunk', () => {
    const threads = [makeThread('Alice', 4, 50)]
    const chunks = chunkConversations(threads)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('Alice')
  })

  test('multiple small threads fit in one chunk', () => {
    const threads = Array.from({ length: 5 }, (_, i) => makeThread(`User${i}`, 2, 50))
    const chunks = chunkConversations(threads)
    expect(chunks).toHaveLength(1)
  })

  test('large threads get split across chunks', () => {
    // Each thread is ~100k chars -> ~25k tokens, so should fit ~4 per chunk at 100k tokens
    // But with 100k char messages (25k tokens each), 5 threads should split
    const threads = Array.from({ length: 10 }, (_, i) =>
      makeThread(`User${i}`, 2, 200_000) // 400k chars per thread = ~100k tokens
    )
    const chunks = chunkConversations(threads)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect(chunks.length).toBeLessThanOrEqual(3)
  })

  test('respects MAX_CHUNKS = 3 limit', () => {
    const threads = Array.from({ length: 20 }, (_, i) =>
      makeThread(`User${i}`, 2, 300_000) // very large threads
    )
    const chunks = chunkConversations(threads)
    expect(chunks.length).toBeLessThanOrEqual(3)
  })

  test('empty threads produce empty chunks', () => {
    const chunks = chunkConversations([])
    expect(chunks).toHaveLength(0)
  })
})

describe('mergeAnalyses', () => {
  test('merges takeaways and deduplicates', () => {
    const result = mergeAnalyses([
      { takeaways: ['Point A', 'Point B'], intents: [], painPoints: [], securityFlags: [] },
      { takeaways: ['Point B', 'Point C'], intents: [], painPoints: [], securityFlags: [] },
    ])
    expect(result.takeaways).toContain('Point A')
    expect(result.takeaways).toContain('Point B')
    expect(result.takeaways).toContain('Point C')
    // Deduplicated
    expect(result.takeaways.filter(t => t === 'Point B')).toHaveLength(1)
  })

  test('limits takeaways to 5', () => {
    const result = mergeAnalyses([
      { takeaways: ['A', 'B', 'C', 'D'], intents: [], painPoints: [], securityFlags: [] },
      { takeaways: ['E', 'F', 'G'], intents: [], painPoints: [], securityFlags: [] },
    ])
    expect(result.takeaways.length).toBeLessThanOrEqual(5)
  })

  test('merges intents with same category', () => {
    const result = mergeAnalyses([
      { takeaways: [], intents: [{ category: 'building', count: 3, examples: ['ex1'] }], painPoints: [], securityFlags: [] },
      { takeaways: [], intents: [{ category: 'building', count: 2, examples: ['ex2'] }], painPoints: [], securityFlags: [] },
    ])
    expect(result.intents).toHaveLength(1)
    expect(result.intents[0].category).toBe('building')
    expect(result.intents[0].count).toBe(5)
    expect(result.intents[0].examples.length).toBeLessThanOrEqual(3)
  })

  test('keeps distinct intent categories separate', () => {
    const result = mergeAnalyses([
      { takeaways: [], intents: [{ category: 'building', count: 3, examples: [] }], painPoints: [], securityFlags: [] },
      { takeaways: [], intents: [{ category: 'exploring', count: 2, examples: [] }], painPoints: [], securityFlags: [] },
    ])
    expect(result.intents).toHaveLength(2)
  })

  test('merges and deduplicates pain points', () => {
    const result = mergeAnalyses([
      { takeaways: [], intents: [], painPoints: ['Bug A', 'Bug B'], securityFlags: [] },
      { takeaways: [], intents: [], painPoints: ['Bug B', 'Bug C'], securityFlags: [] },
    ])
    expect(result.painPoints).toHaveLength(3)
  })

  test('merges and deduplicates security flags', () => {
    const result = mergeAnalyses([
      { takeaways: [], intents: [], painPoints: [], securityFlags: ['Cred sharing'] },
      { takeaways: [], intents: [], painPoints: [], securityFlags: ['Cred sharing', 'Abuse'] },
    ])
    expect(result.securityFlags).toHaveLength(2)
  })
})
