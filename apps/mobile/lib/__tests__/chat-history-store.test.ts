// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Device-held chat history (SHO-260). The backend is swapped for the in-memory
 * one so the behaviour that matters — key scoping, the message cap, LRU
 * eviction and sign-out clearing — is testable without a browser.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  chatHistoryKey,
  chatHistoryLimits,
  clearChatHistory,
  conversationHistoryKey,
  chatSessionHistoryKey,
  deltaSince,
  newestUpdatedAt,
  peekChatHistory,
  readChatHistory,
  removeChatHistory,
  setChatHistoryBackend,
  writeChatHistory,
} from '../chat-history-store'

let seq = 0
const message = (text = 'hi') => ({ id: `m${++seq}`, text, createdAt: Date.now() })

const entry = (messages: any[], extra: Partial<{ cursor: string; total: number }> = {}) => ({
  messages,
  cursor: extra.cursor ?? null,
  total: extra.total ?? messages.length,
  hasMoreOlder: false,
  savedAt: Date.now(),
})

afterEach(async () => {
  await clearChatHistory()
  setChatHistoryBackend(null)
})

describe('chat history store', () => {
  test('a saved slice round-trips and is mirrored for synchronous reads', async () => {
    const key = chatHistoryKey('u1', 'https://cloud', chatSessionHistoryKey('s1'))
    expect(key).toBe('u1:https://cloud:s1')

    await writeChatHistory('project', key, entry([message('a'), message('b')], { cursor: '2026-10-30T10:00:00.000Z' }))

    const read = await readChatHistory('project', key)
    expect(read?.messages).toHaveLength(2)
    expect(read?.cursor).toBe('2026-10-30T10:00:00.000Z')
    expect(peekChatHistory('project', key)?.messages).toHaveLength(2)
  })

  test('the same chat on another origin, or for another user, is a different entry', async () => {
    const cloud = chatHistoryKey('u1', 'https://cloud', 's1')
    const machine = chatHistoryKey('u1', 'machine-7', 's1')
    const otherUser = chatHistoryKey('u2', 'https://cloud', 's1')

    await writeChatHistory('project', cloud, entry([message('cloud')]))
    await writeChatHistory('project', machine, entry([message('machine')]))
    await writeChatHistory('project', otherUser, entry([message('someone')]))

    expect((await readChatHistory('project', cloud))?.messages[0].text).toBe('cloud')
    expect((await readChatHistory('project', machine))?.messages[0].text).toBe('machine')
    expect((await readChatHistory('project', otherUser))?.messages[0].text).toBe('someone')
  })

  test('only the newest N messages are kept', async () => {
    const key = chatHistoryKey('u1', 'origin', 's1')
    const messages = Array.from({ length: chatHistoryLimits().messages + 25 }, () => message())
    await writeChatHistory('project', key, entry(messages))

    const read = await readChatHistory('project', key)
    expect(read?.messages).toHaveLength(chatHistoryLimits().messages)
    expect(read?.messages[read.messages.length - 1]).toEqual(messages[messages.length - 1])
    expect(read?.hasMoreOlder).toBe(true)
  })

  test('an empty transcript is never stored', async () => {
    const key = chatHistoryKey('u1', 'origin', 's1')
    await writeChatHistory('project', key, entry([]))
    expect(await readChatHistory('project', key)).toBeNull()
  })

  test('the least recently saved chats are evicted once the cap is reached', async () => {
    const limits = chatHistoryLimits()
    for (let i = 0; i < limits.chats + 5; i += 1) {
      await writeChatHistory('project', chatHistoryKey('u1', 'origin', `s${i}`), {
        ...entry([message(`s${i}`)]),
        savedAt: i,
      })
      // Newest last, so the first ones written are the ones to drop.
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    const survivors = await Promise.all(
      Array.from({ length: limits.chats + 5 }, (_, i) =>
        readChatHistory('project', chatHistoryKey('u1', 'origin', `s${i}`)),
      ),
    )
    const kept = survivors.filter(Boolean).length
    expect(kept).toBeLessThanOrEqual(limits.chats)
    // The newest is always kept; the oldest went first.
    expect(survivors[survivors.length - 1]).not.toBeNull()
    expect(survivors[0]).toBeNull()
  })

  test('one chat can be dropped without touching the others', async () => {
    const keep = chatHistoryKey('u1', 'origin', 'keep')
    const drop = chatHistoryKey('u1', 'origin', 'drop')
    await writeChatHistory('project', keep, entry([message()]))
    await writeChatHistory('team', drop, entry([message()]))

    await removeChatHistory('team', drop)

    expect(await readChatHistory('team', drop)).toBeNull()
    expect(await readChatHistory('project', keep)).not.toBeNull()
  })

  test('sign-out clears both kinds', async () => {
    await writeChatHistory('project', chatHistoryKey('u1', 'origin', 's1'), entry([message()]))
    await writeChatHistory('team', chatHistoryKey('u1', 'origin', 'c1'), entry([message()]))

    await clearChatHistory()

    expect(await readChatHistory('project', chatHistoryKey('u1', 'origin', 's1'))).toBeNull()
    expect(await readChatHistory('team', chatHistoryKey('u1', 'origin', 'c1'))).toBeNull()
  })

  test('a thread is cached apart from its channel', () => {
    expect(conversationHistoryKey('c1')).toBe('c1')
    expect(conversationHistoryKey('c1', 'r1')).toBe('c1:r1')
  })

  test('the delta cursor is sent five seconds early so clock skew cannot hide a change', () => {
    expect(deltaSince(null)).toBeNull()
    expect(deltaSince('nonsense')).toBeNull()
    expect(deltaSince('2026-10-30T10:00:10.000Z')).toBe('2026-10-30T10:00:05.000Z')
  })

  // QA round 1 (SHO-260): a page that arrives without a cursor still has to
  // leave the device able to ask for a delta, or every reopen re-downloads.
  test('a page with no server cursor seeds one from its own rows', () => {
    expect(
      newestUpdatedAt([
        { updatedAt: '2026-10-30T10:00:00.000Z', createdAt: '2026-10-30T09:00:00.000Z' },
        { updatedAt: '2026-10-30T10:04:00.000Z', createdAt: '2026-10-30T09:05:00.000Z' },
      ]),
    ).toBe('2026-10-30T10:04:00.000Z')
  })

  test('rows without updatedAt fall back to createdAt, and an empty page seeds nothing', () => {
    expect(newestUpdatedAt([{ createdAt: '2026-10-30T11:00:00.000Z' }])).toBe(
      '2026-10-30T11:00:00.000Z',
    )
    expect(newestUpdatedAt([])).toBeNull()
    expect(newestUpdatedAt(undefined)).toBeNull()
  })
})
