// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Typing is broadcast to the whole workspace, typist included, so the hook
 * drops the user's own typing events — both by the id the connection's `ready`
 * frame gave us (the server's truth) and by `useWorkspaceUser`'s id.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

let emit: (event: any) => void = () => {}
let workspaceUserId: string | null = 'me'
let selfUserId: string | null = null

// Spread the real modules: mocks are process-wide and other suites need the rest.
const realConnection = await import('../../lib/team-chat-connection')
const realWorkspaceUser = await import('../useWorkspaceUser')

mock.module('../../lib/team-chat-connection', () => ({
  ...realConnection,
  useTeamChatEvents: (_workspaceId: string, onEvent: (event: any) => void) => {
    emit = onEvent
    return 'open'
  },
  useTeamChatSelfUserId: () => selfUserId,
}))
mock.module('../useWorkspaceUser', () => ({
  ...realWorkspaceUser,
  useWorkspaceUser: () =>
    workspaceUserId ? { id: workspaceUserId, name: 'Me', email: null, source: 'local' } : null,
}))

const { useTypingUsers } = await import('../useTeamChat')

afterEach(() => {
  cleanup()
  workspaceUserId = 'me'
  selfUserId = null
})

describe('useTypingUsers', () => {
  test("shows other people typing, never the user's own typing", () => {
    const { result } = renderHook(() => useTypingUsers('ws-1', 'c1'))
    act(() => {
      emit({ type: 'typing', conversationId: 'c1', threadRootId: null, userId: 'me', name: 'Me' })
      emit({ type: 'typing', conversationId: 'c1', threadRootId: null, userId: 'pat', name: 'Pat' })
    })
    expect(result.current).toEqual([{ id: 'pat', name: 'Pat' }])
  })

  test("drops the connection's own id even when useWorkspaceUser returns null", () => {
    workspaceUserId = null
    selfUserId = 'server-me'
    const { result } = renderHook(() => useTypingUsers('ws-1', 'c1'))
    act(() => {
      emit({ type: 'typing', conversationId: 'c1', threadRootId: null, userId: 'server-me', name: 'Me' })
      emit({ type: 'typing', conversationId: 'c1', threadRootId: null, userId: 'pat', name: 'Pat' })
    })
    expect(result.current).toEqual([{ id: 'pat', name: 'Pat' }])
  })

  test("drops the connection's own id in a thread when useWorkspaceUser returns a different id", () => {
    workspaceUserId = 'cloud-me'
    selfUserId = 'local-me'
    const { result } = renderHook(() => useTypingUsers('ws-1', 'c1', 'root'))
    act(() => {
      emit({ type: 'typing', conversationId: 'c1', threadRootId: 'root', userId: 'local-me', name: 'Me' })
      emit({ type: 'typing', conversationId: 'c1', threadRootId: 'root', userId: 'cloud-me', name: 'Me' })
      emit({ type: 'typing', conversationId: 'c1', threadRootId: 'root', userId: 'pat', name: 'Pat' })
    })
    expect(result.current).toEqual([{ id: 'pat', name: 'Pat' }])
  })
})
