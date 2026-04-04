// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Session Manager Unit Tests
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { SessionManager, type SummarizeFn } from '../session-manager'
import type { Message, UserMessage, AssistantMessage } from '@mariozechner/pi-ai'

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
  }
}

describe('SessionManager', () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager({
      sessionTtlSeconds: 10,
      maxMessages: 6,
      maxEstimatedTokens: 50_000,
      keepRecentMessages: 2,
      pruneIntervalSeconds: 999,
      // Set a low autocompact threshold so tests can trigger it
      contextWindowTokens: 2_000,
      maxOutputTokens: 500,
      bufferTokens: 500,
      // autocompactThreshold = 2000 - 500 - 500 = 1000 tokens
    })
  })

  describe('session lifecycle', () => {
    test('getOrCreate creates a new session', () => {
      const s = sm.getOrCreate('test-1')
      expect(s.id).toBe('test-1')
      expect(s.messages).toHaveLength(0)
      expect(s.compactedSummary).toBeNull()
      expect(sm.sessionCount).toBe(1)
    })

    test('getOrCreate returns existing session', () => {
      const s1 = sm.getOrCreate('test-1')
      s1.messages.push(user('hello'))
      const s2 = sm.getOrCreate('test-1')
      expect(s2.messages).toHaveLength(1)
    })

    test('get returns undefined for missing session', () => {
      expect(sm.get('missing')).toBeUndefined()
    })

    test('delete removes a session', () => {
      sm.getOrCreate('test-1')
      expect(sm.delete('test-1')).toBe(true)
      expect(sm.sessionCount).toBe(0)
      expect(sm.get('test-1')).toBeUndefined()
    })
  })

  describe('addMessages', () => {
    test('adds messages and updates counters', () => {
      sm.addMessages('s1', user('hello'))
      const s = sm.get('s1')!
      expect(s.messages).toHaveLength(1)
      expect(s.totalMessages).toBe(1)
    })

    test('returns true when estimated tokens exceed autocompact threshold', () => {
      // autocompactThreshold = 1000 tokens; each large message ≈ 1000+ chars ≈ 250+ tokens
      for (let i = 0; i < 5; i++) {
        sm.addMessages('s1', user('x'.repeat(1000)))
      }
      const needsCompact = sm.addMessages('s1', user('x'.repeat(1000)))
      expect(needsCompact).toBe(true)
    })

    test('returns false when under threshold', () => {
      const result = sm.addMessages('s1', user('hello'))
      expect(result).toBe(false)
    })
  })

  describe('clearHistory', () => {
    test('clears messages but keeps session alive', () => {
      sm.addMessages('s1', user('hello'))
      sm.addMessages('s1', assistant('hi'))
      sm.clearHistory('s1')

      const s = sm.get('s1')!
      expect(s.messages).toHaveLength(0)
      expect(s.compactedSummary).toBeNull()
    })
  })

  describe('compaction', () => {
    test('compacts old messages using fallback summarizer', async () => {
      for (let i = 0; i < 6; i++) {
        sm.addMessages('s1', i % 2 === 0 ? user(`Message ${i}`) : assistant(`Message ${i}`))
      }

      const result = await sm.compact('s1')!
      expect(result).not.toBeNull()
      expect(result!.sessionId).toBe('s1')
      expect(result!.messagesAfter).toBe(2)
      expect(result!.compactedCount).toBe(4)
      expect(result!.summary).toContain('Compacted 4 messages')

      const s = sm.get('s1')!
      expect(s.messages).toHaveLength(2)
      expect(s.compactedSummary).toContain('Compacted 4 messages')
      expect(s.compactionCount).toBe(1)
    })

    test('compacts using custom summarize function', async () => {
      const mockSummarize: SummarizeFn = async (msgs) => {
        return `Summary of ${msgs.length} messages: user discussed greetings`
      }
      sm.setSummarizeFn(mockSummarize)

      for (let i = 0; i < 6; i++) {
        sm.addMessages('s1', user(`Hello ${i}`))
      }

      const result = await sm.compact('s1')
      expect(result!.summary).toContain('Summary of 4 messages')
      expect(result!.summary).toContain('greetings')
    })

    test('falls back when summarize function throws', async () => {
      sm.setSummarizeFn(async () => { throw new Error('API down') })

      for (let i = 0; i < 6; i++) {
        sm.addMessages('s1', user(`msg ${i}`))
      }

      const result = await sm.compact('s1')
      expect(result).not.toBeNull()
      expect(result!.summary).toContain('Compacted 4 messages')
    })

    test('returns null when too few messages', async () => {
      sm.addMessages('s1', user('one'))
      const result = await sm.compact('s1')
      expect(result).toBeNull()
    })

    test('multiple compactions accumulate summary', async () => {
      for (let i = 0; i < 6; i++) {
        sm.addMessages('s1', user(`batch1-${i}`))
      }
      await sm.compact('s1')

      for (let i = 0; i < 6; i++) {
        sm.addMessages('s1', user(`batch2-${i}`))
      }
      await sm.compact('s1')

      const s = sm.get('s1')!
      expect(s.compactionCount).toBe(2)
      expect(s.compactedSummary).toContain('batch1')
      expect(s.compactedSummary).toContain('batch2')
    })
  })

  describe('buildHistory', () => {
    test('returns session messages', () => {
      sm.addMessages('s1', user('hello'))
      sm.addMessages('s1', assistant('hi'))

      const msgs = sm.buildHistory('s1')
      expect(msgs).toHaveLength(2)
    })

    test('prepends compacted summary as context', async () => {
      for (let i = 0; i < 6; i++) {
        sm.addMessages('s1', user(`msg ${i}`))
      }
      await sm.compact('s1')

      const msgs = sm.buildHistory('s1')

      // Should have: summary-user, summary-ack, recent[0], recent[1]
      expect(msgs.length).toBeGreaterThanOrEqual(4)
      const firstContent = msgs[0].role === 'user'
        ? (typeof msgs[0].content === 'string' ? msgs[0].content : '')
        : ''
      expect(firstContent).toContain('Previous conversation summary')
      expect(msgs[1].role).toBe('assistant')
    })

    test('returns empty array for missing session', () => {
      const msgs = sm.buildHistory('nonexistent')
      expect(msgs).toHaveLength(0)
    })
  })

  describe('TTL pruning', () => {
    test('prunes expired sessions', async () => {
      const shortTtl = new SessionManager({ sessionTtlSeconds: 0.05 })
      shortTtl.getOrCreate('old-session')

      await new Promise((r) => setTimeout(r, 100))

      const pruned = shortTtl.pruneExpired()
      expect(pruned).toContain('old-session')
      expect(shortTtl.sessionCount).toBe(0)
    })

    test('keeps active sessions', () => {
      sm.getOrCreate('active')
      sm.touch('active')

      const pruned = sm.pruneExpired()
      expect(pruned).toHaveLength(0)
      expect(sm.sessionCount).toBe(1)
    })
  })

  describe('getAllStats', () => {
    test('returns stats for all sessions', () => {
      sm.addMessages('s1', user('a'))
      sm.addMessages('s2', user('b'), assistant('c'))

      const stats = sm.getAllStats()
      expect(stats).toHaveLength(2)

      const s1 = stats.find((s) => s.id === 's1')!
      expect(s1.messageCount).toBe(1)
      expect(s1.totalMessages).toBe(1)
      expect(s1.compactedSummary).toBe(false)

      const s2 = stats.find((s) => s.id === 's2')!
      expect(s2.messageCount).toBe(2)
      expect(s2.totalMessages).toBe(2)
    })
  })

  describe('destroy', () => {
    test('clears all sessions', () => {
      sm.getOrCreate('s1')
      sm.getOrCreate('s2')
      sm.destroy()
      expect(sm.sessionCount).toBe(0)
    })
  })
})
