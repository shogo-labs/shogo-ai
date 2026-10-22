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
  messages: [] as any[],
}

const mockPrisma = {
  chatMessage: {
    findMany: async ({ where, orderBy, take }: any) => {
      const rows = store.messages.filter((m) => m.sessionId === where.sessionId)
      const ordered = orderBy?.createdAt === 'asc' ? rows : rows.slice().reverse()
      return typeof take === 'number' ? ordered.slice(0, take) : ordered
    },
    count: async ({ where }: any) =>
      store.messages.filter(
        (m) =>
          m.sessionId === where.sessionId &&
          (!where.createdAt?.lt || m.createdAt < where.createdAt.lt),
      ).length,
  },
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
  fitThreadBudget,
  historySeedFor,
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
  store.messages.length = 0
  resetCarriedContext()
  setChatContextSummarizer(null)
})

describe('fitThreadBudget', () => {
  test('keeps a short thread whole', () => {
    const { kept, elided } = fitThreadBudget(thread(6))
    expect(elided).toBe(0)
    expect(kept).toHaveLength(6)
  })

  test('R2 — trimming a thread writes no summary: there is one writer, the seed', async () => {
    store.sessions.set('s-1', { id: 's-1', inferredName: 'planning', contextSummary: null, contextSummaryThroughCount: 0 })
    setChatContextSummarizer(async () => 'WHAT THIS IS: a long planning thread.')

    const { kept, elided } = fitThreadBudget(thread(400))

    const chars = kept.reduce((sum, m) => sum + (m.text?.length ?? 0), 0)
    expect(chars).toBeLessThanOrEqual(THREAD_CONTEXT_BUDGET_CHARS)
    expect(kept.length).toBeGreaterThanOrEqual(THREAD_CONTEXT_TAIL_MESSAGES)
    expect(kept[kept.length - 1]!.id).toBe('c-399')
    expect(elided).toBe(400 - kept.length)
    // Nothing was stored: a channel-wide `seq` must never reach
    // `contextSummaryThroughCount`, which counts this session's own messages.
    expect(store.updates).toHaveLength(0)
    expect(store.sessions.get('s-1').contextSummary).toBeNull()
    expect(store.sessions.get('s-1').contextSummaryThroughCount).toBe(0)
  })

  test('the durable summary a prompt carries comes from historySeedFor, one call per change', async () => {
    store.sessions.set('s-1', { id: 's-1', inferredName: 'planning', contextSummary: null, contextSummaryThroughCount: 0 })
    let calls = 0
    setChatContextSummarizer(async () => {
      calls += 1
      return `summary v${calls}`
    })
    // A session whose own rows are over the seed budget, so it summarises.
    for (let i = 0; i < 40; i++) {
      store.messages.push({
        id: `m-${i}`,
        sessionId: 's-1',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `turn ${i} ${'x'.repeat(4_000)}`,
        createdAt: new Date(2026, 0, 1, 0, 0, i),
      })
    }

    const first = await historySeedFor('s-1')
    const second = await historySeedFor('s-1')

    expect(calls).toBe(1)
    expect(first!.summary).toBe('summary v1')
    expect(second!.summary).toBe('summary v1')
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
