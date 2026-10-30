// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Team-chat delta reads (SHO-260): `listMessagesUnchecked` with `changedSince`
 * returns the rows whose `updatedAt` moved, for a channel and for a thread,
 * and hands back the cursor the client stores.
 *
 * Run: bun test apps/api/src/__tests__/conversation-changed-since.test.ts
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type Row = Record<string, any>

const rows: Row[] = []

function matches(row: Row, where: any): boolean {
  if (!where) return true
  if (where.conversationId && row.conversationId !== where.conversationId) return false
  if (where.threadRootId === null && row.threadRootId) return false
  if (typeof where.threadRootId === 'string' && row.threadRootId !== where.threadRootId) return false
  if (where.updatedAt?.gte && new Date(row.updatedAt).getTime() < new Date(where.updatedAt.gte).getTime()) {
    return false
  }
  if (where.seq?.gt !== undefined && !(row.seq > where.seq.gt)) return false
  if (where.alsoSentToChannel !== undefined && !!row.alsoSentToChannel !== where.alsoSentToChannel) return false
  if (Array.isArray(where.OR) && !where.OR.some((clause: any) => matches(row, clause))) {
    return false
  }
  return true
}

const prisma: any = {
  conversationMessage: {
    findMany: async ({ where, orderBy, take }: any) => {
      let out = rows.filter((row) => matches(row, where))
      if (orderBy?.seq === 'asc') out = [...out].sort((a, b) => a.seq - b.seq)
      if (orderBy?.seq === 'desc') out = [...out].sort((a, b) => b.seq - a.seq)
      return take ? out.slice(0, take) : out
    },
    findUnique: async ({ where }: any) => rows.find((row) => row.id === where.id) ?? null,
  },
}

mock.module('../lib/prisma', () => ({ prisma }))
mock.module('../lib/conversation-bus', () => ({ publishConversationEvent: () => {} }))

const { listMessagesUnchecked } = await import('../services/conversation.service')

const CHANNEL = 'c1'

function message(over: Partial<Row> & { id: string; seq: number }): Row {
  return {
    conversationId: CHANNEL,
    workspaceId: 'w1',
    threadRootId: null,
    alsoSentToChannel: false,
    authorType: 'user',
    authorUserId: 'u1',
    text: 'hello',
    blocks: null,
    reactions: [],
    attachments: [],
    replyCount: 0,
    createdAt: '2026-10-30T09:00:00.000Z',
    updatedAt: '2026-10-30T09:00:00.000Z',
    ...over,
  }
}

beforeEach(() => {
  rows.length = 0
})

describe('listMessagesUnchecked — changedSince', () => {
  test('returns only the top-level rows whose updatedAt moved, oldest seq first', async () => {
    rows.push(
      message({ id: 'old', seq: 1 }),
      message({ id: 'edited', seq: 2, text: 'edited', updatedAt: '2026-10-30T09:30:00.000Z' }),
      message({ id: 'deleted', seq: 3, deletedAt: '2026-10-30T09:31:00.000Z', updatedAt: '2026-10-30T09:31:00.000Z' }),
    )
    const result = await listMessagesUnchecked(CHANNEL, {
      changedSince: new Date('2026-10-30T09:10:00.000Z'),
    })
    expect(result.messages.map((m: any) => m.id)).toEqual(['edited', 'deleted'])
    expect(result.cursor).toBe('2026-10-30T09:31:00.000Z')
  })

  test('a reaction that bumped the parent row comes through as a changed row', async () => {
    rows.push(
      message({ id: 'reacted', seq: 1, updatedAt: '2026-10-30T09:45:00.000Z', reactions: [{ emoji: '👍', userId: 'u2' }] }),
    )
    const result = await listMessagesUnchecked(CHANNEL, {
      changedSince: new Date('2026-10-30T09:40:00.000Z'),
    })
    expect(result.messages.map((m: any) => m.id)).toEqual(['reacted'])
    expect(result.messages[0].reactions).toEqual([{ emoji: '👍', count: 1, userIds: ['u2'] }])
  })

  test('thread replies outside the thread root are not returned', async () => {
    rows.push(
      message({ id: 'reply', seq: 2, threadRootId: 'root', updatedAt: '2026-10-30T09:45:00.000Z' }),
      message({ id: 'root', seq: 1, updatedAt: '2026-10-30T09:45:00.000Z' }),
    )
    const result = await listMessagesUnchecked(CHANNEL, {
      changedSince: new Date('2026-10-30T09:40:00.000Z'),
    })
    expect(result.messages.map((m: any) => m.id)).toEqual(['root'])
  })

  test('a thread pane asks for its own replies', async () => {
    rows.push(
      message({ id: 'root', seq: 1 }),
      message({ id: 'r1', seq: 2, threadRootId: 'root', updatedAt: '2026-10-30T09:00:00.000Z' }),
      message({ id: 'r2', seq: 3, threadRootId: 'root', text: 'fixed', updatedAt: '2026-10-30T09:50:00.000Z' }),
    )
    const result = await listMessagesUnchecked(CHANNEL, {
      threadRootId: 'root',
      changedSince: new Date('2026-10-30T09:40:00.000Z'),
    })
    expect(result.root?.id).toBe('root')
    expect(result.messages.map((m: any) => m.id)).toEqual(['r2'])
    expect(result.cursor).toBe('2026-10-30T09:50:00.000Z')
  })

  test('nothing changed: no rows and the cursor is the caller’s own floor', async () => {
    rows.push(message({ id: 'a', seq: 1 }))
    const since = new Date('2026-10-30T10:00:00.000Z')
    const result = await listMessagesUnchecked(CHANNEL, { changedSince: since })
    expect(result.messages).toEqual([])
    expect(result.cursor).toBe(since.toISOString())
  })
})

/**
 * QA round 1 (SHO-260): a device that just downloaded a plain page had no
 * cursor to ask a delta with, so every reopen re-downloaded the newest page.
 * A plain page now carries the newest `updatedAt` it knows about.
 */
describe('listMessagesUnchecked — plain pages seed a cursor', () => {
  test('the newest page is enough to start a delta', async () => {
    rows.push(
      message({ id: 'a', seq: 1, updatedAt: '2026-10-30T09:00:00.000Z' }),
      message({ id: 'b', seq: 2, updatedAt: '2026-10-30T09:05:00.000Z' }),
    )
    const result = await listMessagesUnchecked(CHANNEL, { limit: 50 })
    expect(result.messages.map((m: any) => m.id)).toEqual(['a', 'b'])
    expect(result.cursor).toBe('2026-10-30T09:05:00.000Z')
    // …and the cursor it hands back actually works as a delta floor. The floor
    // is inclusive, so the newest row comes back once — harmless, the client
    // merges by id — and the client sends `cursor − 5 s` anyway.
    rows.push(message({ id: 'c', seq: 3, updatedAt: '2026-10-30T09:09:00.000Z' }))
    const delta = await listMessagesUnchecked(CHANNEL, {
      changedSince: new Date(result.cursor!),
    })
    expect(delta.messages.map((m: any) => m.id)).toEqual(['b', 'c'])
  })

  test('the cursor is the newest row even when `updatedAt` order differs from seq order', async () => {
    rows.push(
      message({ id: 'newer-seq', seq: 9, updatedAt: '2026-10-30T09:01:00.000Z' }),
      message({ id: 'older-seq', seq: 8, updatedAt: '2026-10-30T09:07:00.000Z' }),
    )
    const result = await listMessagesUnchecked(CHANNEL, { limit: 50 })
    expect(result.cursor).toBe('2026-10-30T09:07:00.000Z')
  })

  test('a thread pane seeds its cursor from its own replies', async () => {
    rows.push(
      message({ id: 'root', seq: 1, updatedAt: '2026-10-30T09:00:00.000Z' }),
      message({ id: 'r1', seq: 2, threadRootId: 'root', updatedAt: '2026-10-30T09:04:00.000Z' }),
    )
    const result = await listMessagesUnchecked(CHANNEL, { threadRootId: 'root' })
    expect(result.cursor).toBe('2026-10-30T09:04:00.000Z')
  })

  test('an empty conversation returns no cursor rather than a bogus one', async () => {
    const result = await listMessagesUnchecked(CHANNEL, { limit: 50 })
    expect(result.messages).toEqual([])
    expect(result.cursor).toBeUndefined()
  })

  test('every row carries updatedAt so the client can seed from the rows too', async () => {
    rows.push(message({ id: 'a', seq: 1, updatedAt: '2026-10-30T09:00:00.000Z' }))
    const result = await listMessagesUnchecked(CHANNEL, { limit: 50 })
    expect(result.messages[0].updatedAt).toBe('2026-10-30T09:00:00.000Z')
  })
})
