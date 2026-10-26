// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PERF-7: `machineWorkspaceIds()` is called on every tick of several background
 * loops, so it must reuse one read per pod instead of querying each time.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const state = { reads: 0, ids: ['ws-a'] as string[], delay: 0 }

mock.module('../prisma', () => ({
  prisma: {
    workspace: {
      findMany: async () => {
        state.reads++
        if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay))
        return state.ids.map((id) => ({ id }))
      },
    },
  },
}))

const { machineWorkspaceIds, notMachineWorkspaceWhere, invalidateMachineWorkspaceIds } =
  await import('../machine-workspace')

beforeEach(() => {
  invalidateMachineWorkspaceIds()
  state.reads = 0
  state.ids = ['ws-a']
  state.delay = 0
})

describe('machineWorkspaceIds cache', () => {
  test('repeated calls inside the TTL read the database once', async () => {
    expect(await machineWorkspaceIds()).toEqual(['ws-a'])
    expect(await machineWorkspaceIds()).toEqual(['ws-a'])
    expect(await notMachineWorkspaceWhere()).toEqual({ workspaceId: { notIn: ['ws-a'] } })
    expect(state.reads).toBe(1)
  })

  test('concurrent callers share one in-flight read', async () => {
    state.delay = 10
    const results = await Promise.all([machineWorkspaceIds(), machineWorkspaceIds(), notMachineWorkspaceWhere()])
    expect(results[0]).toEqual(['ws-a'])
    expect(results[1]).toEqual(['ws-a'])
    expect(state.reads).toBe(1)
  })

  test('invalidate makes the next call see a newly tagged workspace', async () => {
    await machineWorkspaceIds()
    state.ids = ['ws-a', 'ws-b']
    expect(await machineWorkspaceIds()).toEqual(['ws-a'])
    invalidateMachineWorkspaceIds()
    expect(await machineWorkspaceIds()).toEqual(['ws-a', 'ws-b'])
    expect(state.reads).toBe(2)
  })

  test('a read started before an invalidate does not repopulate the cache', async () => {
    state.delay = 10
    const stale = machineWorkspaceIds()
    state.ids = ['ws-a', 'ws-b']
    invalidateMachineWorkspaceIds()
    await stale
    state.delay = 0
    expect(await machineWorkspaceIds()).toEqual(['ws-a', 'ws-b'])
    expect(state.reads).toBe(2)
  })

  test('no paired machine leaves the where untouched', async () => {
    state.ids = []
    expect(await notMachineWorkspaceWhere()).toEqual({})
  })
})
