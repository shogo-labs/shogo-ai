// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `lib/storage.ts` — the AsyncStorage write barrier (SHO-566 / SHOGO-IOS-16).
 *
 * The native crash is `-[NSNull length]` inside `RNCAsyncStorage _writeEntry`:
 * a `null`/`undefined` value crossed the bridge as `NSNull`. No JS `try`/`catch`
 * can catch that, so the guard has to be that nothing non-string is written.
 * These tests assert exactly that: every value that reaches `setItem` is a
 * string, and clearing a preference removes the key instead.
 *
 * The cache modules below the helper are exercised too — their `writeLater`
 * path is debounced and typed `unknown`, which is where a `JSON.stringify`
 * miss would otherwise become a native crash.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'

const store = new Map<string, string>()
/** Every value the real modules handed to `setItem`, in order. */
const written: { key: string; value: unknown }[] = []

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: unknown) => {
      written.push({ key: k, value: v })
      if (typeof v !== 'string') throw new Error(`non-string value for ${k}: ${typeof v}`)
      store.set(k, v as string)
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

let storage: typeof import('../storage')
let teamChat: typeof import('../team-chat-cache')
let workspaceChats: typeof import('../workspace-chats-cache')

// `workspace-chats-cache` pulls the API surface, which builds a better-auth
// client at module load and tries to reach the API origin. Only the cache's
// fetch answer is needed here.
mock.module(resolve(import.meta.dir, '../api'), () => ({
  api: { listWorkspaceSessions: mock(async () => []) },
}))

beforeAll(async () => {
  storage = await import('../storage')
  teamChat = await import('../team-chat-cache')
  workspaceChats = await import('../workspace-chats-cache')
})

beforeEach(() => {
  written.length = 0
})

afterEach(async () => {
  await teamChat.clearTeamChatCache()
  await workspaceChats.clearWorkspaceChatsCache()
  store.clear()
})

const nonString = () => written.filter((w) => typeof w.value !== 'string')

describe('setStorageItem — a non-string never reaches native', () => {
  test('writes a string', async () => {
    await storage.setStorageItem('shogo:test:a', 'value')
    expect(store.get('shogo:test:a')).toBe('value')
    expect(nonString()).toEqual([])
  })

  test('null / undefined remove the key instead of being written', async () => {
    await storage.setStorageItem('shogo:test:b', 'first')
    // The type is `string`; a value whose static type lied is still handled.
    await storage.setStorageItem('shogo:test:b', undefined as unknown as string)
    expect(store.has('shogo:test:b')).toBe(false)
    await storage.setStorageItem('shogo:test:c', 'second')
    await storage.setStorageItem('shogo:test:c', null as unknown as string)
    expect(store.has('shogo:test:c')).toBe(false)
    expect(nonString()).toEqual([])
  })

  test('a number / object / function is never written either', async () => {
    for (const bad of [42, {}, [], () => undefined, Symbol('x'), 10n]) {
      await storage.setStorageItem('shogo:test:bad', bad as unknown as string)
      expect(store.has('shogo:test:bad')).toBe(false)
    }
    expect(nonString()).toEqual([])
  })
})

describe('setStorageJson — stringify can return undefined', () => {
  test('stores JSON for a serializable value', async () => {
    await storage.setStorageJson('shogo:test:json', { a: 1 })
    expect(store.get('shogo:test:json')).toBe('{"a":1}')
  })

  test('undefined (JSON.stringify → undefined) removes the key', async () => {
    await storage.setStorageJson('shogo:test:json', 'first')
    await storage.setStorageJson('shogo:test:json', undefined)
    expect(store.has('shogo:test:json')).toBe(false)
    expect(nonString()).toEqual([])
  })

  test('a value JSON cannot serialize (cycle, BigInt) removes the key', async () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    await storage.setStorageJson('shogo:test:cycle', cycle)
    expect(store.has('shogo:test:cycle')).toBe(false)
    await storage.setStorageJson('shogo:test:big', { n: 1n })
    expect(store.has('shogo:test:big')).toBe(false)
    expect(nonString()).toEqual([])
  })
})

describe('the device caches write only strings', () => {
  const msg = (seq: number) => ({ id: `m${seq}`, seq }) as never
  const flush = () => new Promise((r) => setTimeout(r, 1_100))

  test('a team-chat timeline and its index', async () => {
    teamChat.cacheTimeline('user-1', 'conv-1', [msg(1), msg(2)], false)
    await flush()
    expect(written.length).toBeGreaterThan(0)
    expect(nonString()).toEqual([])
  })

  test('a workspace-chats list and its index', async () => {
    workspaceChats.writeWorkspaceChats('user-1:local:ws-1', [{ id: 'chat-1' }])
    await flush()
    expect(written.length).toBeGreaterThan(0)
    expect(nonString()).toEqual([])
  })
})
