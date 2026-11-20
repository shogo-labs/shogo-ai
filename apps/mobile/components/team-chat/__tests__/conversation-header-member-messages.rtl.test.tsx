// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The two ways into "Filter by member" that live in the channel header
 * (SHO-419, SHO-458): the "Filter by member" action (which becomes "Clear
 * member filter" when active), and the "Filter" button on each row of the
 * Members list.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import type { ConversationDetail } from '../../../lib/team-chat-api'

const Pressable = ({ onPress, accessibilityLabel, disabled, children }: Record<string, any>) =>
  createElement('button', { 'aria-label': accessibilityLabel, onClick: disabled ? undefined : onPress }, children as ReactNode)

mock.module('react-native', () => createReactNativeMock({ Pressable }))
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }))
mock.module('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
mock.module('expo-router', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, setParams: () => {}, back: () => {}, canGoBack: () => false }),
}))
mock.module(resolve(import.meta.dir, '../../hooks/useChatPrefs'), () => ({ useUserStatus: () => null }))
mock.module(resolve(import.meta.dir, '../../hooks/usePresence'), () => ({ usePresence: () => null }))
mock.module(resolve(import.meta.dir, '../PresenceDot'), () => ({
  PresenceDot: () => null,
  presenceLabel: () => 'online',
}))
mock.module(resolve(import.meta.dir, '../AgentAvatar'), () => ({
  AgentAvatar: ({ name }: { name: string }) => createElement('span', null, `agent:${name}`),
}))
mock.module(resolve(import.meta.dir, '../UserAvatar'), () => ({
  UserAvatar: ({ name }: { name: string }) => createElement('span', null, `user:${name}`),
}))
mock.module(resolve(import.meta.dir, '../Huddle'), () => ({ HuddleButton: () => null }))
mock.module(resolve(import.meta.dir, '../AddToChannelConfirm'), () => ({ confirmsAddToChannel: async () => true }))
mock.module(resolve(import.meta.dir, '../ChannelTabs'), () => ({ ChannelTabList: () => null }))
mock.module(resolve(import.meta.dir, '../FloatingChrome'), () => ({
  CHROME_SIZE: 44,
  GlassButton: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  GlassChip: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))
mock.module(resolve(import.meta.dir, '../ui/LiquidGlassBackdrop'), () => ({ LiquidGlassBackdrop: () => null }))
mock.module(resolve(import.meta.dir, '../../chat/MarkdownText'), () => ({
  MarkdownText: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))
mock.module(resolve(import.meta.dir, '../../chat/WebTooltip'), () => ({
  WebTooltip: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))

const { ConversationHeader } = await import('../ConversationHeader')

const conversation = {
  id: 'c-1',
  kind: 'public',
  name: 'launch',
  slug: 'launch',
  workspaceId: 'w-1',
  topic: null,
  archivedAt: null,
  joined: true,
  muted: false,
  starred: false,
  notifyLevel: 'default',
  canPost: true,
  canReply: true,
  canManage: false,
  canDelete: false,
  hasDoc: false,
  members: [
    { id: 'm-1', type: 'user', userId: 'u-ada', role: 'member', name: 'Ada', image: null },
    { id: 'm-2', type: 'agent', projectId: 'p-alpha', name: 'Alpha', agentTrigger: 'all', agentKeywords: null },
    { id: 'm-3', type: 'agent', projectId: null, name: 'Shogo', agentTrigger: 'all', agentKeywords: null },
  ],
} as unknown as ConversationDetail

const onFilterByMember = mock((_from: string) => {})
const onClearMemberFilter = mock(() => {})

const renderHeader = (memberFilter?: string | null) =>
  render(
    <ConversationHeader
      conversation={conversation}
      mentionables={{ people: [], agents: [], groups: [] } as any}
      me="u-ada"
      onChanged={() => {}}
      onLeft={() => {}}
      onFilterByMember={onFilterByMember}
      onClearMemberFilter={onClearMemberFilter}
      memberFilter={memberFilter}
    />,
  )

afterEach(cleanup)
beforeEach(() => {
  onFilterByMember.mockClear()
  onClearMemberFilter.mockClear()
})

describe('ConversationHeader — filter by member', () => {
  test('the header action starts the filter on you, so the switcher already shows a list', () => {
    renderHeader()
    fireEvent.click(screen.getByLabelText('Filter by member'))
    expect(onFilterByMember).toHaveBeenCalledWith('user:u-ada')
  })

  test('when a filter is active the action reads "Clear member filter" and clears it', () => {
    renderHeader('user:u-ada')
    fireEvent.click(screen.getByLabelText('Clear member filter'))
    expect(onClearMemberFilter).toHaveBeenCalled()
    expect(onFilterByMember).not.toHaveBeenCalled()
  })

  test('the Members list offers "Filter" on every member, people and agents alike', () => {
    renderHeader()
    fireEvent.click(screen.getByLabelText('Members'))
    fireEvent.click(screen.getByLabelText('Filter by Alpha'))
    expect(onFilterByMember).toHaveBeenCalledWith('agent:p-alpha')

    fireEvent.click(screen.getByLabelText('Members'))
    fireEvent.click(screen.getByLabelText('Filter by Shogo'))
    expect(onFilterByMember).toHaveBeenCalledWith('agent:ws')
  })
})
