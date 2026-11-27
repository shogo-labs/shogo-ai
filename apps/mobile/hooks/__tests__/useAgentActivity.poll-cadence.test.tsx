// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-602 — the activity poll follows what the screen can see.
 *
 * A turn runs for minutes, and a 5 s poll of `agent-tasks` + `active-chats`
 * for its whole length is ~720 requests/hour/user with the radio awake on
 * whatever screen the person is on. The fast cadence is now scoped: 5 s only
 * while this screen is showing a run (`watchRunning`), 60 s while a run is off
 * screen (its edges arrive on the socket), 30 s when nothing is running.
 */
import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

type Task = { id: string; status: string; updatedAt: string; workspaceId: string; title: string }

const RUNNING: Task = {
  id: 't1',
  status: 'running',
  updatedAt: '2026-11-27T00:00:00Z',
  workspaceId: 'ws-1',
  title: 'Working',
}

let taskCalls = 0
let activeChatCalls = 0
let tasks: Task[] = []

const realApi = await import('../../lib/api')
const realSharedDomain = await import('@shogo/shared-app/domain')
const realDomain = await import('../../contexts/domain')

mock.module('../../lib/api', () => ({
  ...realApi,
  api: {
    ...realApi.api,
    listAgentTasks: async () => {
      taskCalls += 1
      return tasks
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

mock.module('../useWorkspaceInView', () => ({
  useWorkspaceInView: () => ({ id: 'ws-1', name: 'Workspace' }),
  useWorkspaceDataScope: () => ({ everyWorkspace: false }),
}))

let turnEdgeListener: (() => void) | null = null
mock.module('../useChatTurnEvents', () => ({
  useChatTurnEvents: (
    _workspaceId: string | null | undefined,
    onEdge: (edge: { chatSessionId: string; turnId: string; state: 'started' | 'ended' }) => void,
  ) => {
    turnEdgeListener = () => onEdge({ chatSessionId: 'chat-9', turnId: 'turn-9', state: 'started' })
  },
}))

const { useAgentActivity } = await import('../useAgentActivity')
const { workspaceActivity } = await import('../../lib/workspace-activity')

/** Let the in-flight load land and React commit. */
async function flush() {
  workspaceActivity.reset()
  await settle()
}

/** The same, for a test that is deliberately exercising the shared cache. */
async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function advance(ms: number) {
  let left = ms
  while (left > 0) {
    const step = Math.min(100, left)
    act(() => {
      jest.advanceTimersByTime(step)
    })
    left -= step
  }
}

async function mount(opts: { watchRunning?: boolean } = {}) {
  const rendered = renderHook(() => useAgentActivity({ polling: true, light: true, ...opts }))
  await flush()
  return rendered
}

beforeEach(() => {
  jest.useFakeTimers()
  taskCalls = 0
  activeChatCalls = 0
  tasks = []
  workspaceActivity.reset()
})

afterEach(() => {
  cleanup()
  jest.useRealTimers()
  workspaceActivity.reset()
})

describe('useAgentActivity poll cadence', () => {
  test('nothing running: an idle screen asks every 30s, not every 5', async () => {
    await mount()
    // A freshly mounted screen makes one confirm ask at the fast cadence; the
    // idle cadence starts after it.
    advance(5_000)
    await flush()
    const from = taskCalls

    advance(29_000)
    await flush()
    expect(taskCalls).toBe(from)

    advance(1_000)
    await flush()
    expect(taskCalls).toBe(from + 1)
    expect(activeChatCalls).toBe(taskCalls)
  })

  test('a run this screen is showing keeps the 5s cadence', async () => {
    tasks = [RUNNING]
    await mount({ watchRunning: true })
    const from = taskCalls

    advance(5_000)
    await flush()
    expect(taskCalls).toBe(from + 1)
  })

  test('a run this screen only reports on asks every 60s', async () => {
    tasks = [RUNNING]
    await mount()
    advance(5_000)
    await flush()
    const from = taskCalls

    advance(30_000)
    await flush()
    expect(taskCalls).toBe(from)

    advance(30_000)
    await flush()
    expect(taskCalls).toBe(from + 1)
  })

  test('a 5-minute window costs 10 requests idle and 5 with a run elsewhere', async () => {
    const idle = await mount()
    const idleFrom = { task: taskCalls, chat: activeChatCalls }
    for (let i = 0; i < 30; i += 1) {
      advance(10_000)
      await flush()
    }
    // 300 s at 30 s: ten asks per endpoint — 20 across both.
    expect(taskCalls - idleFrom.task).toBe(10)
    expect(activeChatCalls - idleFrom.chat).toBe(10)
    idle.unmount()

    workspaceActivity.reset()
    tasks = [RUNNING]
    const busy = await mount()
    const busyFrom = { task: taskCalls, chat: activeChatCalls }
    for (let i = 0; i < 30; i += 1) {
      advance(10_000)
      await flush()
    }
    // 300 s at 60 s: five asks per endpoint — six or fewer, the card's budget.
    expect(taskCalls - busyFrom.task).toBeLessThanOrEqual(6)
    expect(activeChatCalls - busyFrom.chat).toBeLessThanOrEqual(6)
    busy.unmount()
  })

  test('a cached answer written before this screen mounted cannot hide a run for 30s', async () => {
    // A screen that is no longer mounted asked a second ago and got "nothing
    // running"; the turn starts between that answer and this mount. The mount
    // is allowed to share that answer (SHO-277) — but only for one confirm ask,
    // not for a 30 s cadence, because a short turn does not live that long.
    tasks = []
    await workspaceActivity.agentTasks({} as never, 'ws-1')
    advance(1_000)
    tasks = [RUNNING]

    const rendered = renderHook(() => useAgentActivity({ polling: true, light: true }))
    await settle()
    expect(rendered.result.current.running).toEqual([])

    advance(5_000)
    await settle()

    expect(rendered.result.current.running.map((task) => task.id)).toEqual(['t1'])
  })

  test('a first read from before the server knew the turn is confirmed within 5s', async () => {
    // The composer shows its stop button optimistically, so a screen can mount
    // before `/active-chats` reports the turn. With one confirm ask the row
    // appears while the turn is still running instead of after it ended.
    const rendered = await mount()
    expect(rendered.result.current.running).toEqual([])

    tasks = [RUNNING]
    advance(5_000)
    await settle()

    expect(rendered.result.current.running.map((task) => task.id)).toEqual(['t1'])
  })

  test('a turn edge off the socket refreshes at once, without waiting for the timer', async () => {
    await mount()
    const settled = taskCalls

    act(() => turnEdgeListener?.())
    advance(150)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(taskCalls).toBe(settled + 1)
    expect(activeChatCalls).toBe(settled + 1)
  })

  test('a screen that is not polling takes no edges and makes no request', async () => {
    renderHook(() => useAgentActivity({ polling: false, light: true }))
    await flush()
    const settled = taskCalls

    advance(5_000)
    await flush()

    expect(taskCalls).toBe(settled)
  })
})
