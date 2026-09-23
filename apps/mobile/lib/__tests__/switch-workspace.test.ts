// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Platform } from 'react-native'
import { openInWorkspace, scheduleWorkspaceSwitch } from '../switch-workspace'
import { clearActiveWorkspaceId, getActiveWorkspaceId } from '../workspace-store'

afterEach(() => {
  clearActiveWorkspaceId()
})

function flushSwitch(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('scheduleWorkspaceSwitch', () => {
  test('does not clear projects on the same tick as the tap', async () => {
    let cleared = 0
    let loaded: string | null = null
    const projects = {
      clear: () => {
        cleared += 1
      },
      loadAll: async ({ workspaceId }: { workspaceId: string }) => {
        loaded = workspaceId
      },
    }

    scheduleWorkspaceSwitch('ws-2', projects)
    expect(cleared).toBe(0)
    expect(getActiveWorkspaceId()).not.toBe('ws-2')

    await flushSwitch()
    await Promise.resolve()

    expect(cleared).toBe(1)
    expect(loaded).toBe('ws-2')
    expect(getActiveWorkspaceId()).toBe('ws-2')
  })

  test('coalesces rapid switches onto the last workspace', async () => {
    const loaded: string[] = []
    const projects = {
      clear: () => {},
      loadAll: async ({ workspaceId }: { workspaceId: string }) => {
        loaded.push(workspaceId)
      },
    }

    scheduleWorkspaceSwitch('ws-1', projects)
    scheduleWorkspaceSwitch('ws-2', projects)
    await flushSwitch()
    await Promise.resolve()

    expect(loaded).toEqual(['ws-2'])
    expect(getActiveWorkspaceId()).toBe('ws-2')
  })
})

describe('openInWorkspace', () => {
  function fakeRouter() {
    const calls = { push: [] as string[], replace: [] as string[] }
    return {
      calls,
      router: {
        push: (href: string) => calls.push.push(href),
        replace: (href: string) => calls.replace.push(href),
      },
    }
  }

  test('pushes without switching when the target is the current workspace', () => {
    const { calls, router } = fakeRouter()
    openInWorkspace(router, 'ws-1', '/(app)/marketplace', 'ws-1')
    expect(calls.push).toEqual(['/(app)/marketplace'])
    expect(getActiveWorkspaceId()).toBeNull()
  })

  test('pushes without switching when no target workspace is known', () => {
    const { calls, router } = fakeRouter()
    openInWorkspace(router, undefined, '/(app)/settings?tab=people', 'ws-1')
    expect(calls.push).toEqual(['/(app)/settings?tab=people'])
  })

  test('makes the target workspace active before navigating across workspaces', () => {
    const { calls, router } = fakeRouter()
    openInWorkspace(router, 'ws-team', '/', 'ws-personal')
    expect(getActiveWorkspaceId()).toBe('ws-team')
    expect(calls.push).toEqual([])
  })

  test('cancels a queued switch so it cannot override the target workspace', async () => {
    const { router } = fakeRouter()
    const loaded: string[] = []
    scheduleWorkspaceSwitch('ws-other', {
      clear: () => {},
      loadAll: async ({ workspaceId }) => {
        loaded.push(workspaceId)
      },
    })
    openInWorkspace(router, 'ws-team', '/', 'ws-personal')
    await flushSwitch()
    expect(getActiveWorkspaceId()).toBe('ws-team')
    expect(loaded).toEqual([])
  })

  describe('on native', () => {
    const originalOS = Platform.OS
    beforeEach(() => {
      ;(Platform as { OS: string }).OS = 'ios'
    })
    afterEach(() => {
      ;(Platform as { OS: string }).OS = originalOS
    })

    test('pushes the target (keeps the back stack) and reloads projects for the new workspace', async () => {
      const { calls, router } = fakeRouter()
      let cleared = 0
      const loaded: string[] = []
      openInWorkspace(router, 'ws-team', '/(app)/marketplace', 'ws-personal', {
        clear: () => {
          cleared += 1
        },
        loadAll: async ({ workspaceId }) => {
          loaded.push(workspaceId)
        },
      })
      expect(getActiveWorkspaceId()).toBe('ws-team')
      expect(calls.push).toEqual(['/(app)/marketplace'])
      expect(calls.replace).toEqual([])
      expect(cleared).toBe(1)
      expect(loaded).toEqual(['ws-team'])
    })

    test('still navigates when no projects collection is passed', () => {
      const { calls, router } = fakeRouter()
      openInWorkspace(router, 'ws-team', '/', 'ws-personal')
      expect(getActiveWorkspaceId()).toBe('ws-team')
      expect(calls.push).toEqual(['/'])
    })
  })
})
