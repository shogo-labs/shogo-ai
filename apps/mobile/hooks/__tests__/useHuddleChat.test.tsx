// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The call chat follows who is in the call: it is looked up once for the call,
 * again whenever the set of people changes, and never blanks out mid-call.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

const lookups: string[] = []
let result: any = null
let failure: Error | null = null

const realApi = await import('../../lib/team-chat-api')
mock.module('../../lib/team-chat-api', () => ({
  ...realApi,
  teamChatApi: () => ({
    huddleChat: async (id: string) => {
      lookups.push(id)
      if (failure) throw failure
      return result
    },
  }),
}))

const { useHuddleChat, huddleChatKey } = await import('../useHuddleChat')

const dmChat = { conversationId: 'dm-1', kind: 'dm', threadRootId: 'msg-1', members: ['a', 'b'], moved: false }
const groupChat = { conversationId: 'group-1', kind: 'group_dm', threadRootId: null, members: ['a', 'b', 'c'], moved: true }
const call = (chatMembers: string[]) => ({ id: 'h-1', messageId: 'msg-1', chatMembers })

beforeEach(() => {
  lookups.length = 0
  result = dmChat
  failure = null
})
afterEach(cleanup)

describe('huddleChatKey', () => {
  test('changes only when the call or the people in it change', () => {
    expect(huddleChatKey(null)).toBeNull()
    expect(huddleChatKey(call(['a', 'b']))).toBe(huddleChatKey({ ...call(['a', 'b']) }))
    expect(huddleChatKey(call(['a', 'b']))).not.toBe(huddleChatKey(call(['a', 'b', 'c'])))
    expect(huddleChatKey({ id: 'h-1', messageId: null, chatMembers: ['a'] })).not.toBe(huddleChatKey({ id: 'h-1', messageId: 'msg-1', chatMembers: ['a'] }))
  })
})

describe('useHuddleChat', () => {
  test('looks the chat up for the call and returns it', async () => {
    const { result: hook } = renderHook(() => useHuddleChat('dm-1', call(['a', 'b'])))
    expect(hook.current.target).toBeNull()
    await waitFor(() => expect(hook.current.target).toEqual(dmChat))
    expect(lookups).toEqual(['dm-1'])
  })

  test('asks again when someone is added, and moves to the group', async () => {
    let huddle = call(['a', 'b'])
    const { result: hook, rerender } = renderHook(() => useHuddleChat('dm-1', huddle))
    await waitFor(() => expect(hook.current.target?.conversationId).toBe('dm-1'))

    result = groupChat
    huddle = call(['a', 'b', 'c'])
    rerender()
    // The old chat stays on screen until the new one lands.
    expect(hook.current.target?.conversationId).toBe('dm-1')
    await waitFor(() => expect(hook.current.target?.conversationId).toBe('group-1'))
    expect(lookups).toHaveLength(2)
  })

  test('does not ask again for updates that change nobody', async () => {
    let huddle = call(['a', 'b'])
    const { result: hook, rerender } = renderHook(() => useHuddleChat('dm-1', huddle))
    await waitFor(() => expect(hook.current.target).not.toBeNull())
    huddle = { ...call(['a', 'b']) }
    rerender()
    await act(async () => {})
    expect(lookups).toHaveLength(1)
  })

  test('does nothing without a call, and reports a failed lookup while keeping the last chat', async () => {
    const idle = renderHook(() => useHuddleChat('dm-1', null))
    await act(async () => {})
    expect(lookups).toHaveLength(0)
    expect(idle.result.current).toEqual({ target: null, failed: false })
    cleanup()

    let huddle = call(['a', 'b'])
    const { result: hook, rerender } = renderHook(() => useHuddleChat('dm-1', huddle))
    await waitFor(() => expect(hook.current.target).toEqual(dmChat))
    failure = new Error('offline')
    huddle = call(['a', 'b', 'c'])
    rerender()
    await waitFor(() => expect(hook.current.failed).toBe(true))
    expect(hook.current.target).toEqual(dmChat)
  })

  test('a different conversation starts with no chat', async () => {
    let id = 'dm-1'
    const { result: hook, rerender } = renderHook(() => useHuddleChat(id, call(['a', 'b'])))
    await waitFor(() => expect(hook.current.target).not.toBeNull())
    id = 'dm-2'
    rerender()
    expect(hook.current.target).toBeNull()
  })
})
