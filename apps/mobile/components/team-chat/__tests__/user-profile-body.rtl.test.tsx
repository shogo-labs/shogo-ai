// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A person's profile body: who they are, whether they are around, and the two
 * things you can do with them. The huddle case matters most — a huddle lives on
 * a conversation, so it must open the DM first and ring *that*.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const routed: any[] = []
const openedDms: Array<{ workspaceId: string; userIds: string[] }> = []
const huddles: any[] = []

let card: any = {
  id: 'u-ana',
  name: 'Ana Lopez',
  email: 'ana.lopez@example.com',
  handle: 'ana.lopez',
  image: null,
  role: 'admin',
  isSelf: false,
  timezone: 'Asia/Kolkata',
  localTime: '01:07',
  localTimeLabel: '01:07 local time',
  status: null,
}
let cardFails = false
let openDmFails = false
let presence: string | null = 'active'
let liveStatus: any = null
let conversations: any[] = []

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    useWindowDimensions: () => ({ width: 1280, height: 800, scale: 1, fontScale: 1 }),
    Pressable: ({ accessibilityLabel, children, onPress, disabled, testID }: any) =>
      createElement(
        'button',
        {
          'aria-label': accessibilityLabel,
          'data-rn-shim': testID,
          disabled: !!disabled,
          onClick: disabled ? undefined : onPress,
        },
        children,
      ),
  } as any),
)
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }))
mock.module('expo-router', () => ({
  useRouter: () => ({ push: (r: any) => routed.push(r), replace: () => {}, back: () => {}, canGoBack: () => true }),
}))
mock.module('expo-clipboard', () => ({ setStringAsync: async () => {} }))

const realApi = await import('../../../lib/team-chat-api')
type ConversationSummary = import('../../../lib/team-chat-api').ConversationSummary
mock.module('../../../lib/team-chat-api', () => ({
  ...realApi,
  teamChatApi: () => ({
    userCard: async (_ws: string, _userId: string) => {
      if (cardFails) throw new Error('gone')
      return card
    },
    openDm: async (workspaceId: string, userIds: string[]) => {
      openedDms.push({ workspaceId, userIds })
      return openDmFails ? null : { id: 'dm-ana', kind: 'dm', participants: [] }
    },
  }),
}))
mock.module('../../../hooks/useTeamChat', () => ({
  useConversationList: () => ({ list: conversations, loading: false, error: null, refresh: () => {} }),
  useMyUserId: () => 'me',
  invalidateConversationList: () => {},
}))
mock.module('../../../hooks/usePresence', () => ({
  usePresence: () => presence,
  usePresenceFeed: () => {},
}))
mock.module('../../../hooks/useChatPrefs', () => ({
  useUserStatus: () => liveStatus,
  useStatusFeed: () => {},
}))
mock.module('../../../lib/huddle-call', () => ({
  joinHuddleCall: async (input: any) => { huddles.push(input) },
}))

const { UserProfileBody, conversationsWith } = await import('../UserProfileBody')

const dmWith = (
  id: string,
  userId: string,
  name: string,
  kind: 'dm' | 'group_dm' = 'dm',
): ConversationSummary => ({
  id,
  kind,
  name: null,
  participants: [{ type: 'user', id: userId, name, image: null }],
  lastMessageAt: '2026-10-16T10:00:00.000Z',
} as ConversationSummary)

afterEach(() => {
  cleanup()
  routed.length = 0
  openedDms.length = 0
  huddles.length = 0
  cardFails = false
  openDmFails = false
  presence = 'active'
  liveStatus = null
  conversations = []
  card = {
    id: 'u-ana',
    name: 'Ana Lopez',
    email: 'ana.lopez@example.com',
    handle: 'ana.lopez',
    image: null,
    role: 'admin',
    isSelf: false,
    timezone: 'Asia/Kolkata',
    localTime: '01:07',
    localTimeLabel: '01:07 local time',
    status: null,
  }
})

describe('conversationsWith', () => {
  test('keeps only the conversations that include that person, newest first', () => {
    const list = [
      dmWith('c1', 'u-ana', 'Ana Lopez'),
      dmWith('c2', 'u-denis', 'Denis Zhenilov'),
      { ...dmWith('c3', 'u-ana', 'Ana Lopez', 'group_dm'), lastMessageAt: '2026-10-16T12:00:00.000Z' },
    ]
    expect(conversationsWith(list, 'u-ana').map((c) => c.id)).toEqual(['c3', 'c1'])
    expect(conversationsWith(list, 'u-nobody')).toEqual([])
  })
})

describe('UserProfileBody', () => {
  test('says who they are, when they are around, and what time it is for them', async () => {
    render(<UserProfileBody workspaceId="ws" userId="u-ana" />)

    expect(await screen.findByText('Ana Lopez')).toBeTruthy()
    expect(screen.getByText('ana.lopez@example.com')).toBeTruthy()
    expect(screen.getByText('ADMIN')).toBeTruthy()
    expect(screen.getByText('01:07 local time')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
  })

  test('adds snoozed notifications once they are on do-not-disturb', async () => {
    liveStatus = { emoji: '🌴', text: 'On leave', dnd: true }
    render(<UserProfileBody workspaceId="ws" userId="u-ana" />)

    expect(await screen.findByText('Ana Lopez')).toBeTruthy()
    expect(screen.getByText('Active, notifications snoozed')).toBeTruthy()
    expect(screen.getByText('On leave')).toBeTruthy()
    expect(screen.getByText('🌴')).toBeTruthy()
  })

  test('says nothing about presence or time we do not know', async () => {
    presence = null
    card = { ...card, timezone: null, localTime: null, localTimeLabel: null }
    render(<UserProfileBody workspaceId="ws" userId="u-ana" />)

    expect(await screen.findByText('Ana Lopez')).toBeTruthy()
    expect(screen.queryByText('01:07 local time')).toBeNull()
    expect(screen.queryByText('Active')).toBeNull()
    expect(document.querySelector('[data-rn-shim="user-profile-local-time"]')).toBeNull()
  })

  test('Message opens their DM and goes there', async () => {
    render(<UserProfileBody workspaceId="ws" userId="u-ana" />)
    await screen.findByText('Ana Lopez')

    fireEvent.click(document.querySelector('[data-rn-shim="user-profile-message"]')!)
    await new Promise((r) => setTimeout(r, 0))

    expect(openedDms).toEqual([{ workspaceId: 'ws', userIds: ['u-ana'] }])
    expect(routed).toEqual([{ pathname: '/(app)/c/[conversationId]', params: { conversationId: 'dm-ana' } }])
  })

  test('Huddle rings the DM rather than leaving the conversation you are in', async () => {
    render(<UserProfileBody workspaceId="ws" userId="u-ana" />)
    await screen.findByText('Ana Lopez')

    fireEvent.click(document.querySelector('[data-rn-shim="user-profile-huddle"]')!)
    await new Promise((r) => setTimeout(r, 0))

    expect(openedDms).toEqual([{ workspaceId: 'ws', userIds: ['u-ana'] }])
    // Ringing the DM is the point; navigating into it would hide the dock.
    expect(routed).toEqual([])
    expect(huddles).toEqual([
      { conversationId: 'dm-ana', workspaceId: 'ws', label: 'Ana Lopez', kind: 'dm' },
    ])
  })

  test('offers no message or huddle with yourself', async () => {
    card = { ...card, isSelf: true }
    render(<UserProfileBody workspaceId="ws" userId="me" />)

    expect(await screen.findByText('Ana Lopez')).toBeTruthy()
    expect(screen.getByText('YOU')).toBeTruthy()
    expect(document.querySelector('[data-rn-shim="user-profile-message"]')).toBeNull()
    expect(document.querySelector('[data-rn-shim="user-profile-huddle"]')).toBeNull()
    expect(openedDms).toEqual([])
  })

  test('lists only the conversations you already have with them, and opens one', async () => {
    conversations = [
      dmWith('c1', 'u-ana', 'Ana Lopez'),
      dmWith('c2', 'u-denis', 'Denis Zhenilov'),
      {
        ...dmWith('c3', 'u-ana', 'Ana Lopez', 'group_dm'),
        participants: [
          { type: 'user', id: 'u-ana', name: 'Ana Lopez', image: null },
          { type: 'user', id: 'u-denis', name: 'Denis Zhenilov', image: null },
        ],
        lastMessageAt: '2026-10-16T12:00:00.000Z',
      },
    ]
    render(<UserProfileBody workspaceId="ws" userId="u-ana" />)
    await screen.findByText('ana.lopez@example.com')

    expect(await screen.findByText('Ana Lopez, Denis Zhenilov')).toBeTruthy()
    expect(screen.queryByText('Denis Zhenilov')).toBeNull()

    fireEvent.click(screen.getByLabelText('Open conversation with Ana Lopez, Denis Zhenilov'))
    expect(routed).toEqual([{ pathname: '/(app)/c/[conversationId]', params: { conversationId: 'c3' } }])
  })

  test('search for every conversation with them uses the in: operator', async () => {
    render(<UserProfileBody workspaceId="ws" userId="u-ana" />)
    await screen.findByText('Ana Lopez')

    fireEvent.click(screen.getByText('See all conversations with Ana Lopez'))
    expect(routed).toEqual([{ pathname: '/(app)/c/search', params: { q: 'in:@ana.lopez' } }])
  })

  test('says so when the profile cannot be read', async () => {
    cardFails = true
    render(<UserProfileBody workspaceId="ws" userId="u-ana" />)

    expect(await screen.findByText('Couldn’t load this profile.')).toBeTruthy()
  })

  test('says so when the conversation cannot be opened, rather than looking inert', async () => {
    openDmFails = true
    render(<UserProfileBody workspaceId="ws" userId="u-ana" />)
    await screen.findByText('ana.lopez@example.com')

    fireEvent.click(document.querySelector('[data-rn-shim="user-profile-message"]')!)
    expect(await screen.findByText('Couldn’t open that conversation. Try again.')).toBeTruthy()
    expect(routed).toEqual([])

    fireEvent.click(document.querySelector('[data-rn-shim="user-profile-huddle"]')!)
    expect(await screen.findByText('Couldn’t start the huddle. Try again.')).toBeTruthy()
    expect(huddles).toEqual([])
  })
})
