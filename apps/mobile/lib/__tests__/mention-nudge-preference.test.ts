// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `mention-nudge-preference.ts` — the "Don't show again" store for
 * MentionNudgeCard. Same shape as lib/notifications/__tests__/preferences.test.ts.
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

let mod: typeof import('../mention-nudge-preference')
beforeAll(async () => {
  mod = await import('../mention-nudge-preference')
})

describe('mentionNudgeDismissed store', () => {
  test('default value is false — the nudge shows until dismissed forever', () => {
    expect(mod.getMentionNudgeDismissed()).toBe(false)
  })

  test('dismissMentionNudgeForever() persists and updates the cache', async () => {
    await mod.dismissMentionNudgeForever()
    expect(mod.getMentionNudgeDismissed()).toBe(true)
    expect(store.get('shogo:mention-nudge-dismissed')).toBe('true')
  })
})
