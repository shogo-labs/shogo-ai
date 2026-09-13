// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, test } from 'bun:test'
import { scheduleWorkspaceSwitch } from '../switch-workspace'
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
