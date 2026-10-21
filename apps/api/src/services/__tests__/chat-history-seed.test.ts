// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The context a one-message turn carries (SHO-137).
 *
 * A wake, a queued message and a scheduled run each send exactly one message.
 * If the runtime lost the session (idle eviction, pod restart) the model used
 * to see that one line and nothing else. These tests pin what the API attaches
 * instead: the stored tail of the conversation, plus a durable summary of
 * everything older that never shrinks to nothing.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { mock } from 'bun:test'

interface Row {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: Date
}

const store = {
  sessions: new Map<string, any>(),
  messages: [] as Row[],
  updates: [] as any[],
  seq: 0,
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
  chatMessage: {
    findMany: async ({ where, take }: any) => {
      const rows = store.messages
        .filter((m) => m.sessionId === where.sessionId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      return rows.slice(0, take ?? rows.length)
    },
    count: async ({ where }: any) => {
      const before = where.createdAt?.lt
      return store.messages.filter(
        (m) => m.sessionId === where.sessionId && (!before || m.createdAt.getTime() < before.getTime()),
      ).length
    },
  },
}

mock.module('../../lib/prisma', () => ({ prisma: mockPrisma }))

const {
  buildChatHistorySeed,
  historySeedFor,
  extractiveSummary,
  fitTranscriptTail,
  setChatContextSummarizer,
  HISTORY_SEED_BUDGET_CHARS,
} = await import('../chat-history-seed.service')

function addSession(id: string, extra: Record<string, unknown> = {}) {
  store.sessions.set(id, {
    id,
    inferredName: 'deploy chat',
    contextSummary: null,
    contextSummaryThroughCount: 0,
    ...extra,
  })
}

function addMessage(sessionId: string, role: 'user' | 'assistant', content: string) {
  store.seq += 1
  store.messages.push({
    id: `m-${store.seq}`,
    sessionId,
    role,
    content,
    createdAt: new Date(2026, 0, 1, 0, 0, 0, store.seq),
  })
}

beforeEach(() => {
  store.sessions.clear()
  store.messages.length = 0
  store.updates.length = 0
  store.seq = 0
  setChatContextSummarizer(null)
})

describe('history seed', () => {
  test('a short conversation ships whole, and drops the wake it is about', async () => {
    addSession('chat-1')
    addMessage('chat-1', 'user', 'deploy is blocked on the migration')
    addMessage('chat-1', 'assistant', 'running it now')
    // The dispatcher writes the wake row before it calls the runtime; the turn
    // itself is not part of the history it restores.
    addMessage('chat-1', 'user', 'background task finished: migration applied')

    const seed = await historySeedFor('chat-1', { excludeNewestUserMessage: true })

    expect(seed).not.toBeNull()
    expect(seed!.messages.map((m) => m.text)).toEqual([
      'deploy is blocked on the migration',
      'running it now',
    ])
    expect(seed!.summary).toBeNull()
  })

  test('a conversation over budget keeps the tail verbatim and summarises the rest', async () => {
    addSession('chat-1')
    for (let i = 0; i < 40; i++) {
      addMessage('chat-1', 'user', `turn ${i} ${'x'.repeat(4_000)}`)
      addMessage('chat-1', 'assistant', `answer ${i} ${'y'.repeat(4_000)}`)
    }
    setChatContextSummarizer(async () => 'WHAT THIS IS: a long deploy conversation.')

    const seed = await historySeedFor('chat-1')

    expect(seed).not.toBeNull()
    expect(seed!.summary).toBe('WHAT THIS IS: a long deploy conversation.')
    // The tail is under the budget; the head is not sent verbatim.
    const chars = seed!.messages.reduce((sum, m) => sum + m.text.length, 0)
    expect(chars).toBeLessThanOrEqual(HISTORY_SEED_BUDGET_CHARS)
    expect(seed!.messages.length).toBeGreaterThan(0)
    expect(seed!.messages.length).toBeLessThan(80)

    const session = store.sessions.get('chat-1')
    expect(session.contextSummary).toBe('WHAT THIS IS: a long deploy conversation.')
    expect(session.contextSummaryThroughCount).toBeGreaterThan(0)
  })

  test('the summary is stable across turns instead of being rewritten every time', async () => {
    addSession('chat-1')
    for (let i = 0; i < 40; i++) {
      addMessage('chat-1', 'user', `turn ${i} ${'x'.repeat(4_000)}`)
    }
    let calls = 0
    setChatContextSummarizer(async () => {
      calls += 1
      return `summary v${calls}`
    })

    const first = await historySeedFor('chat-1')
    const second = await historySeedFor('chat-1')

    expect(calls).toBe(1)
    expect(first!.summary).toBe('summary v1')
    expect(second!.summary).toBe('summary v1')
  })

  test('a summarizer that fails still leaves a real summary behind', async () => {
    addSession('chat-1')
    for (let i = 0; i < 40; i++) {
      addMessage('chat-1', 'user', `turn ${i} ${'x'.repeat(4_000)}`)
    }
    setChatContextSummarizer(async () => {
      throw new Error('model down')
    })

    const seed = await historySeedFor('chat-1')

    expect(seed!.summary).not.toBeNull()
    expect(seed!.summary).toContain('Conversation so far')
    expect(store.sessions.get('chat-1').contextSummary).toContain('Conversation so far')
  })

  test('an unknown chat yields no seed at all', async () => {
    expect(await buildChatHistorySeed('missing')).toBeNull()
    expect(await historySeedFor('missing')).toBeNull()
  })

  test('a session that only has a stored summary still carries it', async () => {
    addSession('chat-1', { contextSummary: 'Earlier: the release is on hold.', contextSummaryThroughCount: 12 })
    const seed = await historySeedFor('chat-1')
    expect(seed).toEqual({ summary: 'Earlier: the release is on hold.', messages: [] })
  })
})

describe('fitTranscriptTail', () => {
  test('keeps the newest messages and never drops below the floor', () => {
    const rows = [{ text: 'a'.repeat(5_000) }, { text: 'b'.repeat(5_000) }, { text: 'c'.repeat(5_000) }]
    // Budget fits one message, floor of two wins: the turn is never left empty.
    expect(fitTranscriptTail(rows, 6_000, 2).start).toBe(1)
    // No floor: only the newest fits.
    expect(fitTranscriptTail(rows, 6_000, 0).start).toBe(2)
    // Everything fits.
    expect(fitTranscriptTail(rows, 100_000, 2).start).toBe(0)
  })
})

describe('extractiveSummary', () => {
  test('describes the conversation without a model', () => {
    const summary = extractiveSummary('deploy chat', [
      { role: 'user', text: 'the deploy is blocked' },
      { role: 'assistant', text: 'I will rerun the migration' },
    ])
    expect(summary).toContain('Conversation so far (deploy chat)')
    expect(summary).toContain('Asked: the deploy is blocked')
    expect(summary).toContain('Answered: I will rerun the migration')
  })
})
