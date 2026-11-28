// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Later badge counts saved messages per workspace. It cannot read the
 * shared `savedIds` store: that one is a union across workspaces, so switching
 * workspace would show the other one's count.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

let savedCalls: string[] = []
let emit: (event: any) => void = () => {}
let savedResponse: () => Promise<unknown[]> = async () => []

const realApi = await import('../../lib/team-chat-api')
const realConnection = await import('../../lib/team-chat-connection')

mock.module('../../lib/team-chat-api', () => ({
  ...realApi,
  teamChatApi: () => ({
    saved: (workspaceId: string) => {
      savedCalls.push(workspaceId)
      return savedResponse()
    },
  }),
}))
mock.module('../../lib/team-chat-connection', () => ({
  ...realConnection,
  useTeamChatEvents: (_workspaceId: string, onEvent: (event: any) => void) => {
    emit = onEvent
    return 'open'
  },
}))

const { useSavedCount } = await import('../useChatItems')

const item = (id: string) => ({ message: { id } }) as any

beforeEach(() => {
  savedCalls = []
  emit = () => {}
  savedResponse = async () => []
})
afterEach(cleanup)

describe('useSavedCount', () => {
  test('counts what the workspace has saved', async () => {
    savedResponse = async () => [item('m-1'), item('m-2')]
    const { result } = renderHook(() => useSavedCount('ws-1'))
    await waitFor(() => expect(result.current).toBe(2))
    expect(savedCalls).toEqual(['ws-1'])
  })

  test('no workspace, no request and no count', async () => {
    const { result } = renderHook(() => useSavedCount(null))
    expect(result.current).toBe(0)
    expect(savedCalls).toEqual([])
  })

  test('a save or unsave elsewhere moves the badge', async () => {
    savedResponse = async () => [item('m-1')]
    const { result } = renderHook(() => useSavedCount('ws-1'))
    await waitFor(() => expect(result.current).toBe(1))

    act(() => emit({ type: 'saved.changed', messageId: 'm-2', saved: true }))
    expect(result.current).toBe(2)
    act(() => emit({ type: 'saved.changed', messageId: 'm-1', saved: false }))
    expect(result.current).toBe(1)
    act(() => emit({ type: 'saved.changed', messageId: 'm-9', saved: false }))
    expect(result.current).toBe(0)
  })

  test('a save during the initial load is not overwritten by the older list', async () => {
    let settle: (items: unknown[]) => void = () => {}
    savedResponse = () => new Promise((resolve) => (settle = resolve))

    const { result } = renderHook(() => useSavedCount('ws-1'))
    act(() => emit({ type: 'saved.changed', messageId: 'm-new', saved: true }))
    expect(result.current).toBe(1)

    await act(async () => settle([item('m-1')]))
    expect(result.current).toBe(1)
  })

  test('a different workspace replaces the count', async () => {
    savedResponse = async () => [item('m-1'), item('m-2')]
    const { result, rerender } = renderHook(({ id }) => useSavedCount(id), {
      initialProps: { id: 'ws-1' },
    })
    await waitFor(() => expect(result.current).toBe(2))

    savedResponse = async () => [item('m-1')]
    rerender({ id: 'ws-2' })
    await waitFor(() => expect(result.current).toBe(1))
    expect(savedCalls).toEqual(['ws-1', 'ws-2'])
  })
})
