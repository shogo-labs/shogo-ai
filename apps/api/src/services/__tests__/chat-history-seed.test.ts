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

  test('R1 — no message is ever in neither half, at any reuse distance', async () => {
    addSession('chat-1')
    // The summarizer records exactly what it was asked to fold, so a message
    // that skipped a fold shows up as missing from both the summary and the
    // verbatim tail.
    const folded: string[] = []
    setChatContextSummarizer(async ({ messages, previous }) => {
      folded.push(...messages.map((m) => m.text))
      return `${previous ?? 'head'}+${messages.map((m) => m.text).join(',')}`
    })

    // One message elided per turn, up to 19 — the old reuse window. Under the
    // old rule everything in that window was skipped by both halves.
    for (let turn = 1; turn <= 19; turn++) {
      const { ensureDurableSummary } = await import('../chat-history-seed.service')
      addMessage('chat-1', 'user', `m${turn}`)
      const covered = store.messages
        .filter((m) => m.sessionId === 'chat-1')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.content }))
      await ensureDurableSummary({
        sessionId: 'chat-1',
        label: 'deploy chat',
        existing: store.sessions.get('chat-1').contextSummary,
        existingThrough: store.sessions.get('chat-1').contextSummaryThroughCount,
        through: covered.length,
        covered,
      })
    }

    // Every message reached a fold, exactly once, in order.
    expect(folded).toEqual(Array.from({ length: 19 }, (_, i) => `m${i + 1}`))
    const session = store.sessions.get('chat-1')
    expect(session.contextSummaryThroughCount).toBe(19)
    for (let turn = 1; turn <= 19; turn++) {
      expect(session.contextSummary).toContain(`m${turn}`)
    }
  })

  test('R1 — a summarizer outage still covers the newly elided messages', async () => {
    const { ensureDurableSummary } = await import('../chat-history-seed.service')
    addSession('chat-1', { contextSummary: 'Earlier briefing.', contextSummaryThroughCount: 2 })
    setChatContextSummarizer(async () => {
      throw new Error('model down')
    })

    await ensureDurableSummary({
      sessionId: 'chat-1',
      label: 'deploy chat',
      existing: 'Earlier briefing.',
      existingThrough: 2,
      through: 4,
      covered: [
        { role: 'user', text: 'm1' },
        { role: 'assistant', text: 'm2' },
        { role: 'user', text: 'm3 the migration is blocked' },
        { role: 'assistant', text: 'm4 rolling it back' },
      ],
    })

    const session = store.sessions.get('chat-1')
    expect(session.contextSummary).toContain('Earlier briefing.')
    expect(session.contextSummary).toContain('m3 the migration is blocked')
    expect(session.contextSummary).toContain('m4 rolling it back')
    expect(session.contextSummaryThroughCount).toBe(4)
  })

  test('R1 — a fold bigger than one summarizer call still covers every message', async () => {
    const { ensureDurableSummary } = await import('../chat-history-seed.service')
    addSession('chat-1')
    // More than the summarizer takes in one call: the old code folded only the
    // newest 150 and moved the watermark over all of them (round 4, B2).
    const covered = Array.from({ length: 400 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `m${i + 1}`,
    }))
    const batches: Array<{ texts: string[]; previous: string | null }> = []
    setChatContextSummarizer(async ({ messages, previous }) => {
      batches.push({ texts: messages.map((m) => m.text), previous: previous ?? null })
      return `S(${batches.length})`
    })

    const result = await ensureDurableSummary({
      sessionId: 'chat-1',
      label: 'deploy chat',
      existing: null,
      existingThrough: 0,
      through: 400,
      covered,
    })

    // Three calls of at most 150, oldest first, each condensing the last.
    expect(batches.map((b) => b.texts.length)).toEqual([150, 150, 100])
    expect(batches.map((b) => b.previous)).toEqual([null, 'S(1)', 'S(2)'])
    expect(batches.flatMap((b) => b.texts)).toEqual(covered.map((m) => m.text))
    expect(result.through).toBe(400)
    expect(store.sessions.get('chat-1').contextSummaryThroughCount).toBe(400)
  })

  test('R1 — a summarizer outage compresses the block instead of dropping messages', async () => {
    const { ensureDurableSummary, CONTEXT_SUMMARY_MAX_CHARS } = await import('../chat-history-seed.service')
    addSession('chat-1')
    setChatContextSummarizer(async () => null)
    const covered = Array.from({ length: 400 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `turn-${String(i).padStart(3, '0')} ${'x'.repeat(900)}`,
    }))

    const result = await ensureDurableSummary({
      sessionId: 'chat-1',
      label: 'deploy chat',
      existing: null,
      existingThrough: 0,
      through: 400,
      covered,
    })

    // With no model the block is the fallback, but it must still account for
    // every message: truncating the joined digests kept the oldest bytes and
    // dropped the rest while the watermark claimed all 400 (round 4, B3).
    const summary = store.sessions.get('chat-1').contextSummary
    expect(summary.length).toBeLessThanOrEqual(CONTEXT_SUMMARY_MAX_CHARS)
    const missing = covered.filter((m) => !summary.includes(m.text.slice(0, 8)))
    expect(missing.map((m) => m.text.slice(0, 8))).toEqual([])
    // And the watermark claims exactly what the block holds.
    expect(result.through).toBe(400)
    expect(store.sessions.get('chat-1').contextSummaryThroughCount).toBe(400)
  })

  test('R1 — a summarizer outage across several batches still covers every one', async () => {
    const { ensureDurableSummary } = await import('../chat-history-seed.service')
    addSession('chat-1', { contextSummary: 'Earlier briefing.', contextSummaryThroughCount: 5 })
    setChatContextSummarizer(async () => {
      throw new Error('model down')
    })
    const covered = Array.from({ length: 165 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `note ${i + 1}`,
    }))

    await ensureDurableSummary({
      sessionId: 'chat-1',
      label: 'deploy chat',
      existing: 'Earlier briefing.',
      existingThrough: 5,
      through: 165,
      covered,
    })

    const summary = store.sessions.get('chat-1').contextSummary
    expect(summary).toContain('Earlier briefing.')
    // The first message of the first batch and the last of the second — the
    // batch after the one the old code would have stopped at.
    expect(summary).toContain('note 6')
    expect(summary).toContain('note 165')
    expect(store.sessions.get('chat-1').contextSummaryThroughCount).toBe(165)
  })

  test('R4 — a typed turn drops a trailing row that duplicates the prompt it is sending', async () => {
    addSession('chat-1')
    addMessage('chat-1', 'user', 'first question')
    addMessage('chat-1', 'assistant', 'first answer')
    addMessage('chat-1', 'user', 'second question')

    const { historySeedForTurn } = await import('../chat-history-seed.service')
    const seed = await historySeedForTurn('chat-1', 'second   question')

    expect(seed!.messages.map((m) => m.text)).toEqual(['first question', 'first answer'])
  })

  test('R5 — summarize-now rebuilds a summary from the stored rows when the runtime has nothing', async () => {
    addSession('chat-1')
    for (let i = 0; i < 30; i++) addMessage('chat-1', i % 2 === 0 ? 'user' : 'assistant', `turn ${i}`)
    setChatContextSummarizer(async ({ messages }) => `briefing of ${messages.length} messages`)

    const { summarizeSessionFromDb } = await import('../chat-history-seed.service')
    const result = await summarizeSessionFromDb('chat-1', { keepTailChars: 10 })

    expect(result).not.toBeNull()
    expect(result!.through).toBeGreaterThan(0)
    expect(result!.messagesBefore).toBe(30)
    expect(result!.messagesAfter).toBe(30 - result!.through)
    const session = store.sessions.get('chat-1')
    expect(session.contextSummary).toContain('briefing of')
    expect(session.contextSummaryThroughCount).toBe(result!.through)
  })

  test('R5 — summarize-now folds a chat that fits in the tail instead of doing nothing', async () => {
    addSession('chat-1')
    for (let i = 0; i < 5; i++) addMessage('chat-1', i % 2 === 0 ? 'user' : 'assistant', `turn ${i}`)
    setChatContextSummarizer(async ({ messages }) => `briefing of ${messages.length} messages`)

    const { summarizeSessionFromDb } = await import('../chat-history-seed.service')
    const result = await summarizeSessionFromDb('chat-1')

    // Everything but the newest turn is folded: a short chat under the tail
    // budget used to fold nothing, so the button's DB path answered
    // "nothing-to-compact" on every chat small enough to fit (round 4).
    expect(result).not.toBeNull()
    expect(result!.through).toBe(4)
    expect(result!.messagesAfter).toBe(1)
    expect(store.sessions.get('chat-1').contextSummary).toContain('briefing of 4 messages')
  })

  test('R3 — a warm turn carries only what is new since the last agent reply', async () => {
    const { newSinceLastAgentReply } = await import('../chat-history-seed.service')
    const history = [
      { id: 'a', authorType: 'user' },
      { id: 'b', authorType: 'agent' },
      { id: 'c', authorType: 'user' },
      { id: 'd', authorType: 'agent' },
      { id: 'e', authorType: 'user' },
      { id: 'f', authorType: 'user' },
    ]

    expect(newSinceLastAgentReply(history, 'f').map((m) => m.id)).toEqual(['e', 'f'])
    // Nothing answered yet: the whole thread is the new traffic.
    expect(newSinceLastAgentReply(history.slice(0, 1), 'a').map((m) => m.id)).toEqual(['a'])
    // A trigger older than the last reply keeps everything from the trigger on.
    expect(newSinceLastAgentReply(history, 'c').map((m) => m.id)).toEqual(['c', 'd', 'e', 'f'])
  })

  test('an unknown chat yields no seed at all', async () => {
    expect(await buildChatHistorySeed('missing')).toBeNull()
    expect(await historySeedFor('missing')).toBeNull()
  })

  test('R1 — the round-4 probe: 400 large rows, no model, nothing in neither place', async () => {
    addSession('chat-1')
    setChatContextSummarizer(async () => null)
    const rows = Array.from({ length: 400 }, (_, i) => `turn-${String(i).padStart(3, '0')} ${'x'.repeat(900)}`)
    for (let i = 0; i < rows.length; i++) addMessage('chat-1', i % 2 === 0 ? 'user' : 'assistant', rows[i]!)

    const seed = await buildChatHistorySeed('chat-1')
    const carried = [seed!.summary ?? '', ...seed!.messages.map((m) => m.text)].join('\n')

    // Every message is in the summary or in the tail. Truncating the fallback to
    // the first ~26 digests left 308 of these in neither place (round 4, B3).
    const missing = rows.filter((text) => !carried.includes(text.slice(0, 8)))
    expect(missing).toEqual([])
    // And the split is where the watermark says it is: everything after it is
    // carried verbatim.
    expect(seed!.summaryThrough).toBe(400 - seed!.messages.length)
    for (let i = seed!.summaryThrough; i < rows.length; i++) {
      expect(carried).toContain(rows[i]!.slice(0, 8))
    }
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
