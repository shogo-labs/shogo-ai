// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `team-chat-cache.ts`: per-user keys, newest-N messages, LRU eviction of
 * conversations, and clearing on sign-out.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { ChatMessage } from '../team-chat-api'

const store = new Map<string, string>()
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: async (k: string) => {
      store.delete(k)
    },
    getAllKeys: async () => [...store.keys()],
    multiRemove: async (keys: string[]) => {
      keys.forEach((k) => store.delete(k))
    },
  },
}))

let cache: typeof import('../team-chat-cache')
beforeAll(async () => {
  cache = await import('../team-chat-cache')
})

afterEach(async () => {
  await cache.clearTeamChatCache()
  store.clear()
})

const msg = (seq: number, pending?: 'sending' | 'failed') => ({ id: `m${seq}`, seq, pending } as unknown as ChatMessage)
const flush = () => new Promise((r) => setTimeout(r, 1_100))

describe('team chat cache', () => {
  test('keeps only the newest confirmed messages, scoped to the user', async () => {
    const messages = [...Array.from({ length: 70 }, (_, i) => msg(i + 1)), msg(999, 'failed')]
    cache.cacheTimeline('u1', 'c1', messages, false)
    await flush()
    const cached = await cache.readCachedTimeline('u1', 'c1')
    expect(cached!.messages).toHaveLength(cache.CACHED_MESSAGES_PER_CONVERSATION)
    expect(cached!.messages[0]!.seq).toBe(21)
    expect(cached!.messages.some((m) => m.pending)).toBe(false)
    expect(cached!.hasMoreOlder).toBe(true)
    expect(await cache.readCachedTimeline('u2', 'c1')).toBeNull()
  })

  test('evicts the least recently opened conversations', async () => {
    for (let i = 0; i < cache.MAX_CACHED_CONVERSATIONS + 2; i++) cache.cacheTimeline('u1', `c${i}`, [msg(1)], false)
    await flush()
    expect(await cache.readCachedTimeline('u1', 'c0')).toBeNull()
    expect(await cache.readCachedTimeline('u1', 'c1')).toBeNull()
    expect(await cache.readCachedTimeline('u1', `c${cache.MAX_CACHED_CONVERSATIONS + 1}`)).not.toBeNull()
  })

  test('lists round-trip and sign-out clears everything', async () => {
    cache.cacheList('u1', 'w1', [{ id: 'c1' } as any])
    await flush()
    expect((await cache.readCachedList('u1', 'w1'))?.map((c) => c.id)).toEqual(['c1'])
    store.set('unrelated', 'keep')
    await cache.clearTeamChatCache()
    expect(await cache.readCachedList('u1', 'w1')).toBeNull()
    expect(store.get('unrelated')).toBe('keep')
  })
})
