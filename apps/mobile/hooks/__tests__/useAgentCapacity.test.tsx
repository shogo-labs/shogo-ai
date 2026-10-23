// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The banner and the settings stepper both read their numbers from here, so the
 * thing that matters is where those numbers come from: one HTTP read for the
 * parts only the server knows (plan, ceiling, whether you may change it), then
 * the queue's own `agent.capacity` events for the counts. A workspace event
 * that belongs to a different workspace must not move this one's banner, and a
 * dropped socket must re-read once it is back.
 */
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { AgentCapacity, TeamChatEvent } from '../../lib/team-chat-api'

function capacityOf(partial: Partial<AgentCapacity> = {}): AgentCapacity {
  return {
    limit: 2,
    max: 8,
    defaultLimit: 8,
    configured: null,
    source: 'plan',
    planId: 'pro',
    running: 2,
    parked: 0,
    queued: 0,
    canManage: true,
    ...partial,
  }
}

const state: {
  reads: string[]
  served: AgentCapacity
  realtime: 'closed' | 'connecting' | 'open' | 'fallback'
  emit: ((event: TeamChatEvent) => void) | null
} = { reads: [], served: capacityOf(), realtime: 'open', emit: null }

mock.module(resolve(import.meta.dir, '../../lib/team-chat-api'), () => ({
  teamChatApi: () => ({
    agentCapacity: async (workspaceId: string) => {
      state.reads.push(workspaceId)
      return state.served
    },
    setAgentCapacity: async (_workspaceId: string, limit: number | null) => {
      state.served = { ...state.served, limit: limit ?? state.served.max, configured: limit }
      return state.served
    },
  }),
}))
mock.module(resolve(import.meta.dir, '../../lib/team-chat-connection'), () => ({
  useTeamChatEvents: (_workspaceId: string | null, onEvent: (event: TeamChatEvent) => void) => {
    state.emit = onEvent
    return state.realtime
  },
}))

const { useAgentCapacity } = await import('../useAgentCapacity')

beforeEach(() => {
  state.reads.length = 0
  state.emit = null
  state.realtime = 'open'
  state.served = capacityOf()
})

afterEach(cleanup)

describe('useAgentCapacity', () => {
  test('reads the workspace once, then follows the queue events', async () => {
    const { result } = renderHook(() => useAgentCapacity('ws-1'))
    await waitFor(() => expect(result.current.capacity?.queued).toBe(0))
    expect(state.reads).toEqual(['ws-1'])

    act(() => {
      state.emit?.({ type: 'agent.capacity', workspaceId: 'ws-1', limit: 2, running: 2, parked: 0, queued: 3 })
    })

    expect(result.current.capacity?.queued).toBe(3)
    expect(result.current.capacity?.running).toBe(2)
    // The event carries counts only: what the server knows stays as read.
    expect(result.current.capacity?.planId).toBe('pro')
    expect(result.current.capacity?.canManage).toBe(true)
    // An event is not a reason to hit the API.
    expect(state.reads).toEqual(['ws-1'])
  })

  test('ignores a capacity event for another workspace', async () => {
    const { result } = renderHook(() => useAgentCapacity('ws-1'))
    await waitFor(() => expect(result.current.capacity?.queued).toBe(0))

    act(() => {
      state.emit?.({ type: 'agent.capacity', workspaceId: 'ws-2', limit: 1, running: 1, parked: 0, queued: 9 })
    })
    expect(result.current.capacity?.queued).toBe(0)
  })

  test('re-reads after the socket drops and comes back', async () => {
    const { result, rerender } = renderHook(() => useAgentCapacity('ws-1'))
    await waitFor(() => expect(state.reads.length).toBe(1))

    state.realtime = 'closed'
    await act(async () => {
      rerender()
    })
    expect(state.reads.length).toBe(1)

    state.served = capacityOf({ queued: 5 })
    state.realtime = 'open'
    await act(async () => {
      rerender()
    })
    await waitFor(() => expect(result.current.capacity?.queued).toBe(5))
    expect(state.reads.length).toBe(2)
  })

  test('sends the change and adopts what the server accepted', async () => {
    const { result } = renderHook(() => useAgentCapacity('ws-1'))
    await waitFor(() => expect(result.current.capacity?.limit).toBe(2))

    await act(async () => {
      await result.current.setConcurrency(1)
    })
    expect(result.current.capacity?.limit).toBe(1)
    expect(result.current.capacity?.configured).toBe(1)
  })
})
