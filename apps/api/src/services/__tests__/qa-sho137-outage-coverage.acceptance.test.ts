// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — a summarizer outage costs detail, never coverage (SHO-137 B3).
 *
 * Round 4 truncated the joined digest block to CONTEXT_SUMMARY_MAX_CHARS, which
 * keeps the OLDEST bytes: with the model down, a 400-message elision put 308
 * messages in neither the summary nor the tail while the watermark claimed all
 * 400, and they were never folded again. These tests measure the invariant the
 * card exists for, on the real service and its real callers.
 */

import { describe, expect, test } from 'bun:test'
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
}

const mockPrisma = {
  chatSession: {
    findUnique: async ({ where }: any) => store.sessions.get(where.id) ?? null,
    update: async ({ where, data }: any) => {
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
  ensureDurableSummary,
  setChatContextSummarizer,
  CONTEXT_SUMMARY_MAX_CHARS,
} = await import('../chat-history-seed.service')

function seedChat(id: string, count: number, bodyChars: number) {
  store.sessions.set(id, {
    id,
    inferredName: 'deploy chat',
    contextSummary: null,
    contextSummaryThroughCount: 0,
  })
  store.messages = store.messages.filter((m) => m.sessionId !== id)
  for (let i = 0; i < count; i++) {
    store.messages.push({
      id: `${id}-m${i}`,
      sessionId: id,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${String(i).padStart(4, '0')} ${'x'.repeat(bodyChars)}`,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
    })
  }
}

/** What the model would actually receive: the summary block plus the tail. */
function carried(seed: { summary?: string | null; messages: { text: string }[] }) {
  return [seed.summary ?? '', ...seed.messages.map((m) => m.text)].join('\n')
}

describe('SHO-137 QA — an outage never loses a message', () => {
  test('400 large messages, no summarizer: every one is in the summary or the tail', async () => {
    seedChat('qa-outage', 400, 900)
    setChatContextSummarizer(async () => null)

    const seed = (await buildChatHistorySeed('qa-outage'))!
    const text = carried(seed)

    const missing: string[] = []
    for (let i = 0; i < 400; i++) {
      if (!text.includes(`turn-${String(i).padStart(4, '0')}`)) missing.push(`turn-${i}`)
    }
    expect(missing).toEqual([])
    // Compressed, not truncated: the block still fits the column.
    expect((seed.summary ?? '').length).toBeLessThanOrEqual(CONTEXT_SUMMARY_MAX_CHARS)
    // And the split is where the watermark says it is.
    expect(seed.summaryThrough).toBe(400 - seed.messages.length)
  })

  test('a block that cannot hold everything keeps the watermark honest', async () => {
    seedChat('qa-shortfall', 5, 10)
    setChatContextSummarizer(async () => null)

    // 1 200 messages cannot fit 6 000 chars at the minimum line length, so the
    // fallback has to leave a surplus. It must not claim it.
    const covered = Array.from({ length: 1_200 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `short-${String(i).padStart(4, '0')} ${'y'.repeat(200)}`,
    }))
    const result = await ensureDurableSummary({
      sessionId: 'qa-shortfall',
      label: 'deploy chat',
      existing: null,
      existingThrough: 0,
      through: 1_200,
      covered,
    })

    const block = result.summary ?? ''
    expect(block.length).toBeLessThanOrEqual(CONTEXT_SUMMARY_MAX_CHARS)
    // The watermark covers exactly the leading run the block really carries —
    // one line each — so the surplus is folded again on a later turn instead of
    // being claimed and lost.
    expect(result.through).toBeGreaterThan(0)
    expect(result.through).toBeLessThan(1_200)
    expect(block.split('\n').filter(Boolean).length).toBe(result.through + 1) // + heading
  })

  test('the conversation keeps growing after an outage turn — nothing falls out', async () => {
    seedChat('qa-recover', 400, 900)
    setChatContextSummarizer(async () => null)
    const during = (await buildChatHistorySeed('qa-recover'))!
    expect(during.summaryThrough).toBeGreaterThan(0)

    // The model comes back and the conversation continues. A summarizer that
    // does its job keeps a trace of every turn it was handed — that is what the
    // block has to pass it, digest lines included.
    const handed: string[] = []
    setChatContextSummarizer(async ({ messages, previous }: any) => {
      const input = [previous ?? '', ...messages.map((m: any) => m.text)].join('\n')
      handed.push(input)
      const tags = [...input.matchAll(/turn-\d{4}/g)].map((m: string[]) => m[0])
      return `BRIEF ${[...new Set(tags)].join(' ')}`
    })
    for (let i = 400; i < 520; i++) {
      store.messages.push({
        id: `qa-recover-m${i}`,
        sessionId: 'qa-recover',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `turn-${String(i).padStart(4, '0')} ${'x'.repeat(900)}`,
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
      })
    }

    const after = (await buildChatHistorySeed('qa-recover'))!
    const text = carried(after)
    const missing: string[] = []
    for (let i = 0; i < 520; i++) {
      if (!text.includes(`turn-${String(i).padStart(4, '0')}`)) missing.push(`turn-${i}`)
    }
    expect(missing).toEqual([])
    // The outage block was handed to the model whole, not re-cut or dropped.
    expect(handed.length).toBeGreaterThan(0)
    expect(handed[0]).toContain('turn-0000')
  })
})
