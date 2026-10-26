// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Opening a project from Activity passes `chatSessionId` before the saved
 * tab list comes back from storage. The restore used to replace the open
 * tabs, so the deep-linked session had no ChatPanel and the chat was blank.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

const store = new Map<string, string>()
const getItemCalls: string[] = []

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
      getItemCalls.push(key)
      return store.get(key) ?? null
    },
    setItem: async (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: async (key: string) => {
      store.delete(key)
    },
  },
}))

let useProjectChatTabs: typeof import('../project-chat-tabs').useProjectChatTabs

beforeAll(async () => {
  ;({ useProjectChatTabs } = await import('../project-chat-tabs'))
})

afterEach(() => {
  cleanup()
  store.clear()
  getItemCalls.length = 0
})

function renderTabs(
  overrides: Partial<Parameters<typeof useProjectChatTabs>[0]> = {},
) {
  return renderHook(() =>
    useProjectChatTabs({
      projectId: 'p1',
      chatSessionId: 'activity-session',
      skipRestore: false,
      nativePhone: false,
      ...overrides,
    }),
  )
}

describe('useProjectChatTabs', () => {
  test('keeps a deep-linked chat when the saved tab list restores', async () => {
    store.set('shogo:chatTabs:p1', JSON.stringify(['pinned']))
    const { result } = renderTabs()

    await waitFor(() => {
      expect(result.current.tabsHydration).toBe('restored-with-tabs')
    })

    expect(result.current.openChatTabIds).toEqual(['pinned', 'activity-session'])
  })

  test('puts the active session back if the tab list is replaced', async () => {
    const { result } = renderTabs({ skipRestore: true })

    await waitFor(() => {
      expect(result.current.openChatTabIds).toEqual(['activity-session'])
    })

    act(() => {
      result.current.setOpenChatTabIds(['pinned'])
    })

    expect(result.current.openChatTabIds).toEqual(['pinned', 'activity-session'])
  })

  test('treats a missing storage key as a fresh visit with the active session', async () => {
    const { result } = renderTabs()

    await waitFor(() => {
      expect(result.current.tabsHydration).toBe('fresh')
    })

    expect(result.current.openChatTabIds).toEqual(['activity-session'])
  })

  test('keeps the active session when storage says every tab was closed', async () => {
    store.set('shogo:chatTabs:p1', '[]')
    const { result } = renderTabs()

    await waitFor(() => {
      expect(result.current.tabsHydration).toBe('restored-empty')
    })

    expect(result.current.openChatTabIds).toEqual(['activity-session'])
  })

  test('does not read storage when restore is skipped', async () => {
    store.set('shogo:chatTabs:p1', JSON.stringify(['pinned']))
    const { result } = renderTabs({ skipRestore: true })

    await waitFor(() => {
      expect(result.current.tabsHydration).toBe('fresh')
    })

    expect(getItemCalls).toEqual([])
    expect(result.current.openChatTabIds).toEqual(['activity-session'])
  })
})
