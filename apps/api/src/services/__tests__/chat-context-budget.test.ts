// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One context builder for a team-chat agent's prompt (SHO-137).
 *
 * The prompt used to be six messages and then whatever followed the agent's
 * last reply, on the assumption that the runtime still held the rest. When the
 * runtime had dropped the session, the prompt *was* the wake note. These tests
 * pin the replacement: the whole thread down to a character budget, plus a
 * durable summary of everything older, with nothing silently missing.
 */

import { beforeEach, describe, expect, test, mock } from 'bun:test'

const store = {
  sessions: new Map<string, any>(),
  updates: [] as any[],
}

const mockPrisma = {
  chatSession: {
    findUnique: async ({ where }: any) => store.sessions.get(where.id) ?? null,
    update: async ({ where, data }: any) => {
      store.updates.push({ where, data })
      const session = store.sessions.get(where.id)
      if (session) Object.assign(session, data)
      return session ?? null
    },
  },
}

mock.module('../../lib/prisma', () => ({ prisma: mockPrisma }))

const {
  budgetThreadContext,
  noteCarriedContext,
  resetCarriedContext,
  setChatContextSummarizer,
  THREAD_CONTEXT_BUDGET_CHARS,
  THREAD_CONTEXT_TAIL_MESSAGES,
} = await import('../chat-history-seed.service')

function thread(count: number, size = 500) {
  return Array.from({ length: count }, (_, i) => ({
    id: `c-${i}`,
    seq: i + 1,
    authorType: i % 2 === 0 ? 'user' : 'agent',
    text: `message ${i} ${'z'.repeat(size)}`,
  }))
}

beforeEach(() => {
  store.sessions.clear()
  store.updates.length = 0
  resetCarriedContext()
  setChatContextSummarizer(null)
})

describe('budgetThreadContext', () => {
  test('keeps a short thread whole and invents no summary', async () => {
    store.sessions.set('s-1', { id: 's-1', inferredName: 'planning', contextSummary: null, contextSummaryThroughCount: 0 })
    const rows = thread(6)

    const { kept, elided, summary } = await budgetThreadContext(rows, 's-1')

    expect(elided).toBe(0)
    expect(kept).toHaveLength(6)
    expect(summary).toBeNull()
    expect(store.updates).toHaveLength(0)
  })

  test('AC4 — a dropped runtime session never yields a stub prompt', async () => {
    store.sessions.set('s-1', { id: 's-1', inferredName: 'planning', contextSummary: null, contextSummaryThroughCount: 0 })
    setChatContextSummarizer(async () => 'WHAT THIS IS: a long planning thread.')
    const rows = thread(400)

    const { kept, summary } = await budgetThreadContext(rows, 's-1')

    const chars = kept.reduce((sum, m) => sum + (m.text?.length ?? 0), 0)
    expect(chars).toBeLessThanOrEqual(THREAD_CONTEXT_BUDGET_CHARS)
    expect(kept.length).toBeGreaterThanOrEqual(THREAD_CONTEXT_TAIL_MESSAGES)
    // The retained tail is the *newest* messages, and every message after the
    // watermark is in the prompt.
    expect(kept[kept.length - 1]!.id).toBe('c-399')
    const watermark = store.sessions.get('s-1').contextSummaryThroughCount
    expect(watermark).toBeGreaterThan(0)
    expect(kept[0]!.seq).toBe(watermark + 1)
    expect(summary).toContain('long planning thread')
  })

  test('AC5 — the summary is stored once and reused byte-for-byte', async () => {
    store.sessions.set('s-1', { id: 's-1', inferredName: 'planning', contextSummary: null, contextSummaryThroughCount: 0 })
    let calls = 0
    setChatContextSummarizer(async () => {
      calls += 1
      return `summary v${calls}`
    })
    const rows = thread(400)

    const first = await budgetThreadContext(rows, 's-1')
    const second = await budgetThreadContext(rows, 's-1')

    expect(calls).toBe(1)
    expect(first.summary).toBe('summary v1')
    expect(second.summary).toBe('summary v1')
    expect(store.sessions.get('s-1').contextSummary).toBe('summary v1')
  })

  test('without a session the tail still ships, and the log says why', async () => {
    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '))
    try {
      const { kept, summary } = await budgetThreadContext(thread(400), null)
      expect(summary).toBeNull()
      expect(kept.length).toBeGreaterThan(0)
      expect(warnings.join('\n')).toContain('context_collapse')
      expect(warnings.join('\n')).toContain('cause=no-session')
    } finally {
      console.warn = original
    }
  })
})

describe('noteCarriedContext', () => {
  test('shouts when a turn carries materially less of the conversation', () => {
    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '))
    try {
      noteCarriedContext('s-1', 30, { elided: 0, summarised: false })
      noteCarriedContext('s-1', 2, { elided: 0, summarised: false })
      expect(warnings.join('\n')).toContain('context_collapse')
      expect(warnings.join('\n')).toContain('carried=2')
      expect(warnings.join('\n')).toContain('previous=30')
      expect(warnings.join('\n')).toContain('cause=transcript-shrank')
    } finally {
      console.warn = original
    }
  })

  test('a summarised window shrinking to the tail is expected, not a collapse', () => {
    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '))
    try {
      noteCarriedContext('s-1', 30, { elided: 0, summarised: false })
      noteCarriedContext('s-1', THREAD_CONTEXT_TAIL_MESSAGES, { elided: 380, summarised: true })
      expect(warnings).toHaveLength(0)
    } finally {
      console.warn = original
    }
  })

  test('an empty transcript is always loud', () => {
    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '))
    try {
      noteCarriedContext('s-1', 0, { elided: 0, summarised: false })
      expect(warnings.join('\n')).toContain('cause=empty-transcript')
    } finally {
      console.warn = original
    }
  })
})
