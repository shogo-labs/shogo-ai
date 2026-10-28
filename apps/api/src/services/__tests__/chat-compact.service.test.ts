// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The DB-fold half of "Summarize now" (SHO-230).
 *
 * When the runtime no longer holds the session the API folds the stored
 * ChatMessage rows with sequential LLM calls. On a 192k-token chat that is
 * minutes of work, and the request used to wait for all of it — the button
 * spun until the connection died. Now the fold is raced against a budget:
 * past it the request answers 202 `summarizing` and the fold finishes
 * detached. A second press during a fold answers the same 202 instead of
 * starting a second fold over the same history.
 *
 *   bun test apps/api/src/services/__tests__/chat-compact.service.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

type Fold = { summary: string; through: number; messagesBefore: number; messagesAfter: number } | null

let foldImpl: () => Promise<Fold> = async () => null
const foldCalls: string[] = []
const compactionRows: any[] = []

mock.module('../../lib/prisma', () => ({
  prisma: {
    chatSession: { findUnique: async () => ({ id: 'sess-1' }) },
    chatMessage: {
      create: async (args: any) => {
        compactionRows.push(args.data)
        return { id: `row-${compactionRows.length}`, ...args.data }
      },
    },
  },
}))

mock.module('../chat-history-seed.service', () => ({
  summarizeSessionFromDb: async (chatSessionId: string) => {
    foldCalls.push(chatSessionId)
    return foldImpl()
  },
}))

const { compactChatSession, resetCompactFoldsForTests } = await import('../chat-compact.service')

/** The runtime answers "unknown-session" for a session it no longer holds. */
const evictedRuntime = async () =>
  new Response(JSON.stringify({ compacted: false, queued: false, reason: 'session not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const folded: Fold = { summary: 'SUMMARY', through: 228, messagesBefore: 240, messagesAfter: 12 }

beforeEach(() => {
  foldImpl = async () => null
  foldCalls.length = 0
  compactionRows.length = 0
  resetCompactFoldsForTests()
})

describe('compactChatSession — bounded DB fold', () => {
  test('a fold that finishes inside the budget answers compacted from the DB', async () => {
    foldImpl = async () => folded

    const { body, status } = await compactChatSession({
      chatSessionId: 'sess-1',
      logTag: '[Test]',
      fetchRuntime: evictedRuntime,
    })

    expect(status).toBe(200)
    expect(body).toMatchObject({
      compacted: true,
      queued: false,
      source: 'db',
      messagesBefore: 240,
      messagesAfter: 12,
    })
    expect(compactionRows.length).toBe(1)
  })

  test('a fold that outlives the budget answers 202 and finishes detached', async () => {
    const gate = deferred<Fold>()
    foldImpl = () => gate.promise

    const { body, status } = await compactChatSession({
      chatSessionId: 'sess-1',
      logTag: '[Test]',
      fetchRuntime: evictedRuntime,
      dbFoldBudgetMs: 20,
    })

    expect(status).toBe(202)
    expect(body).toMatchObject({ compacted: false, queued: true, status: 'summarizing' })
    expect(String(body.reason)).toContain('Summarizing in the background')
    expect(compactionRows.length).toBe(0)

    // The request is over; the fold keeps going and still persists its row.
    gate.resolve(folded)
    await gate.promise
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(compactionRows.length).toBe(1)
    expect(JSON.stringify(compactionRows[0]?.parts)).toContain('data-context-summarized')
  })

  test('a second press during a fold answers 202 without starting another fold', async () => {
    const gate = deferred<Fold>()
    foldImpl = () => gate.promise

    const args = {
      chatSessionId: 'sess-1',
      logTag: '[Test]',
      fetchRuntime: evictedRuntime,
      dbFoldBudgetMs: 20,
    }
    const first = await compactChatSession(args)
    const second = await compactChatSession(args)

    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(second.body).toMatchObject({ queued: true, status: 'summarizing' })
    expect(foldCalls).toEqual(['sess-1'])

    gate.resolve(folded)
    await gate.promise
    await new Promise((resolve) => setTimeout(resolve, 10))
    // One fold, one row — the dedupe is what keeps it from double-billing.
    expect(compactionRows.length).toBe(1)
  })

  test('nothing foldable is reported as such, not as a success', async () => {
    foldImpl = async () => null

    const { body, status } = await compactChatSession({
      chatSessionId: 'sess-1',
      logTag: '[Test]',
      fetchRuntime: evictedRuntime,
    })

    expect(status).toBe(200)
    expect(body).toMatchObject({
      compacted: false,
      queued: false,
      status: 'nothing-to-compact',
    })
    expect(compactionRows.length).toBe(0)
  })
})
