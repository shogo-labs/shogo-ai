// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `useAgentActivity` is polled by Home, the Activity feed and the rail badge at
 * the same time. The server answers with a fresh array every 5 s, so unless the
 * hook keeps the previous array when nothing about the tasks changed, every
 * consumer re-renders (and re-derives `running` / `failed`) on every poll, for
 * a workspace where nothing is happening.
 *
 * SHO-220 made the poll workspace-scoped and identity-stable; this holds the
 * second half of that.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

type Task = {
  id: string
  status: string
  updatedAt: string
  workspaceId: string
  title: string
}

let serverTasks: Task[] = []
let listCalls: Array<{ workspaceId?: string }> = []

const realApi = await import('../../lib/api')
const realSharedDomain = await import('@shogo/shared-app/domain')
const realDomain = await import('../../contexts/domain')
const realActiveWorkspace = await import('../useActiveWorkspace')

mock.module('../../lib/api', () => ({
  ...realApi,
  api: {
    ...realApi.api,
    // The shape the route returns: a new array of fresh objects every call.
    listAgentTasks: async (_http: unknown, params?: { workspaceId?: string }) => {
      listCalls.push({ workspaceId: params?.workspaceId })
      return serverTasks.map((task) => ({ ...task }))
    },
    listWorkspaceActiveChats: async () => [],
  },
}))

// The real hook reads a React context from the shared package, whose React
// instance is not the one this suite renders with; the answer it gives here is
// simply "local source".
mock.module('@shogo/shared-app/domain', () => ({
  ...realSharedDomain,
  useIsRemoteSource: () => false,
}))

mock.module('../../contexts/domain', () => ({
  ...realDomain,
  useDomainHttp: () => ({}),
  useNotificationCollection: () => ({ loadAll: async () => {} }),
  useProjectCollection: () => ({ loadAll: async () => {} }),
}))

mock.module('../useActiveWorkspace', () => ({
  ...realActiveWorkspace,
  useActiveWorkspace: () => ({ id: 'ws-1', name: 'Workspace' }),
}))

const { useAgentActivity } = await import('../useAgentActivity')

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 60)))

beforeEach(() => {
  listCalls = []
  serverTasks = [
    { id: 't-1', status: 'running', updatedAt: '2026-10-26T00:00:00.000Z', workspaceId: 'ws-1', title: 'Build it' },
    { id: 't-2', status: 'queued', updatedAt: '2026-10-26T00:00:01.000Z', workspaceId: 'ws-1', title: 'Then test it' },
  ]
})

afterEach(cleanup)

describe('useAgentActivity', () => {
  test('keeps the same tasks reference when the poll returns the same tasks', async () => {
    const { result } = renderHook(() => useAgentActivity({ polling: false, light: true }))
    await settle()
    expect(result.current.tasks.map((t) => t.id)).toEqual(['t-1', 't-2'])
    const first = result.current.tasks
    const firstRunning = result.current.running

    // The server answers again with equal-but-new objects, as it does every poll.
    await act(() => result.current.refresh({ projects: false }))
    await settle()

    expect(listCalls.length).toBeGreaterThanOrEqual(2)
    expect(result.current.tasks).toBe(first)
    // …so the derived lists keep their identity too, and no consumer re-renders.
    expect(result.current.running).toBe(firstRunning)
  })

  test('takes the new array as soon as a task actually changes', async () => {
    const { result } = renderHook(() => useAgentActivity({ polling: false, light: true }))
    await settle()
    const first = result.current.tasks

    serverTasks = [
      { id: 't-1', status: 'completed', updatedAt: '2026-10-26T00:05:00.000Z', workspaceId: 'ws-1', title: 'Build it' },
      { id: 't-2', status: 'queued', updatedAt: '2026-10-26T00:00:01.000Z', workspaceId: 'ws-1', title: 'Then test it' },
    ]
    await act(() => result.current.refresh({ projects: false }))
    await settle()

    expect(result.current.tasks).not.toBe(first)
    expect(result.current.tasks[0].status).toBe('completed')
    // The completed task is no longer "running", so the strip shrinks.
    expect(result.current.running.map((t) => t.id)).toEqual(['t-2'])
  })

  test('asks only for this workspace, so no other workspace is polled', async () => {
    renderHook(() => useAgentActivity({ polling: false, light: true }))
    await settle()
    expect(listCalls.length).toBeGreaterThan(0)
    expect(listCalls.every((call) => call.workspaceId === 'ws-1')).toBe(true)
  })
})
