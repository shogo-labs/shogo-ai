// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Session Manager — gap-fill coverage for surface area not exercised by
 * session-manager.test.ts: getters, persistence wiring, restoreSessions,
 * startPruning idempotency, persistSession error path, async getOrCreate,
 * applyToolResultBudget and snipConsumedResults pure helpers.
 */

import { describe, test, expect } from 'bun:test'
import {
  SessionManager,
  applyToolResultBudget,
  snipConsumedResults,
  type SessionPersistence,
  type SerializedSession,
  type SummarizeFn,
} from '../session-manager'
import type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
} from '@mariozechner/pi-ai'

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

function toolResult(text: string, toolCallId = `tc_${Math.random().toString(36).slice(2, 8)}`): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'exec',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now(),
  } as ToolResultMessage
}

function makePersistence(opts: Partial<SessionPersistence> & { initial?: SerializedSession[] } = {}): {
  p: SessionPersistence
  saved: SerializedSession[]
  deleted: string[]
} {
  const store = new Map<string, SerializedSession>()
  for (const s of opts.initial ?? []) store.set(s.id, s)
  const saved: SerializedSession[] = []
  const deleted: string[] = []
  const p: SessionPersistence = {
    save: opts.save ?? (async (id, data) => { saved.push(data); store.set(id, data) }),
    load: opts.load ?? (async (id) => store.get(id) ?? null),
    delete: opts.delete ?? (async (id) => { deleted.push(id); store.delete(id) }),
    loadAll: opts.loadAll ?? (async () => Array.from(store.values())),
  }
  return { p, saved, deleted }
}

describe('SessionManager — extra coverage', () => {
  describe('getters and config helpers', () => {
    test('contextWindowTokens defaults to 200_000 when unset', () => {
      const sm = new SessionManager()
      expect(sm.contextWindowTokens).toBe(200_000)
    })

    test('contextWindowTokens returns configured value', () => {
      const sm = new SessionManager({ contextWindowTokens: 64_000 })
      expect(sm.contextWindowTokens).toBe(64_000)
    })

    test('autocompactThreshold uses defaults when unset', () => {
      const sm = new SessionManager()
      expect(sm.autocompactThreshold).toBe(200_000 - 16_384 - 15_000)
    })

    test('autocompactThreshold respects all three configs', () => {
      const sm = new SessionManager({
        contextWindowTokens: 100_000,
        maxOutputTokens: 4_000,
        bufferTokens: 1_000,
      })
      expect(sm.autocompactThreshold).toBe(100_000 - 4_000 - 1_000)
    })

    test('isSummarizeCircuitOpen reflects circuit breaker state', () => {
      const sm = new SessionManager()
      expect(sm.isSummarizeCircuitOpen).toBe(false)
    })

    test('resetCircuitBreaker clears failure count and tripped state', () => {
      const sm = new SessionManager()
      ;(sm as any).consecutiveSummarizeFailures = 5
      ;(sm as any).circuitBreakerTripped = true
      expect(sm.isSummarizeCircuitOpen).toBe(true)
      sm.resetCircuitBreaker()
      expect(sm.isSummarizeCircuitOpen).toBe(false)
      expect((sm as any).consecutiveSummarizeFailures).toBe(0)
    })

    test('setSummarizeFn stores function on instance', () => {
      const sm = new SessionManager()
      const fn: SummarizeFn = async () => 'summary'
      sm.setSummarizeFn(fn)
      expect((sm as any).summarizeFn).toBe(fn)
    })
  })

  describe('persistence wiring', () => {
    test('setPersistence stores persistence backend', () => {
      const sm = new SessionManager()
      const { p } = makePersistence()
      sm.setPersistence(p)
      expect((sm as any).persistence).toBe(p)
    })

    test('restoreSessions returns 0 when no persistence set', async () => {
      const sm = new SessionManager()
      expect(await sm.restoreSessions()).toBe(0)
    })

    test('restoreSessions loads serialized sessions into memory', async () => {
      const initial: SerializedSession[] = [{
        id: 's-restored',
        messages: [user('hi')],
        compactedSummary: null,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        totalMessages: 1,
        compactionCount: 0,
        metadata: { foo: 'bar' },
      }]
      const { p } = makePersistence({ initial })
      const sm = new SessionManager()
      sm.setPersistence(p)
      const origLog = console.log
      console.log = () => {}
      try {
        const restored = await sm.restoreSessions()
        expect(restored).toBe(1)
      } finally { console.log = origLog }
      const got = sm.getOrCreate('s-restored')
      expect(got.messages).toHaveLength(1)
      expect(got.metadata.foo).toBe('bar')
    })

    test('restoreSessions skips already-in-memory ids and defaults metadata', async () => {
      const initial: SerializedSession[] = [
        { id: 's-existing', messages: [], compactedSummary: null, createdAt: 0, lastActivityAt: 0, totalMessages: 0, compactionCount: 0, metadata: undefined as any },
        { id: 's-new',      messages: [], compactedSummary: null, createdAt: 0, lastActivityAt: 0, totalMessages: 0, compactionCount: 0, metadata: undefined as any },
      ]
      const { p } = makePersistence({ initial })
      const sm = new SessionManager()
      sm.setPersistence(p)
      sm.getOrCreate('s-existing')
      const origLog = console.log
      console.log = () => {}
      try {
        const restored = await sm.restoreSessions()
        expect(restored).toBe(1)
      } finally { console.log = origLog }
      expect((sm as any).sessions.get('s-new').metadata).toEqual({})
    })

    test('restoreSessions returns 0 and skips the log when persistence is empty', async () => {
      const { p } = makePersistence({ loadAll: async () => [] })
      const sm = new SessionManager()
      sm.setPersistence(p)
      const restored = await sm.restoreSessions()
      expect(restored).toBe(0)
    })

    test('getOrCreateAsync returns existing in-memory session immediately', async () => {
      const sm = new SessionManager()
      const s1 = sm.getOrCreate('x')
      const s2 = await sm.getOrCreateAsync('x')
      expect(s2).toBe(s1)
    })

    test('getOrCreateAsync rehydrates from persistence when not in memory', async () => {
      const initial: SerializedSession[] = [{
        id: 'p1', messages: [], compactedSummary: null, createdAt: 0, lastActivityAt: 0,
        totalMessages: 0, compactionCount: 0, metadata: undefined as any,
      }]
      const { p } = makePersistence({ initial })
      const sm = new SessionManager()
      sm.setPersistence(p)
      const s = await sm.getOrCreateAsync('p1')
      expect(s.id).toBe('p1')
      expect(s.metadata).toEqual({})
      expect(s.stopRequested).toBe(false)
    })

    test('getOrCreateAsync falls through to in-memory create when not in persistence', async () => {
      const { p } = makePersistence({ load: async () => null })
      const sm = new SessionManager()
      sm.setPersistence(p)
      const s = await sm.getOrCreateAsync('new-id')
      expect(s.id).toBe('new-id')
      expect(s.messages).toHaveLength(0)
    })

    test('getOrCreateAsync without persistence creates new session', async () => {
      const sm = new SessionManager()
      const s = await sm.getOrCreateAsync('no-persist')
      expect(s.id).toBe('no-persist')
    })
  })

  describe('pruning lifecycle', () => {
    test('startPruning is idempotent and stopPruning clears timer', () => {
      const sm = new SessionManager({ pruneIntervalSeconds: 999 })
      sm.startPruning()
      const first = (sm as any).pruneTimer
      expect(first).not.toBeNull()
      sm.startPruning()
      expect((sm as any).pruneTimer).toBe(first)
      sm.destroy()
      expect((sm as any).pruneTimer).toBeNull()
    })

    test('pruneExpired deletes from persistence and logs the eviction', async () => {
      const { p, deleted } = makePersistence()
      const sm = new SessionManager({ sessionTtlSeconds: 0 })
      sm.setPersistence(p)
      sm.getOrCreate('to-prune')
      ;(sm as any).sessions.get('to-prune').lastActivityAt = Date.now() - 60_000
      const origLog = console.log
      console.log = () => {}
      try {
        const pruned = (sm as any).pruneExpired() as string[]
        expect(pruned).toEqual(['to-prune'])
      } finally { console.log = origLog }
      await new Promise(r => setTimeout(r, 5))
      expect(deleted).toContain('to-prune')
    })

    test('pruneExpired logs the persistence-delete failure path', async () => {
      const { p } = makePersistence({ delete: async () => { throw new Error('disk gone') } })
      const sm = new SessionManager({ sessionTtlSeconds: 0 })
      sm.setPersistence(p)
      sm.getOrCreate('boom')
      ;(sm as any).sessions.get('boom').lastActivityAt = Date.now() - 60_000
      const errs: any[] = []
      const origErr = console.error
      const origLog = console.log
      console.error = (...a) => { errs.push(a) }
      console.log = () => {}
      try {
        ;(sm as any).pruneExpired()
        await new Promise(r => setTimeout(r, 10))
      } finally { console.error = origErr; console.log = origLog }
      expect(errs.length).toBeGreaterThan(0)
      expect(String(errs[0].join(' '))).toContain('disk gone')
    })

    test('pruneExpired with no expirees does not log', () => {
      const sm = new SessionManager({ sessionTtlSeconds: 3600 })
      sm.getOrCreate('fresh')
      const logs: any[] = []
      const origLog = console.log
      console.log = (...a) => logs.push(a)
      try {
        const pruned = (sm as any).pruneExpired()
        expect(pruned).toEqual([])
      } finally { console.log = origLog }
      expect(logs).toEqual([])
    })
  })

  describe('persistSession', () => {
    test('returns early when persistence is unset', () => {
      const sm = new SessionManager()
      const session = sm.getOrCreate('s')
      expect(() => (sm as any).persistSession(session)).not.toThrow()
    })

    test('logs error when save() rejects', async () => {
      const { p } = makePersistence({ save: async () => { throw new Error('disk full') } })
      const sm = new SessionManager()
      sm.setPersistence(p)
      const session = sm.getOrCreate('s')
      const errs: any[] = []
      const origErr = console.error
      console.error = (...a) => errs.push(a)
      try {
        ;(sm as any).persistSession(session)
        await new Promise(r => setTimeout(r, 10))
      } finally { console.error = origErr }
      expect(errs.length).toBe(1)
      expect(String(errs[0].join(' '))).toContain('disk full')
    })
  })

  describe('getAllStats', () => {
    test('returns SessionStats for every in-memory session', () => {
      const sm = new SessionManager()
      const s1 = sm.getOrCreate('one')
      s1.messages.push(user('hi'))
      s1.totalMessages = 1
      const s2 = sm.getOrCreate('two')
      s2.compactedSummary = 'summary'
      s2.compactionCount = 2
      const stats = sm.getAllStats()
      expect(stats).toHaveLength(2)
      const byId = Object.fromEntries(stats.map(s => [s.id, s]))
      expect(byId.one.messageCount).toBe(1)
      expect(byId.one.compactedSummary).toBe(false)
      expect(byId.two.compactedSummary).toBe(true)
      expect(byId.two.compactionCount).toBe(2)
      expect(typeof byId.one.createdAt).toBe('string')
      expect(byId.one.idleSeconds).toBeGreaterThanOrEqual(0)
    })
  })
})

describe('applyToolResultBudget', () => {
  test('returns input unchanged when under budget', () => {
    const msgs: Message[] = [
      user('hi'), toolResult('small'), assistant('ack'),
    ]
    const result = applyToolResultBudget(msgs, 100_000)
    expect(result).toBe(msgs)
  })

  test('returns input unchanged when no eligible tool results (all protected)', () => {
    const msgs: Message[] = [
      user('hi'), assistant('a1'),
      user('hi'), toolResult('x'), assistant('a2'),
    ]
    const result = applyToolResultBudget(msgs, 10)
    expect(result).toBe(msgs)
  })

  test('skips frozen ids but still counts their chars toward the budget', () => {
    const t1 = toolResult('x'.repeat(2000), 'frozen-1')
    const t2 = toolResult('y'.repeat(2000), 'eligible-1')
    const msgs: Message[] = [
      user('u1'), t1, assistant('a1'),
      user('u2'), t2, assistant('a2'),
      user('u3'), assistant('a3'),
      user('u4'), assistant('a4'),
      user('u5'), assistant('a5'),
    ]
    const frozen = new Set(['frozen-1'])
    const result = applyToolResultBudget(msgs, 1000, frozen)
    const r1 = result[1] as ToolResultMessage
    const r2 = result[4] as ToolResultMessage
    expect((r1.content[0] as any).text.length).toBe(2000)
    expect((r2.content[0] as any).text.length).toBeLessThan(2000)
  })

  test('soft-trims eligible tool results with head/tail when budget exceeded', () => {
    const big = toolResult('A'.repeat(5000), 't-big')
    const msgs: Message[] = [
      user('u1'), big, assistant('a1'),
      user('u2'), assistant('a2'),
      user('u3'), assistant('a3'),
      user('u4'), assistant('a4'),
    ]
    const result = applyToolResultBudget(msgs, 1000)
    const trimmed = result[1] as ToolResultMessage
    const text = (trimmed.content[0] as any).text as string
    expect(text).toContain('chars trimmed for budget')
    expect(text.length).toBeLessThan(5000)
  })

  test('uses substring fallback when computed tailSize is non-positive', () => {
    const big = toolResult('B'.repeat(3000), 't-tiny')
    const msgs: Message[] = [
      user('u1'), big, assistant('a1'),
      user('u2'), assistant('a2'),
      user('u3'), assistant('a3'),
      user('u4'), assistant('a4'),
    ]
    const result = applyToolResultBudget(msgs, 200)
    const trimmed = result[1] as ToolResultMessage
    const text = (trimmed.content[0] as any).text as string
    expect(text).toContain('[... truncated ...]')
  })

  test('leaves non-text content blocks alone', () => {
    const mixed: ToolResultMessage = {
      role: 'toolResult', toolCallId: 'tc-mix', toolName: 'exec',
      content: [
        { type: 'text', text: 'C'.repeat(3000) } as any,
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'xx' } } as any,
      ],
      isError: false, timestamp: Date.now(),
    }
    const msgs: Message[] = [
      user('u1'), mixed, assistant('a1'),
      user('u2'), assistant('a2'),
      user('u3'), assistant('a3'),
      user('u4'), assistant('a4'),
    ]
    const result = applyToolResultBudget(msgs, 600)
    const trimmed = result[1] as ToolResultMessage
    expect((trimmed.content[1] as any).type).toBe('image')
  })

  test('skips zero-char tool results (continue branch)', () => {
    const empty: ToolResultMessage = {
      role: 'toolResult', toolCallId: 'tc-empty', toolName: 'exec',
      content: [], isError: false, timestamp: Date.now(),
    }
    const big = toolResult('Z'.repeat(3000), 't-big2')
    const msgs: Message[] = [
      user('u1'), empty, assistant('a1'),
      user('u2'), big, assistant('a2'),
      user('u3'), assistant('a3'),
      user('u4'), assistant('a4'),
    ]
    const result = applyToolResultBudget(msgs, 1000)
    expect(result[1]).toBe(empty)
  })

  test('skips text-content items already inside per-result budget', () => {
    const small = toolResult('xxx', 't-mini')
    const big = toolResult('A'.repeat(5000), 't-big3')
    const msgs: Message[] = [
      user('u1'), small, big, assistant('a1'),
      user('u2'), assistant('a2'),
      user('u3'), assistant('a3'),
      user('u4'), assistant('a4'),
    ]
    const result = applyToolResultBudget(msgs, 1000)
    const stillSmall = result[1] as ToolResultMessage
    expect((stillSmall.content[0] as any).text).toBe('xxx')
  })
})

describe('snipConsumedResults', () => {
  test('returns input unchanged when no following assistant turn exists', () => {
    const msgs: Message[] = [user('u'), toolResult('x'.repeat(500))]
    const result = snipConsumedResults(msgs)
    expect(result[1]).toBe(msgs[1])
  })

  test('protects recent results within protectedTurns', () => {
    const t = toolResult('y'.repeat(500))
    const msgs: Message[] = [
      user('u1'), assistant('a1'),
      user('u2'), t, assistant('a2'),
    ]
    const result = snipConsumedResults(msgs, 3)
    expect(result[3]).toBe(t)
  })

  test('snips old results with following assistant turn', () => {
    const t = toolResult('z'.repeat(500))
    const msgs: Message[] = [
      user('u1'), t, assistant('a1'),
      user('u2'), assistant('a2'),
      user('u3'), assistant('a3'),
      user('u4'), assistant('a4'),
    ]
    const result = snipConsumedResults(msgs, 2)
    const snipped = result[1] as ToolResultMessage
    expect((snipped.content[0] as any).text).toContain('Tool output processed')
  })

  test('skips frozen tool calls even when otherwise eligible', () => {
    const t = toolResult('w'.repeat(500), 'frozen-z')
    const msgs: Message[] = [
      user('u1'), t, assistant('a1'),
      user('u2'), assistant('a2'),
      user('u3'), assistant('a3'),
      user('u4'), assistant('a4'),
    ]
    const result = snipConsumedResults(msgs, 2, new Set(['frozen-z']))
    expect(result[1]).toBe(t)
  })

  test('does not snip results under 200 chars even when eligible', () => {
    const small = toolResult('tiny')
    const msgs: Message[] = [
      user('u1'), small, assistant('a1'),
      user('u2'), assistant('a2'),
      user('u3'), assistant('a3'),
      user('u4'), assistant('a4'),
    ]
    const result = snipConsumedResults(msgs, 2)
    expect(result[1]).toBe(small)
  })

  test('returns non-toolResult messages untouched', () => {
    const u = user('hello')
    const a = assistant('hi')
    const msgs: Message[] = [u, a]
    const result = snipConsumedResults(msgs)
    expect(result[0]).toBe(u)
    expect(result[1]).toBe(a)
  })
})

import { pruneToolResults } from '../session-manager'

describe('pruneToolResults', () => {
  test('soft-trims oversized tool results with head+tail truncation', () => {
    const big = toolResult('A'.repeat(15000), 't-soft')
    const msgs: Message[] = [
      user('u1'), big, assistant('a1'),
      user('u2'), assistant('a2'),
      user('u3'), assistant('a3'),
      user('u4'), assistant('a4'),
      user('u5'), assistant('a5'),
    ]
    const result = pruneToolResults(msgs, { keepLastTurns: 2, softTrimMaxChars: 1000, hardClearAfterTurns: 99 })
    const trimmed = result[1] as ToolResultMessage
    const text = (trimmed.content[0] as any).text as string
    expect(text).toContain('chars trimmed')
    expect(text.length).toBeLessThan(15000)
  })

  test('hard-clears very old tool results', () => {
    const old = toolResult('Q'.repeat(500), 't-hard')
    const msgs: Message[] = [
      user('u1'), old, assistant('a1'),
      user('u2'), assistant('a2'),
      user('u3'), assistant('a3'),
      user('u4'), assistant('a4'),
      user('u5'), assistant('a5'),
    ]
    const result = pruneToolResults(msgs, { keepLastTurns: 1, softTrimMaxChars: 10000, hardClearAfterTurns: 2 })
    const cleared = result[1] as ToolResultMessage
    expect((cleared.content[0] as any).text).toContain('Tool result cleared')
  })

  test('leaves recent results within keepLastTurns untouched', () => {
    const big = toolResult('X'.repeat(15000))
    const msgs: Message[] = [
      user('u1'), assistant('a1'),
      user('u2'), big, assistant('a2'),
    ]
    const result = pruneToolResults(msgs, { keepLastTurns: 3, softTrimMaxChars: 100 })
    expect(result[3]).toBe(big)
  })

  test('leaves non-text content blocks untouched within soft-trim path', () => {
    const mixed: ToolResultMessage = {
      role: 'toolResult', toolCallId: 'mix', toolName: 'exec',
      content: [
        { type: 'text', text: 'D'.repeat(3000) } as any,
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'xx' } } as any,
      ],
      isError: false, timestamp: Date.now(),
    }
    const msgs: Message[] = [
      user('u1'), mixed, assistant('a1'),
      user('u2'), assistant('a2'),
      user('u3'), assistant('a3'),
      user('u4'), assistant('a4'),
      user('u5'), assistant('a5'),
    ]
    const result = pruneToolResults(msgs, { keepLastTurns: 2, softTrimMaxChars: 1000, hardClearAfterTurns: 99 })
    const out = result[1] as ToolResultMessage
    expect((out.content[1] as any).type).toBe('image')
  })

  test('skips text-content items already within softTrim limit', () => {
    const mixed: ToolResultMessage = {
      role: 'toolResult', toolCallId: 'small', toolName: 'exec',
      content: [
        { type: 'text', text: 'short text' } as any,
        { type: 'text', text: 'E'.repeat(3000) } as any,
      ],
      isError: false, timestamp: Date.now(),
    }
    const msgs: Message[] = [
      user('u1'), mixed, assistant('a1'),
      user('u2'), assistant('a2'),
      user('u3'), assistant('a3'),
      user('u4'), assistant('a4'),
      user('u5'), assistant('a5'),
    ]
    const result = pruneToolResults(msgs, { keepLastTurns: 2, softTrimMaxChars: 1000, hardClearAfterTurns: 99 })
    const out = result[1] as ToolResultMessage
    expect((out.content[0] as any).text).toBe('short text')
  })

  test('returns non-toolResult messages and within-budget results unchanged', () => {
    const tr = toolResult('small')
    const msgs: Message[] = [user('u'), tr, assistant('a')]
    const result = pruneToolResults(msgs)
    expect(result[0]).toBe(msgs[0])
    expect(result[1]).toBe(tr)
  })
})
