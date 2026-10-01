// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Typing is broadcast to the whole workspace, typist included, so the hook
 * drops the user's own typing events.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

let emit: (event: any) => void = () => {}

mock.module('../../lib/team-chat-connection', () => ({
  useTeamChatEvents: (_workspaceId: string, onEvent: (event: any) => void) => {
    emit = onEvent
    return 'open'
  },
}))
mock.module('../useWorkspaceUser', () => ({
  useWorkspaceUser: () => ({ id: 'me', name: 'Me', email: null, source: 'local' }),
}))

const { useTypingUsers } = await import('../useTeamChat')

afterEach(cleanup)

describe('useTypingUsers', () => {
  test("shows other people typing, never the user's own typing", () => {
    const { result } = renderHook(() => useTypingUsers('ws-1', 'c1'))
    act(() => {
      emit({ type: 'typing', conversationId: 'c1', threadRootId: null, userId: 'me', name: 'Me' })
      emit({ type: 'typing', conversationId: 'c1', threadRootId: null, userId: 'pat', name: 'Pat' })
    })
    expect(result.current).toEqual(['Pat'])
  })
})
