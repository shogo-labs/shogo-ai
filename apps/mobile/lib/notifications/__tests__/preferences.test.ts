// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `preferences.ts` — covers the pure (non-hook) store interface:
 * `getNotifyOnTurnComplete()` and `setNotifyOnTurnComplete()`.
 *
 * The `useNotifyOnTurnComplete()` hook is exercised separately in
 * `useNotifyOnTurnComplete.test.ts` with the full RTL stack.
 */

import { describe, test, expect, beforeAll, mock } from 'bun:test'

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
  },
}))

let mod: typeof import('../preferences')
beforeAll(async () => {
  mod = await import('../preferences')
})

describe('notifyOnTurnComplete store', () => {
  test('default value is true', () => {
    expect(mod.getNotifyOnTurnComplete()).toBe(true)
  })

  test('setNotifyOnTurnComplete(false) persists and updates the cache', async () => {
    await mod.setNotifyOnTurnComplete(false)
    expect(mod.getNotifyOnTurnComplete()).toBe(false)
    expect(store.get('shogo:notify-on-turn-complete')).toBe('false')
  })

  test('setNotifyOnTurnComplete(true) round-trips', async () => {
    await mod.setNotifyOnTurnComplete(true)
    expect(mod.getNotifyOnTurnComplete()).toBe(true)
    expect(store.get('shogo:notify-on-turn-complete')).toBe('true')
  })
})
