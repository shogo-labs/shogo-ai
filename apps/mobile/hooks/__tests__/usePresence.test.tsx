// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Presence is fetched only for people on screen, in one batch, then kept
 * live by socket events and refetched after a reconnect.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

const calls: Array<{ workspaceId: string; ids: string[] }> = []
let server: Record<string, string> = {}
let emit: (event: any) => void = () => {}
let socketState = 'open'

// Spread the real modules: mocks are process-wide and other suites need the rest.
const realApi = await import('../../lib/team-chat-api')
const realConnection = await import('../../lib/team-chat-connection')

mock.module('../../lib/team-chat-api', () => ({
  ...realApi,
  teamChatApi: () => ({
    presence: async (workspaceId: string, ids: string[]) => {
      calls.push({ workspaceId, ids: [...ids].sort() })
      return Object.fromEntries(ids.map((id) => [id, server[id] ?? 'offline']))
    },
  }),
}))
mock.module('../../lib/team-chat-connection', () => ({
  ...realConnection,
  useTeamChatEvents: (_workspaceId: string, onEvent: (event: any) => void) => {
    emit = onEvent
    return socketState
  },
}))

const { _resetPresenceForTests, usePresence, usePresenceFeed } = await import('../usePresence')

const settle = () => act(() => new Promise((r) => setTimeout(r, 80)))

beforeEach(() => {
  _resetPresenceForTests()
  calls.length = 0
  server = { pat: 'active', sam: 'away' }
  socketState = 'open'
})
afterEach(cleanup)

describe('usePresence', () => {
  test('loads everyone on screen in one batch', async () => {
    const { result } = renderHook(() => {
      usePresenceFeed('ws-1')
      return [usePresence('ws-1', 'pat'), usePresence('ws-1', 'sam'), usePresence(undefined, 'kim')]
    })
    await settle()
    expect(calls).toEqual([{ workspaceId: 'ws-1', ids: ['kim', 'pat', 'sam'] }])
    expect(result.current).toEqual(['active', 'away', 'offline'])
  })

  test('live presence events update without refetching', async () => {
    const { result } = renderHook(() => {
      usePresenceFeed('ws-1')
      return usePresence('ws-1', 'sam')
    })
    await settle()
    act(() => emit({ type: 'presence', userId: 'sam', status: 'active' }))
    expect(result.current).toBe('active')
    expect(calls).toHaveLength(1)
  })

  test('a reconnect refetches the people on screen', async () => {
    socketState = 'connecting'
    const { result, rerender } = renderHook(() => {
      usePresenceFeed('ws-1')
      return usePresence('ws-1', 'pat')
    })
    await settle()
    expect(calls).toHaveLength(1)
    server.pat = 'offline'
    socketState = 'open'
    rerender()
    await settle()
    expect(calls).toHaveLength(2)
    expect(result.current).toBe('offline')
  })
})
