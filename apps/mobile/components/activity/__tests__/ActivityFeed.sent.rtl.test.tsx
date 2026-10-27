// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-103: the Activity panel's Sent view.
 *
 * The same component is the desktop side panel and the phone tab, so this one
 * suite covers both surfaces: the chip exists, it lists only what you sent, it
 * drops the inbound chrome (Unreads pill, Running now), and a row opens the
 * conversation — the thread when the message was a reply.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, Fragment, useEffect } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const push = mock((..._args: any[]) => {})

// The base mock has no `RefreshControl`; the feed renders one on its list, so a
// no-op component is enough to mount. `Pressable` becomes a real button so a
// press can be driven from the test. `FlatList` is a passthrough host in the
// base mock — it drops `data`/`renderItem` — so the feed's rows are rendered
// here the way react-native-virtualized-list would: header, rows, footer.
mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    RefreshControl: () => null,
    FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent, ListFooterComponent, onEndReached }: any) =>
      createElement(
        'div',
        { 'data-testid': 'activity-list' },
        ListHeaderComponent,
        data.length
          ? data.map((item: any, index: number) =>
              createElement(
                Fragment,
                { key: keyExtractor ? keyExtractor(item, index) : index },
                renderItem({ item, index }),
              ),
            )
          : ListEmptyComponent,
        ListFooterComponent,
        createElement('button', { 'data-testid': 'list-end', onClick: () => onEndReached?.() }),
      ),
    Pressable: ({ accessibilityLabel, children, disabled, onPress, testID }: any) =>
      createElement(
        'button',
        {
          'aria-label': accessibilityLabel,
          'data-testid': testID,
          disabled: disabled ? true : undefined,
          onClick: disabled ? undefined : onPress,
        },
        children,
      ),
  } as any),
)

mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

mock.module('expo-router', () => ({
  useRouter: () => ({ push }),
  useFocusEffect: (cb: () => void | (() => void)) => {
    useEffect(cb, [])
  },
}))

const runningTask = {
  id: 'task-1',
  userId: 'u1',
  workspaceId: 'ws-1',
  projectId: 'p1',
  projectName: 'Billing',
  chatSessionId: null,
  title: 'Reconcile invoices',
  notes: null,
  dueAt: null,
  currentStep: 'Reading statements',
  resultSummary: null,
  errorMessage: null,
  queuedAt: null,
  startedAt: null,
  completedAt: null,
  createdAt: '2026-10-20T11:00:00.000Z',
  updatedAt: '2026-10-20T11:30:00.000Z',
  status: 'running',
}

const sentRows = [
  {
    id: 'm1',
    conversationId: 'c1',
    threadRootId: null,
    text: 'shipped the fix',
    createdAt: '2026-10-20T12:00:00.000Z',
    conversation: { id: 'c1', kind: 'public', name: 'eng', slug: 'eng' },
  },
  {
    id: 'm2',
    conversationId: 'c1',
    threadRootId: 'root-1',
    text: 'reply in the thread',
    createdAt: '2026-10-20T11:00:00.000Z',
    conversation: { id: 'c1', kind: 'public', name: 'eng', slug: 'eng' },
  },
]

const sent = {
  items: sentRows,
  hasMore: true,
  loading: false,
  refreshing: false,
  error: null as string | null,
  loadMore: mock(() => {}),
  refresh: mock(() => {}),
}
let sentEnabledCalls: boolean[] = []

const inboxRow = (id: string, createdAt: string) => ({
  id,
  kind: 'mention',
  conversationId: 'c1',
  messageId: `m-${id}`,
  threadRootId: null,
  actorUserId: 'u2',
  title: `mention ${id}`,
  preview: `preview ${id}`,
  readAt: null,
  createdAt,
  conversation: { id: 'c1', kind: 'public', name: 'eng', slug: 'eng' },
})

const inboxLoadMore = mock(() => {})
const baseInbox = {
  items: [] as ReturnType<typeof inboxRow>[],
  hasMore: false,
  loading: false,
  loadingMore: false,
  error: null as string | null,
  markRead: mock(() => {}),
  loadMore: inboxLoadMore,
  refresh: mock(() => {}),
}
let inboxState = { ...baseInbox }
/** What the feed asks the hook for — the unread filter has to reach the server. */
let inboxArgs: { workspaceId: string | null; unreadOnly: boolean }[] = []

mock.module('../../../hooks/useActiveWorkspace', () => ({ useActiveWorkspace: () => ({ id: 'ws-1' }) }))
mock.module('../../../hooks/useAgentActivity', () => ({
  useAgentActivity: () => ({
    tasks: [runningTask],
    activeChats: [],
    loading: false,
    refreshing: false,
    error: null,
    refresh: mock(() => {}),
  }),
}))
mock.module('../../../hooks/useChatPrefs', () => ({
  // Bun's mock registry is process-wide: a file that mocks this module only for
  // the two hooks the feed uses must still answer for the rest of them, or the
  // next test file in the same run fails to import.
  liveStatus: (status: unknown) => status,
  useStatusFeed: () => {},
  useUserStatus: () => null,
  useChatSettings: () => ({ notifyDefault: 'mentions', keywords: [] }),
  useInboxCounts: () => ({ unread: 0, unreadThreads: 0 }),
  useInboxUnread: () => 0,
  useInboxFeed: () => {},
  useInbox: (workspaceId: string | null, unreadOnly: boolean) => {
    inboxArgs.push({ workspaceId, unreadOnly })
    return inboxState
  },
  useSentMessages: (_workspaceId: string, enabled: boolean) => {
    sentEnabledCalls.push(enabled)
    return sent
  },
}))
mock.module('../../../hooks/useOpenQuestions', () => ({ useOpenQuestionCount: () => 0 }))
mock.module('../../../hooks/useWorkspaceExperience', () => ({ useWorkspaceExperience: () => ({ kind: 'team' }) }))
mock.module('../../../lib/open-active-chat', () => ({ openActiveChat: mock(() => {}) }))

const { ActivityFeed } = await import('../ActivityFeed')

beforeEach(() => {
  push.mockClear()
  sent.loadMore.mockClear()
  sent.refresh.mockClear()
  inboxLoadMore.mockClear()
  inboxState = { ...baseInbox }
  sentEnabledCalls = []
  inboxArgs = []
})

afterEach(cleanup)

describe('Activity · Sent', () => {
  test('the chip is there and Sent loads only once it is picked', () => {
    render(createElement(ActivityFeed))

    expect(screen.getByText('Sent')).toBeTruthy()
    expect(sentEnabledCalls.every((enabled) => enabled === false)).toBe(true)
  })

  test('picking Sent lists what you sent, without the inbound chrome', () => {
    render(createElement(ActivityFeed))

    // Inbound side first: agent work is running, so the strip is on screen.
    expect(screen.queryByText(/Running now/)).toBeTruthy()
    expect(screen.queryByText('Unreads')).toBeTruthy()

    fireEvent.click(screen.getByText('Sent'))

    expect(sentEnabledCalls.some((enabled) => enabled)).toBe(true)
    expect(screen.getAllByText('#eng').length).toBeGreaterThan(0)
    expect(screen.getByText('shipped the fix')).toBeTruthy()
    expect(screen.getByText('Thread in #eng')).toBeTruthy()

    // Agent work and the unread pill are not part of "messages you sent".
    expect(screen.queryByText(/Running now/)).toBeNull()
    expect(screen.queryByText('Unreads')).toBeNull()
  })

  test('a row opens the conversation, and a reply opens its thread', () => {
    render(createElement(ActivityFeed))
    fireEvent.click(screen.getByText('Sent'))

    fireEvent.click(screen.getByText('shipped the fix'))
    expect(push.mock.calls[0][0]).toMatchObject({
      pathname: '/(app)/c/[conversationId]',
      params: { conversationId: 'c1' },
    })

    fireEvent.click(screen.getByText('reply in the thread'))
    expect(push.mock.calls[1][0]).toMatchObject({
      pathname: '/(app)/c/[conversationId]',
      params: { conversationId: 'c1', thread: 'root-1' },
    })
  })

  test('Show older pages the list', () => {
    render(createElement(ActivityFeed))
    fireEvent.click(screen.getByText('Sent'))

    fireEvent.click(screen.getByText('Show older'))
    expect(sent.loadMore).toHaveBeenCalledTimes(1)
  })

  test('an unread-only filter set before Sent does not empty it', () => {
    render(createElement(ActivityFeed))
    fireEvent.click(screen.getByText('Unreads'))
    fireEvent.click(screen.getByText('Sent'))

    // Sent rows are never unread, and the pill is gone — the view must still list them.
    expect(screen.getByText('shipped the fix')).toBeTruthy()
    expect(screen.queryByText("You're all caught up.")).toBeNull()
  })
})

/**
 * The inbound feed is the surface the unread badge points at, so it has to be
 * able to walk past its first page. The hook owns the fetching (see
 * `useInbox.pagination.test.tsx`); this is the wiring that asks it to.
 */
describe('Activity · inbound paging', () => {
  test('every row the hook holds is rendered — the list is not capped at page one', () => {
    inboxState = {
      ...baseInbox,
      items: [
        inboxRow('i1', '2026-10-20T12:00:00.000Z'),
        inboxRow('i2', '2026-10-20T11:00:00.000Z'),
        inboxRow('i3', '2026-10-20T10:00:00.000Z'),
      ],
    }
    render(createElement(ActivityFeed))

    expect(screen.getByText('mention i1')).toBeTruthy()
    expect(screen.getByText('mention i2')).toBeTruthy()
    expect(screen.getByText('mention i3')).toBeTruthy()
  })

  test('the default view asks for the unfiltered list', () => {
    render(createElement(ActivityFeed))

    expect(inboxArgs[0]).toEqual({ workspaceId: 'ws-1', unreadOnly: false })
  })

  test('groups rows under day headers, and omits empty sections', () => {
    const today = new Date().toISOString()
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    inboxState = { ...baseInbox, items: [inboxRow('t1', today), inboxRow('y1', yesterday)] }
    render(createElement(ActivityFeed))

    expect(screen.getByText('Today')).toBeTruthy()
    expect(screen.getByText('Yesterday')).toBeTruthy()
    // Nothing is four days old here, so there is no Earlier divider.
    expect(screen.queryByText('Earlier')).toBeNull()
  })

  test('the Unreads pill asks the server to filter, not the client', () => {
    render(createElement(ActivityFeed))
    fireEvent.click(screen.getByText('Unreads'))

    // The regression: the panel hardcoded `false` and then filtered unread in
    // `buildFeed`. Every page arrived mostly-read, the filtered list never
    // filled the panel, and `onEndReached` walked the entire history.
    expect(inboxArgs[inboxArgs.length - 1]).toEqual({ workspaceId: 'ws-1', unreadOnly: true })
  })

  test('leaving the Unreads pill asks for the unfiltered list again', () => {
    render(createElement(ActivityFeed))
    fireEvent.click(screen.getByText('Unreads'))
    fireEvent.click(screen.getByText('Unreads'))

    expect(inboxArgs[inboxArgs.length - 1]).toEqual({ workspaceId: 'ws-1', unreadOnly: false })
  })

  test('reaching the end of the list does not auto-load — paging is explicit', () => {
    inboxState = { ...baseInbox, items: [inboxRow('i1', '2026-10-20T12:00:00.000Z')], hasMore: true }
    render(createElement(ActivityFeed))

    // Scrolling used to page on its own, which raced the footer button and —
    // in Unreads mode — walked the whole history. Now only the button pages.
    fireEvent.click(screen.getByTestId('list-end'))
    expect(inboxLoadMore).not.toHaveBeenCalled()
    expect(screen.getByText('Show older')).toBeTruthy()
  })

  test('the footer says the list is exhausted instead of just vanishing', () => {
    inboxState = { ...baseInbox, items: [inboxRow('i1', '2026-10-20T12:00:00.000Z')], hasMore: false }
    render(createElement(ActivityFeed))

    expect(screen.queryByText('Show older')).toBeNull()
    expect(screen.getByText("You're all caught up.")).toBeTruthy()
  })

  test('the footer offers older items, and pressing it pages', () => {
    inboxState = { ...baseInbox, items: [inboxRow('i1', '2026-10-20T12:00:00.000Z')], hasMore: true }
    render(createElement(ActivityFeed))

    fireEvent.click(screen.getByText('Show older'))
    expect(inboxLoadMore).toHaveBeenCalledTimes(1)
  })

  test('nothing asks for more once the server says the inbox is exhausted', () => {
    inboxState = { ...baseInbox, items: [inboxRow('i1', '2026-10-20T12:00:00.000Z')], hasMore: false }
    render(createElement(ActivityFeed))

    expect(screen.queryByText('Show older')).toBeNull()
    fireEvent.click(screen.getByTestId('list-end'))
    expect(inboxLoadMore).not.toHaveBeenCalled()
  })

  test('a page already in flight does not offer to fetch itself again', () => {
    inboxState = { ...baseInbox, items: [inboxRow('i1', '2026-10-20T12:00:00.000Z')], hasMore: true, loadingMore: true }
    render(createElement(ActivityFeed))

    // The footer shows a spinner instead of the button while it loads.
    expect(screen.queryByText('Show older')).toBeNull()
    fireEvent.click(screen.getByTestId('list-end'))
    expect(inboxLoadMore).not.toHaveBeenCalled()
  })
})
