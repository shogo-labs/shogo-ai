// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-589: opening a file that lives inside a card must not close the card.
 *
 * The file opener used to clear `card` from the URL, so a `share_file` chip in a
 * card's description or thread swapped the card for the file and closing the
 * file dropped Russell back on the timeline — and at a width with room for
 * both he never saw the image beside the card at all.
 *
 * This mounts the real conversation screen (real `ShareFileProvider`, real
 * `resolvePanes`) with `?card=…` open and clicks a file chip inside the card:
 * wide, the file pane appears beside the card pane and `card` is still in the
 * params; on a phone the file takes the screen; closing it shows the card again
 * either way.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../../test/react-native-mock'
import * as lucideStub from '../../../../test/stubs/lucide-react-native'

const mobile = resolve(import.meta.dir, '../../../..')

/** The width the screen lays out at; each test picks the window it is testing. */
let windowWidth = 1500

/** The params the screen is mounted with; `setParams` merges into it. */
let params: Record<string, string | undefined> = {}
const setParamsCalls: Array<Record<string, unknown>> = []

mock.module('react-native', () =>
  createReactNativeMock({
    useWindowDimensions: () => ({ width: windowWidth, height: 900, scale: 1, fontScale: 1 }),
    // The shared mock forwards props to the DOM, but `onPress` is not a DOM
    // handler — a shim that wires it to onClick is what makes a tap testable.
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
    push: () => {},
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
  useNavigation: () => ({
    getState: () => ({ index: 0, routes: [{ name: 'c/[conversationId]', params: { conversationId: 'c1' } }] }),
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
  }),
}))
// The file pane itself is not what this test is about: it is a stub with the
// real close button, so the pane's presence is what gets asserted.
mock.module(resolve(mobile, 'components/chat/ShareFileViewer'), () => ({
  ShareFileView: ({ target, onClose }: { target: { name: string }; onClose?: () => void }) =>
    createElement(
      'div',
      { 'data-testid': 'share-file', 'data-file': target.name },
      onClose ? createElement('button', { onClick: onClose }, 'close-file') : null,
    ),
  // `share-file-context` renders the modal host for screens without a pane.
  ShareFileSheet: ({ target, onClose }: { target: unknown; onClose?: () => void }) =>
    target ? createElement('button', { onClick: onClose }, 'close-sheet') : null,
}))
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
  channelSupportsTabs: () => false,
  channelTabItems: () => [],
}))
// 420 is the card width and the file width in these tests, so a 1500-wide
// window fits timeline + card + file and a 1024-wide one does not.
mock.module(resolve(mobile, 'components/layout/SidePaneResizer'), () => ({
  SidePaneResizeHandle: stub('resizer'),
  useSidePaneWidth: () => ({ width: 420, setWidth: () => {}, commit: () => {}, reset: () => {} }),
}))
mock.module(resolve(mobile, 'components/boards/BoardKanban'), () => ({ BoardKanban: stub('board') }))
mock.module(resolve(mobile, 'components/boards/NewBoardSheet'), () => ({ NewBoardSheet: stub('new-board') }))
mock.module(resolve(mobile, 'hooks/useWorkBoards'), () => ({ useChannelBoards: () => ({ boards: [] }) }))
mock.module(resolve(mobile, 'lib/platform-config'), () => ({ usePlatformConfig: () => ({ features: {} }) }))
mock.module(resolve(mobile, 'components/layout/PhoneChromeOverlay'), () => ({
  usePhoneChromeOverlay: () => ({ overlay: false, bottom: 0 }),
}))
mock.module(resolve(mobile, 'components/team-chat/TimelinePane'), () => ({ TimelinePane: stub('main-pane') }))

// The real card pane is a heavy screen of its own; what matters here is that it
// is on screen, and that a file chip inside it reaches the screen's opener.
mock.module(resolve(mobile, 'components/boards/CardPane'), () => {
  const { useShareFileOpener } = require(resolve(mobile, 'components/chat/share-file-context')) as typeof import('../../../../components/chat/share-file-context')
  return {
    CardPane: ({ itemId, onClose }: { itemId: string; onClose?: () => void }) => {
      const open = useShareFileOpener()
      return createElement(
        'div',
        { 'data-testid': 'card-pane', 'data-card': itemId },
        open
          ? createElement(
              'button',
              {
                'data-testid': 'card-file-chip',
                onClick: () => open({ kind: 'share', href: '/api/f/tok', name: 'receipt.png' }),
              },
              'receipt.png',
            )
          : null,
        onClose ? createElement('button', { onClick: onClose }, 'close-card') : null,
      )
    },
  }
})

const { default: ConversationScreen } = await import('../[conversationId]')

const cardPane = () => screen.queryByTestId('card-pane')
// The pane is the screen's own `View`, whose `testID` the react-native mock
// forwards to the DOM as `testid` rather than `data-testid`.
const filePane = () =>
  document.querySelector('[data-testid="chat-file-pane"], [testid="chat-file-pane"]')
/** The user closed the file: the params lose `file` and keep everything else. */
const click = async (label: string, rerender: () => void) => {
  fireEvent.click(screen.getByText(label))
  rerender()
  await Promise.resolve()
}
const openCardFile = async (rerender: () => void) => {
  fireEvent.click(screen.getByTestId('card-file-chip'))
  rerender()
  await Promise.resolve()
}

describe('a file opened from a card (SHO-589)', () => {
  beforeEach(() => {
    windowWidth = 1500
    params = { conversationId: 'c1', card: 'card-1' }
    setParamsCalls.length = 0
  })
  afterEach(() => cleanup())

  test('wide: the file opens beside the card and the card stays', async () => {
    const { rerender } = render(createElement(ConversationScreen))
    await screen.findByTestId('card-pane')
    expect(filePane()).toBeNull()
    expect(setParamsCalls).toEqual([])

    await openCardFile(() => rerender(createElement(ConversationScreen)))

    // The opener keeps `card`: it is not cleared on the way to the file.
    expect(setParamsCalls.at(-1)).toMatchObject({ file: '/api/f/tok' })
    expect(setParamsCalls.at(-1) ?? {}).not.toHaveProperty('card')
    expect(params.card).toBe('card-1')
    expect(cardPane()).not.toBeNull()
    expect(filePane()).not.toBeNull()
  })

  test('wide: closing the file leaves the card open', async () => {
    const { rerender } = render(createElement(ConversationScreen))
    await screen.findByTestId('card-pane')
    await openCardFile(() => rerender(createElement(ConversationScreen)))

    await click('close-file', () => rerender(createElement(ConversationScreen)))

    expect(params.file).toBeUndefined()
    expect(params.card).toBe('card-1')
    expect(cardPane()).not.toBeNull()
    expect(filePane()).toBeNull()
  })

  test('narrow: the file takes the card’s place, and closing it brings the card back', async () => {
    windowWidth = 1024
    const { rerender } = render(createElement(ConversationScreen))
    await screen.findByTestId('card-pane')

    await openCardFile(() => rerender(createElement(ConversationScreen)))
    expect(params.card).toBe('card-1')
    expect(filePane()).not.toBeNull()
    expect(cardPane()).toBeNull()

    await click('close-file', () => rerender(createElement(ConversationScreen)))
    expect(cardPane()).not.toBeNull()
    expect(filePane()).toBeNull()
  })

  test('phone: the file opens full, and back returns to the card, not the timeline', async () => {
    windowWidth = 390
    const { rerender } = render(createElement(ConversationScreen))
    await screen.findByTestId('card-pane')

    await openCardFile(() => rerender(createElement(ConversationScreen)))
    expect(params.card).toBe('card-1')
    expect(filePane()).not.toBeNull()
    expect(cardPane()).toBeNull()
    expect(screen.queryByTestId('main-pane')).toBeNull()

    await click('close-file', () => rerender(createElement(ConversationScreen)))
    expect(cardPane()).not.toBeNull()
    expect(filePane()).toBeNull()
  })

  test('closing the card while a file is open leaves the file where it is', async () => {
    const { rerender } = render(createElement(ConversationScreen))
    await screen.findByTestId('card-pane')
    await openCardFile(() => rerender(createElement(ConversationScreen)))

    await click('close-card', () => rerender(createElement(ConversationScreen)))

    expect(params.card).toBeUndefined()
    expect(cardPane()).toBeNull()
    expect(filePane()).not.toBeNull()
  })
})
