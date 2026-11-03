// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-294: with a thread open in a channel, opening another thread replaces it.
 *
 * The screen keeps the open thread in `?thread=<rootId>`, so the failure Russell
 * saw was a second `/c/[conversationId]` screen pushed on top of the first: on a
 * phone it slid over the open thread, on wide web it hid the old one in history
 * and brought it back on Back. This mounts the real conversation screen with
 * `?thread=A` and opens B from the timeline, then asserts one thread pane
 * showing B with no new screen pushed. The quote-card click has its own test
 * beside the card itself (`message-quote-thread-swap.rtl.test.tsx`).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../../test/react-native-mock'
import * as lucideStub from '../../../../test/stubs/lucide-react-native'

const mobile = resolve(import.meta.dir, '../../../..')

/** The params the screen is mounted with; `setParams` merges into it. */
let params: Record<string, string | undefined> = {}
const pushes: Array<{ pathname: string; params: Record<string, unknown> }> = []
const setParamsCalls: Array<Record<string, unknown>> = []

// The shared mock forwards props to the DOM, but `onPress` is not a DOM
// handler — a shim that wires it to onClick is what makes a tap testable.
mock.module('react-native', () =>
  createReactNativeMock({
    Pressable: (({
      accessibilityLabel,
      accessibilityRole,
      children,
      onPress,
      disabled,
      testID,
      ...props
    }: {
      accessibilityLabel?: string
      accessibilityRole?: string
      children?: unknown
      onPress?: () => void
      disabled?: boolean
      testID?: string
    }) =>
      createElement(
        'button',
        {
          ...props,
          role: accessibilityRole,
          'aria-label': accessibilityLabel,
          'data-testid': testID,
          disabled,
          onClick: () => {
            if (!disabled) onPress?.()
          },
        },
        children as never,
      )) as never,
  }),
)

const conversation = {
  id: 'c1',
  workspaceId: 'ws-1',
  name: 'shogo-dev',
  kind: 'channel' as const,
  members: [],
  hasDoc: false,
  canPost: true,
  archivedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
}

mock.module('expo-router', () => ({
  useRouter: () => ({
    push: (href: { pathname: string; params: Record<string, unknown> }) => pushes.push(href),
    replace: () => {},
    back: () => {},
    canGoBack: () => true,
    setParams: (next: Record<string, unknown>) => {
      setParamsCalls.push(next)
      for (const [key, value] of Object.entries(next)) {
        if (value === undefined) delete params[key]
        else params[key] = String(value)
      }
    },
  }),
  useLocalSearchParams: () => params,
  // The thread was opened from the channel: a plain channel sits underneath.
  useNavigation: () => ({
    getState: () => ({
      index: 1,
      routes: [
        { name: 'c/[conversationId]', params: { conversationId: 'c1' } },
        { name: 'c/[conversationId]', params: { conversationId: 'c1', thread: 'A' } },
      ],
    }),
  }),
  useFocusEffect: (cb: () => void | (() => void)) => {
    const React = require('react') as typeof import('react')
    React.useEffect(cb, [cb])
  },
}))

mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))
mock.module('lucide-react-native', () => lucideStub)
mock.module('react-native-safe-area-context', () => ({
  SafeAreaView: 'div',
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))

const stub = (testID: string) => () => createElement('div', { 'data-testid': testID })

const actualTeamChat = await import(resolve(mobile, 'hooks/useTeamChat'))
const actualChatPrefs = await import(resolve(mobile, 'hooks/useChatPrefs'))
const actualPresence = await import(resolve(mobile, 'hooks/usePresence'))
const actualChatItems = await import(resolve(mobile, 'hooks/useChatItems'))
const actualCustomEmoji = await import(resolve(mobile, 'hooks/useCustomEmoji'))
const actualApi = await import(resolve(mobile, 'lib/team-chat-api'))

// The real components on this screen are not what SHO-294 is about: every one
// of them is a passthrough, except the timeline (which stands in for the two
// clicks) and the quote card, which stays real because it is one of them.
mock.module(resolve(mobile, 'hooks/useActiveWorkspace'), () => ({ useActiveWorkspace: () => ({ id: 'ws-1' }) }))
mock.module(resolve(mobile, 'hooks/useTeamChat'), () => ({
  ...actualTeamChat,
  invalidateConversationList: () => {},
  setActiveConversation: () => {},
  useMentionables: () => ({ users: [], agents: [] }),
  useMyUserId: () => 'u-me',
}))
mock.module(resolve(mobile, 'hooks/useChatPrefs'), () => ({ ...actualChatPrefs, useStatusFeed: () => {}, useDraftsFeed: () => {}, useSavedFeed: () => {} }))
mock.module(resolve(mobile, 'hooks/usePresence'), () => ({ ...actualPresence, usePresenceFeed: () => {} }))
mock.module(resolve(mobile, 'hooks/useChatItems'), () => ({ ...actualChatItems, useDraftsFeed: () => {}, useSavedFeed: () => {} }))
mock.module(resolve(mobile, 'hooks/useCustomEmoji'), () => ({ ...actualCustomEmoji, useCustomEmojiFeed: () => {} }))
mock.module(resolve(mobile, 'lib/team-chat-connection'), () => ({ useTeamChatEvents: () => {} }))
mock.module(resolve(mobile, 'lib/team-chat-api'), () => ({
  ...actualApi,
  conversationTitle: () => 'shogo-dev',
  teamChatApi: () => ({
    get: async () => conversation,
    markInboxRead: async () => ({ ok: true }),
    message: async (id: string) => ({
      id,
      conversationId: 'c1',
      workspaceId: 'ws-1',
      seq: 5,
      threadRootId: null,
      replyCount: 0,
      lastReplyAt: null,
      alsoSentToChannel: false,
      authorType: 'user',
      author: { id: 'u-1', name: 'Ana Lopez', image: null },
      authorUserId: 'u-1',
      authorAgent: null,
      text: 'Thread B is the one that should be on screen.',
      blocks: null,
      clientMsgId: null,
      agentSessionId: null,
      agentStatus: null,
      reactions: [],
      attachments: [],
      editedAt: null,
      deletedAt: null,
      createdAt: '2026-11-02T09:00:00.000Z',
      conversation: { id: 'c1', name: 'shogo-dev', kind: 'public' },
    }),
  }),
}))
mock.module(resolve(mobile, 'lib/share-file-links'), () => ({ parseInAppFileHref: () => null }))
mock.module(resolve(mobile, 'components/chat/share-file-context'), () => ({
  ShareFileProvider: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))
mock.module(resolve(mobile, 'components/chat/ShareFileViewer'), () => ({ ShareFileView: stub('share-file') }))
mock.module(resolve(mobile, 'components/team-chat/AgentWorkingBanner'), () => ({ AgentWorkingBanner: stub('agent-working') }))
mock.module(resolve(mobile, 'components/team-chat/ConversationHeader'), () => ({ ConversationHeader: stub('header') }))
mock.module(resolve(mobile, 'components/notifications/ChatPermissionNudge'), () => ({ ChatPermissionNudge: stub('nudge') }))
mock.module(resolve(mobile, 'components/team-chat/Huddle'), () => ({ HuddleBanner: stub('huddle') }))
mock.module(resolve(mobile, 'components/team-chat/ProjectSidePane'), () => ({ ProjectSidePane: stub('project-pane') }))
mock.module(resolve(mobile, 'components/team-chat/FilesPane'), () => ({ FilesPane: stub('files-pane') }))
mock.module(resolve(mobile, 'components/team-chat/DocPane'), () => ({ DocPane: stub('doc-pane') }))
mock.module(resolve(mobile, 'components/team-chat/UserProfilePane'), () => ({ UserProfilePane: stub('profile-pane') }))
mock.module(resolve(mobile, 'components/team-chat/ChannelTabs'), () => ({
  ChannelTabs: stub('tabs'),
  channelSupportsDoc: () => false,
  channelTabItems: () => [],
}))
mock.module(resolve(mobile, 'components/team-chat/SidePaneResizer'), () => ({
  SidePaneResizeHandle: stub('resizer'),
  useSidePaneWidth: () => ({ width: 420, setWidth: () => {}, commit: () => {}, reset: () => {} }),
}))
mock.module(resolve(mobile, 'components/boards/BoardKanban'), () => ({ BoardKanban: stub('board') }))
mock.module(resolve(mobile, 'components/boards/CardPane'), () => ({ CardPane: stub('card-pane') }))
mock.module(resolve(mobile, 'components/boards/NewBoardSheet'), () => ({ NewBoardSheet: stub('new-board') }))
mock.module(resolve(mobile, 'hooks/useWorkBoards'), () => ({ useChannelBoards: () => ({ boards: [] }) }))
mock.module(resolve(mobile, 'lib/platform-config'), () => ({ usePlatformConfig: () => ({ features: {} }) }))
mock.module(resolve(mobile, 'components/layout/PhoneChromeOverlay'), () => ({
  usePhoneChromeOverlay: () => ({ overlay: false, bottom: 0 }),
}))

mock.module(resolve(mobile, 'components/team-chat/TimelinePane'), () => {
  const { MessageQuoteCard } = require(resolve(mobile, 'components/team-chat/MessageQuoteCard')) as typeof import('../../../../components/team-chat/MessageQuoteCard')
  return {
    // The timeline offers the reply that opens B; the open thread shows a quote
    // card pointing at B, which is the click that stacked the screens.
    TimelinePane: (props: { threadRootId?: string | null; onOpenThread?: (message: unknown) => void }) =>
      createElement(
        'div',
        { 'data-testid': props.threadRootId ? 'thread-pane' : 'main-pane', 'data-thread': props.threadRootId ?? '' },
        props.onOpenThread
          ? createElement('button', { onClick: () => props.onOpenThread!({ id: 'B', threadRootId: null }) }, 'reply-in-thread')
          : createElement(MessageQuoteCard, {
              names: {},
              quote: { href: 'https://studio.shogo.ai/c/c1?msg=m-1&thread=B', target: { conversationId: 'c1', messageId: 'm-1', threadRootId: 'B' } },
            }),
      ),
  }
})

const { default: ConversationScreen } = await import('../[conversationId]')

const threadPanes = () => screen.queryAllByTestId('thread-pane')
const threadShown = () => threadPanes().map((pane) => pane.getAttribute('data-thread'))

describe('one thread at a time', () => {
  beforeEach(() => {
    params = { conversationId: 'c1', thread: 'A' }
    pushes.length = 0
    setParamsCalls.length = 0
  })
  afterEach(() => cleanup())

  test('a quote card inside the open thread swaps it out: no new screen, B on screen', async () => {
    const { rerender } = render(createElement(ConversationScreen))
    await screen.findByText('Ana Lopez')
    expect(threadShown()).toEqual(['A'])

    fireEvent.click(screen.getByTestId('message-quote'))
    rerender(createElement(ConversationScreen))

    // Nothing pushed — the nav stack did not grow — and the pane is B.
    expect(pushes).toEqual([])
    expect(setParamsCalls.at(-1)).toMatchObject({ thread: 'B' })
    expect(threadPanes()).toHaveLength(1)
    expect(threadShown()).toEqual(['B'])
  })

  test('a reply in the open thread swaps that thread out instead of stacking', async () => {
    render(createElement(ConversationScreen))
    await screen.findByText('reply-in-thread')

    fireEvent.click(screen.getByText('reply-in-thread'))

    expect(pushes).toEqual([])
    expect(setParamsCalls.at(-1)).toMatchObject({ thread: 'B' })
  })

  test('one thread pane shows B, and A is gone', async () => {
    const { rerender } = render(createElement(ConversationScreen))
    await screen.findByText('reply-in-thread')
    expect(threadShown()).toEqual(['A'])

    fireEvent.click(screen.getByText('reply-in-thread'))
    rerender(createElement(ConversationScreen))

    expect(threadPanes()).toHaveLength(1)
    expect(threadShown()).toEqual(['B'])
  })

  test('opening a thread from a channel with none still pushes, so Back closes it', async () => {
    params = { conversationId: 'c1' }
    render(createElement(ConversationScreen))
    await screen.findByText('reply-in-thread')
    expect(threadPanes()).toHaveLength(0)

    fireEvent.click(screen.getByText('reply-in-thread'))

    expect(setParamsCalls).toEqual([])
    expect(pushes).toEqual([{ pathname: '/(app)/c/[conversationId]', params: { conversationId: 'c1', thread: 'B' } }])
  })
})
