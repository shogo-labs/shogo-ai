// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-103: `useSentMessages` is the only place the Activity panel's Sent view
 * talks to the server, and the component suite mocks it away — so this is where
 * the four things the panel promises are checked for real:
 *
 * 1. nothing is fetched until the chip is picked (people who never open Sent
 *    pay nothing);
 * 2. paging asks for `before` *and* `beforeId` of the last row, so the server's
 *    (createdAt, id) keyset can neither repeat nor drop a message on a tie;
 * 3. pull-to-refresh replaces the list instead of appending to it;
 * 4. a send from another window shows up — and someone else's message does not
 *    trigger a refetch of your own outbox.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

const realApi = await import('../../lib/team-chat-api')

type Row = {
  id: string
  conversationId: string
  threadRootId: string | null
  text: string
  createdAt: string
  conversation: { id: string; kind: string; name: string | null; slug: string | null }
}

const row = (id: string, createdAt: string): Row => ({
  id,
  conversationId: 'c1',
  threadRootId: null,
  text: `text ${id}`,
  createdAt,
  conversation: { id: 'c1', kind: 'public', name: 'eng', slug: 'eng' },
})

const sentMessages = mock(
  async (_workspaceId: string, _opts: { before?: string; beforeId?: string; limit?: number } = {}) => ({
    items: [] as Row[],
    hasMore: false,
  }),
)

mock.module('../../lib/team-chat-api', () => ({
  ...realApi,
  teamChatApi: () => ({ sentMessages }),
}))

let emit: ((event: any) => void) | null = null
mock.module('../../lib/team-chat-connection', () => ({
  useTeamChatEvents: (_workspaceId: string | null, onEvent: (event: any) => void) => {
    emit = onEvent
    return 'open'
  },
}))

mock.module('../useWorkspaceUser', () => ({
  useWorkspaceUser: () => ({ id: 'me', name: 'Me', email: 'me@example.com', source: 'local' }),
}))

mock.module('../useTeamChat', () => ({
  useMentionables: () => ({ members: [], agents: [] }),
}))

const { useSentMessages } = await import('../useChatPrefs')

const flush = () => act(async () => { await Promise.resolve() })

beforeEach(() => {
  sentMessages.mockClear()
  emit = null
})

afterEach(cleanup)

describe('useSentMessages', () => {
  test('costs nothing until the Sent chip is picked, then loads page one', async () => {
    sentMessages.mockImplementation(async () => ({ items: [row('m1', '2026-10-20T12:00:00.000Z')], hasMore: true }))

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useSentMessages('ws-1', enabled),
      { initialProps: { enabled: false } },
    )
    await flush()
    expect(sentMessages).not.toHaveBeenCalled()
    expect(result.current.items).toEqual([])

    rerender({ enabled: true })
    await flush()
    expect(sentMessages).toHaveBeenCalledTimes(1)
    expect(sentMessages.mock.calls[0]).toEqual(['ws-1', {}])
    expect(result.current.items.map((i) => i.id)).toEqual(['m1'])
    expect(result.current.hasMore).toBe(true)
  })

  test('Show older asks for the last row by (createdAt, id) and appends', async () => {
    sentMessages.mockImplementation(async (_ws: string, opts: any = {}) => {
      if (opts.beforeId) return { items: [row('m3', '2026-10-20T10:00:00.000Z')], hasMore: false }
      return {
        items: [row('m1', '2026-10-20T12:00:00.000Z'), row('m2', '2026-10-20T11:00:00.000Z')],
        hasMore: true,
      }
    })

    const { result } = renderHook(() => useSentMessages('ws-1', true))
    await flush()
    expect(result.current.items.map((i) => i.id)).toEqual(['m1', 'm2'])

    act(() => { result.current.loadMore() })
    await flush()

    expect(sentMessages).toHaveBeenCalledTimes(2)
    // Both halves of the cursor: a createdAt-only page boundary either repeats
    // or drops a row when several messages share a millisecond.
    expect(sentMessages.mock.calls[1]).toEqual([
      'ws-1',
      { before: '2026-10-20T11:00:00.000Z', beforeId: 'm2' },
    ])
    expect(result.current.items.map((i) => i.id)).toEqual(['m1', 'm2', 'm3'])
    expect(result.current.hasMore).toBe(false)
  })

  test('pull-to-refresh replaces the list rather than growing it', async () => {
    sentMessages.mockImplementation(async () => ({
      items: [row('m1', '2026-10-20T12:00:00.000Z')],
      hasMore: true,
    }))

    const { result } = renderHook(() => useSentMessages('ws-1', true))
    await flush()
    act(() => { result.current.loadMore() })
    await flush()
    expect(result.current.items).toHaveLength(2)

    sentMessages.mockImplementation(async () => ({
      items: [row('fresh', '2026-10-20T13:00:00.000Z')],
      hasMore: false,
    }))
    act(() => { result.current.refresh() })
    await flush()

    expect(sentMessages.mock.calls[sentMessages.mock.calls.length - 1]).toEqual(['ws-1', {}])
    expect(result.current.items.map((i) => i.id)).toEqual(['fresh'])
    expect(result.current.hasMore).toBe(false)
  })

  test('another window sending your message refetches; someone else\'s does not', async () => {
    sentMessages.mockImplementation(async () => ({
      items: [row('m1', '2026-10-20T12:00:00.000Z')],
      hasMore: false,
    }))

    renderHook(() => useSentMessages('ws-1', true))
    await flush()
    expect(sentMessages).toHaveBeenCalledTimes(1)

    const message = (authorUserId: string) => ({
      type: 'message.created',
      conversationId: 'c1',
      message: { id: 'x', authorType: 'user', authorUserId, text: 'hi' },
    })

    act(() => { emit?.(message('someone-else')) })
    await flush()
    expect(sentMessages).toHaveBeenCalledTimes(1)

    act(() => { emit?.(message('me')) })
    await flush()
    expect(sentMessages).toHaveBeenCalledTimes(2)
  })
})
