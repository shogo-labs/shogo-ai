// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Activity inbox pages through `before` cursors, and the panel that renders
 * it is where the reader actually feels that. Four things are checked here,
 * because the component suite mocks this hook away:
 *
 * 1. the first page loads on mount;
 * 2. `loadMore` asks for rows older than the last one it holds and appends
 *    them — so a reader can reach past page one;
 * 3. `inbox.read` (every mark-read) and `ready` (every reconnect) keep the
 *    pages already loaded. A plain reload there replaced the whole list with
 *    page one, which is what made the feed look like it "stopped paginating";
 * 4. two end-of-list signals in flight at once do not stack up requests.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

const realApi = await import('../../lib/team-chat-api')

type Row = {
  id: string
  kind: string
  conversationId: string | null
  messageId: string | null
  threadRootId: string | null
  actorUserId: string | null
  title: string
  preview: string | null
  readAt: string | null
  createdAt: string
  conversation: { id: string; kind: string; name: string | null; slug: string | null } | null
}

const item = (id: string, createdAt: string, readAt: string | null = null): Row => ({
  id,
  kind: 'mention',
  conversationId: 'c1',
  messageId: `m-${id}`,
  threadRootId: null,
  actorUserId: 'u2',
  title: `row ${id}`,
  preview: `preview ${id}`,
  readAt,
  createdAt,
  conversation: { id: 'c1', kind: 'public', name: 'eng', slug: 'eng' },
})

const inbox = mock(
  async (
    _workspaceId: string,
    _opts: { unreadOnly?: boolean; before?: string } = {},
  ): Promise<{ items: Row[]; hasMore: boolean; unread: number; unreadThreads: number }> => ({
    items: [],
    hasMore: false,
    unread: 0,
    unreadThreads: 0,
  }),
)

const markInboxRead = mock(async () => 0)

mock.module('../../lib/team-chat-api', () => ({
  ...realApi,
  teamChatApi: () => ({ inbox, markInboxRead }),
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

const { useInbox } = await import('../useChatPrefs')

const flush = () => act(async () => { await Promise.resolve() })

const PAGE_1 = [item('a', '2026-10-20T12:00:00.000Z'), item('b', '2026-10-20T11:00:00.000Z')]
const PAGE_2 = [item('c', '2026-10-20T10:00:00.000Z')]

beforeEach(() => {
  inbox.mockClear()
  markInboxRead.mockClear()
  emit = null
  inbox.mockImplementation(async (_ws, opts = {}) =>
    opts.before
      ? { items: PAGE_2, hasMore: false, unread: 2, unreadThreads: 0 }
      : { items: PAGE_1, hasMore: true, unread: 2, unreadThreads: 0 },
  )
})

afterEach(cleanup)

describe('useInbox · paging', () => {
  test('the first page loads on mount', async () => {
    const view = renderHook(() => useInbox('ws-1', false))
    await flush()

    expect(inbox).toHaveBeenCalledTimes(1)
    expect(view.result.current.items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(view.result.current.hasMore).toBe(true)
  })

  test('loadMore asks for rows older than the last one held, and appends them', async () => {
    const view = renderHook(() => useInbox('ws-1', false))
    await flush()

    act(() => view.result.current.loadMore())
    await flush()

    expect(inbox).toHaveBeenCalledTimes(2)
    // The cursor is the oldest row in hand — page two starts strictly below it.
    expect(inbox.mock.calls[1][1]).toMatchObject({ before: '2026-10-20T11:00:00.000Z' })
    expect(view.result.current.items.map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(view.result.current.hasMore).toBe(false)
  })

  test('loadMore is quiet once the server says there is nothing more', async () => {
    inbox.mockImplementation(async () => ({ items: PAGE_1, hasMore: false, unread: 0, unreadThreads: 0 }))
    const view = renderHook(() => useInbox('ws-1', false))
    await flush()

    act(() => view.result.current.loadMore())
    await flush()

    expect(inbox).toHaveBeenCalledTimes(1)
  })

  test('two end-of-list signals in flight at once do not stack up requests', async () => {
    const view = renderHook(() => useInbox('ws-1', false))
    await flush()

    act(() => {
      view.result.current.loadMore()
      view.result.current.loadMore()
    })
    await flush()

    // One page-one fetch, one append — not two appends of the same page.
    expect(inbox).toHaveBeenCalledTimes(2)
    expect(view.result.current.items.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  test('inbox.read keeps the pages already loaded', async () => {
    const view = renderHook(() => useInbox('ws-1', false))
    await flush()
    act(() => view.result.current.loadMore())
    await flush()
    expect(view.result.current.items).toHaveLength(3)

    // Clicking a row marks it read, which the server echoes back to us.
    act(() => emit?.({ type: 'inbox.read', unread: 1, unreadThreads: 0 }))
    await flush()

    // The regression: a plain reload here dropped page two and snapped the
    // reader back to the top with only the first page in hand.
    expect(view.result.current.items.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  test('a reconnect keeps the pages already loaded', async () => {
    const view = renderHook(() => useInbox('ws-1', false))
    await flush()
    act(() => view.result.current.loadMore())
    await flush()

    act(() => emit?.({ type: 'ready' }))
    await flush()

    expect(view.result.current.items.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  test('unread mode asks the server to filter, so pages arrive unread', async () => {
    const view = renderHook(() => useInbox('ws-1', true))
    await flush()

    // Filtering unread on the client left every page mostly-read: the filtered
    // list never filled the panel and the feed walked the whole history.
    expect(inbox.mock.calls[0][1]).toMatchObject({ unreadOnly: true })
    expect(view.result.current.items.map((i) => i.id)).toEqual(['a', 'b'])
  })

  test('unread mode keeps the filter on every appended page', async () => {
    const view = renderHook(() => useInbox('ws-1', true))
    await flush()

    act(() => view.result.current.loadMore())
    await flush()

    expect(inbox).toHaveBeenCalledTimes(2)
    expect(inbox.mock.calls[1][1]).toMatchObject({ unreadOnly: true, before: '2026-10-20T11:00:00.000Z' })
  })

  test('leaving unread mode asks for the unfiltered list again', async () => {
    const view = renderHook(({ unreadOnly }) => useInbox('ws-1', unreadOnly), {
      initialProps: { unreadOnly: true },
    })
    await flush()
    expect(inbox.mock.calls[0][1]).toMatchObject({ unreadOnly: true })

    view.rerender({ unreadOnly: false })
    await flush()

    expect(inbox.mock.calls[inbox.mock.calls.length - 1][1]).toMatchObject({ unreadOnly: false })
  })

  test('a refresh still shows rows that arrived below the first page', async () => {
    let page = PAGE_1
    inbox.mockImplementation(async (_ws, opts = {}) =>
      opts.before
        ? { items: PAGE_2, hasMore: false, unread: 2, unreadThreads: 0 }
        : { items: page, hasMore: true, unread: 2, unreadThreads: 0 },
    )
    const view = renderHook(() => useInbox('ws-1', false))
    await flush()
    act(() => view.result.current.loadMore())
    await flush()

    // A new mention lands at the head while the older page is on screen.
    page = [item('new', '2026-10-20T13:00:00.000Z'), ...PAGE_1]
    act(() => emit?.({ type: 'inbox.created', item: item('new', '2026-10-20T13:00:00.000Z') }))
    await flush()

    expect(view.result.current.items.map((i) => i.id)).toEqual(['new', 'a', 'b', 'c'])
  })
})
