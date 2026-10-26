// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Platform } from 'react-native'
import {
  homePathForWorkspaceKind,
  adoptChatWorkspace,
  openInWorkspace,
  reloadAfterWorkspaceSwitch,
  scheduleWorkspaceSwitch,
  shouldAdoptChatWorkspace,
  subscribeWorkspaceSwitched,
} from '../switch-workspace'
import { clearActiveWorkspaceId, getActiveWorkspaceId, setActiveWorkspaceId } from '../workspace-store'

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

describe('homePathForWorkspaceKind', () => {
  test('lands on the workspace agent landing', () => {
    expect(homePathForWorkspaceKind()).toBe('/(app)')
  })
})

describe('reloadAfterWorkspaceSwitch', () => {
  const originalOS = Platform.OS

  afterEach(() => {
    ;(Platform as { OS: string }).OS = originalOS
  })

  test('notifies native listeners so the shell can reset', () => {
    ;(Platform as { OS: string }).OS = 'ios'
    let calls = 0
    const unsubscribe = subscribeWorkspaceSwitched(() => {
      calls += 1
    })
    reloadAfterWorkspaceSwitch()
    expect(calls).toBe(1)
    unsubscribe()
    reloadAfterWorkspaceSwitch()
    expect(calls).toBe(1)
  })
})

describe('adoptChatWorkspace', () => {
  test('switches to the workspace that owns the chat and reloads projects', () => {
    let cleared = 0
    const loaded: string[] = []
    const projects = {
      clear: () => {
        cleared += 1
      },
      loadAll: async ({ workspaceId }: { workspaceId: string }) => {
        loaded.push(workspaceId)
      },
    }

    expect(adoptChatWorkspace('ws-team', 'ws-personal', projects)).toBe(true)
    expect(getActiveWorkspaceId()).toBe('ws-team')
    expect(cleared).toBe(1)
    expect(loaded).toEqual(['ws-team'])
  })

  test('leaves the workspace alone when the chat is already in it', () => {
    let cleared = 0
    const projects = {
      clear: () => {
        cleared += 1
      },
      loadAll: async () => {},
    }

    expect(adoptChatWorkspace('ws-personal', 'ws-personal', projects)).toBe(false)
    expect(adoptChatWorkspace(undefined, 'ws-personal', projects)).toBe(false)
    expect(getActiveWorkspaceId()).toBeNull()
    expect(cleared).toBe(0)
  })

  /**
   * SHO-157: Russell's staging trace. The switcher applied NEW, and ~10 ms
   * later this screen re-ran its load, found the chat it still had open
   * belonged to OLD (cached meta → microtask) and adopted OLD back. The reload
   * that followed then booted into OLD. The chat's workspace must not be
   * allowed to undo a switch the person just made.
   */
  test('does not adopt the old workspace back over a switch the person just made', async () => {
    const projects = {
      clear: () => {},
      loadAll: async () => {},
    }
    setActiveWorkspaceId('ws-old')
    scheduleWorkspaceSwitch('ws-new', projects)
    await flushSwitch()

    expect(getActiveWorkspaceId()).toBe('ws-new')
    expect(adoptChatWorkspace('ws-old', 'ws-new', projects)).toBe(false)
    expect(getActiveWorkspaceId()).toBe('ws-new')
  })

  test('still adopts a chip’s workspace when no switch is in flight', () => {
    const projects = {
      clear: () => {},
      loadAll: async () => {},
    }
    expect(adoptChatWorkspace('ws-team', 'ws-personal', projects)).toBe(true)
    expect(getActiveWorkspaceId()).toBe('ws-team')
  })

  test('a chip for the workspace the person just switched to still wins', async () => {
    const projects = {
      clear: () => {},
      loadAll: async () => {},
    }
    setActiveWorkspaceId('ws-old')
    scheduleWorkspaceSwitch('ws-new', projects)
    await flushSwitch()

    // The chip's chat lives in the workspace already picked — nothing to adopt.
    expect(adoptChatWorkspace('ws-new', 'ws-old', projects)).toBe(true)
    expect(getActiveWorkspaceId()).toBe('ws-new')
  })
})

describe('shouldAdoptChatWorkspace', () => {
  const base = {
    initialSessionId: 'chat-1',
    adoptedSessionId: null,
    screenWorkspaceId: 'ws-a',
    workspaceId: 'ws-a',
  }

  test('adopts on the first load of a session id', () => {
    expect(shouldAdoptChatWorkspace(base)).toBe(true)
  })

  test('adopts a different session id in the same workspace (a second chip)', () => {
    expect(
      shouldAdoptChatWorkspace({ ...base, adoptedSessionId: 'chat-0' }),
    ).toBe(true)
  })

  test('does not adopt the session it already adopted', () => {
    expect(
      shouldAdoptChatWorkspace({ ...base, adoptedSessionId: 'chat-1' }),
    ).toBe(false)
  })

  test('does not adopt after the workspace changed under the screen', () => {
    expect(
      shouldAdoptChatWorkspace({ ...base, workspaceId: 'ws-b' }),
    ).toBe(false)
  })

  test('adopts before the screen has loaded a workspace, once one arrives', () => {
    expect(
      shouldAdoptChatWorkspace({ ...base, screenWorkspaceId: null }),
    ).toBe(true)
  })

  test('does nothing without a session id or a workspace', () => {
    expect(shouldAdoptChatWorkspace({ ...base, initialSessionId: null })).toBe(false)
    expect(shouldAdoptChatWorkspace({ ...base, workspaceId: undefined })).toBe(false)
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
