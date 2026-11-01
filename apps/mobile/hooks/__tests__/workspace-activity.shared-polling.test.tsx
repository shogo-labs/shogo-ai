// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-277 — one activity request per workspace per poll, not one per hook.
 *
 * `useAgentActivity` and `useWorkspaceChats` are mounted all over the shell
 * (sidebar, team dock, activity feed, home signals, the phone drawer, side
 * chats). Each instance used to run its own 5 s poll of the same two
 * workspace-wide endpoints, so a machine with several agents running paid for
 * eight identical `active-chats` requests every five seconds — all of it
 * landing on the same synchronous SQLite connection the chat stream writes to.
 *
 * This mounts six consumers of each and counts what reaches the API.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

type Task = { id: string; status: string; updatedAt: string; workspaceId: string; title: string }

let taskCalls = 0
let activeChatCalls = 0

const realApi = await import('../../lib/api')
const realSharedDomain = await import('@shogo/shared-app/domain')
const realDomain = await import('../../contexts/domain')

mock.module('../../lib/api', () => ({
  ...realApi,
  api: {
    ...realApi.api,
    listAgentTasks: async () => {
      taskCalls += 1
      return [{ id: 't1', status: 'running', updatedAt: '2026-10-31T00:00:00Z', workspaceId: 'ws-1', title: 'Working' }] as Task[]
    },
    listWorkspaceActiveChats: async () => {
      activeChatCalls += 1
      return []
    },
  },
}))

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

// `useWorkspaceInView` reaches the shared-app domain React context, which is a
// different React copy from the one this suite renders with.
mock.module('../useWorkspaceInView', () => ({
  useWorkspaceInView: () => ({ id: 'ws-1', name: 'Workspace' }),
  useWorkspaceDataScope: () => ({ everyWorkspace: false }),
}))

const { useAgentActivity } = await import('../useAgentActivity')
const { workspaceActivity } = await import('../../lib/workspace-activity')

const settle = (ms = 80) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

beforeEach(() => {
  taskCalls = 0
  activeChatCalls = 0
  workspaceActivity.reset()
  setVisibility('visible')
})

afterEach(() => {
  cleanup()
  workspaceActivity.reset()
  setVisibility('visible')
})

describe('workspace activity polling is shared', () => {
  test('six mounted activity consumers make one request per endpoint', async () => {
    const consumers = Array.from({ length: 6 }, () => renderHook(() => useAgentActivity({ polling: true })))
    await settle(150)

    expect(consumers).toHaveLength(6)
    expect(taskCalls).toBe(1)
    expect(activeChatCalls).toBe(1)

    // Every consumer still got the answer.
    for (const consumer of consumers) {
      expect(consumer.result.current.running).toHaveLength(1)
    }

    consumers.forEach((consumer) => consumer.unmount())
  })

  test('a second window of callers reuses the answer until the poll interval elapses', async () => {
    const first = renderHook(() => useAgentActivity({ polling: true }))
    await settle()
    expect(taskCalls).toBe(1)

    // A consumer mounting inside the same window joins the cached answer.
    const second = renderHook(() => useAgentActivity({ polling: true }))
    await settle()
    expect(taskCalls).toBe(1)

    first.unmount()
    second.unmount()
  })

  test('nothing is requested while the window is hidden', async () => {
    setVisibility('hidden')
    const consumers = Array.from({ length: 6 }, () => renderHook(() => useAgentActivity({ polling: true })))
    await settle(120)

    expect(taskCalls).toBe(0)
    expect(activeChatCalls).toBe(0)

    consumers.forEach((consumer) => consumer.unmount())
  })

  test('the last answer is served while hidden instead of refetching', async () => {
    const visible = renderHook(() => useAgentActivity({ polling: true }))
    await settle()
    expect(taskCalls).toBe(1)

    setVisibility('hidden')
    // Past the TTL: a hidden window still answers from the last value.
    await act(() => new Promise((resolve) => setTimeout(resolve, 5_100)))
    const hidden = renderHook(() => useAgentActivity({ polling: true }))
    await settle()
    expect(taskCalls).toBe(1)

    visible.unmount()
    hidden.unmount()
  }, 15_000)
})
