// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PERF-7, SHO-285: `hostedWorkspaceIds()` is called on every tick of several background
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

const { hostedWorkspaceIds, notHostedWorkspaceWhere, invalidateHostedWorkspaceIds } =
  await import('../hosted-workspace')

beforeEach(() => {
  invalidateHostedWorkspaceIds()
  state.reads = 0
  state.ids = ['ws-a']
  state.delay = 0
})

describe('hostedWorkspaceIds cache', () => {
  test('repeated calls inside the TTL read the database once', async () => {
    expect(await hostedWorkspaceIds()).toEqual(['ws-a'])
    expect(await hostedWorkspaceIds()).toEqual(['ws-a'])
    expect(await notHostedWorkspaceWhere()).toEqual({ workspaceId: { notIn: ['ws-a'] } })
    expect(state.reads).toBe(1)
  })

  test('concurrent callers share one in-flight read', async () => {
    state.delay = 10
    const results = await Promise.all([hostedWorkspaceIds(), hostedWorkspaceIds(), notHostedWorkspaceWhere()])
    expect(results[0]).toEqual(['ws-a'])
    expect(results[1]).toEqual(['ws-a'])
    expect(state.reads).toBe(1)
  })

  test('invalidate makes the next call see a newly hosted workspace', async () => {
    await hostedWorkspaceIds()
    state.ids = ['ws-a', 'ws-b']
    expect(await hostedWorkspaceIds()).toEqual(['ws-a'])
    invalidateHostedWorkspaceIds()
    expect(await hostedWorkspaceIds()).toEqual(['ws-a', 'ws-b'])
    expect(state.reads).toBe(2)
  })

  test('a read started before an invalidate does not repopulate the cache', async () => {
    state.delay = 10
    const stale = hostedWorkspaceIds()
    state.ids = ['ws-a', 'ws-b']
    invalidateHostedWorkspaceIds()
    await stale
    state.delay = 0
    expect(await hostedWorkspaceIds()).toEqual(['ws-a', 'ws-b'])
    expect(state.reads).toBe(2)
  })

  test('no hosted workspace leaves the where untouched', async () => {
    state.ids = []
    expect(await notHostedWorkspaceWhere()).toEqual({})
  })
})

describe('hosted workspace guards (SHO-285)', () => {
  test('one where-clause keeps cloud workers off hosted workspaces', async () => {
    const { CLOUD_COMPUTE_ONLY, withCloudCompute, isHostedWorkspace } = await import('../hosted-workspace')
    expect(CLOUD_COMPUTE_ONLY).toEqual({ hostInstanceId: null })
    expect(withCloudCompute({ kind: 'team' })).toEqual({ kind: 'team', hostInstanceId: null })
    expect(isHostedWorkspace({ hostInstanceId: 'inst-1' })).toBe(true)
    expect(isHostedWorkspace({ hostInstanceId: null })).toBe(false)
    expect(isHostedWorkspace(null)).toBe(false)
  })

  test('a session is excluded through its own workspace or its project', async () => {
    const { hostedSessionExclusion } = await import('../hosted-workspace')
    expect(hostedSessionExclusion([])).toEqual({})
    expect(hostedSessionExclusion(['ws-a'])).toEqual({
      AND: [
        { OR: [{ workspaceId: null }, { workspaceId: { notIn: ['ws-a'] } }] },
        { OR: [{ contextType: { not: 'project' } }, { project: { workspaceId: { notIn: ['ws-a'] } } }] },
      ],
    })
  })
})
