// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The two ways into "Messages from <member>" that live in the channel header
 * (SHO-419): the "Filter by member" action, and the "Messages" action on each
 * row of the Members list. Both hand the host a `from` key the pane opens with.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import { inviteDialogContextStub, invitePermissionsStub, inviteStub } from '../../../test/invite-dialog-stub'
import type { ConversationDetail } from '../../../lib/team-chat-api'

const Pressable = ({ onPress, accessibilityLabel, disabled, children }: Record<string, any>) =>
  createElement('button', { 'aria-label': accessibilityLabel, onClick: disabled ? undefined : onPress }, children as ReactNode)

// The Members modal's search box drives `filter` through `onChangeText`; the
// passthrough host does not wire it, so the invite row could never appear.
const TextInput: any = ({ value, onChangeText, placeholder }: Record<string, any>) =>
  createElement('input', {
    value,
    placeholder,
    onChange: (e: any) => onChangeText?.(e.target.value),
  })

mock.module('react-native', () => createReactNativeMock({ Pressable, TextInput }))
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
// The header offers "Invite people" through the app shell's dialog (SHO-454);
// these tests render it on its own, so stub the context and the permissions
// hook it reads `canInvite` from.
mock.module(resolve(import.meta.dir, '../../workspace/invite-dialog-context'), inviteDialogContextStub)
mock.module(resolve(import.meta.dir, '../../../hooks/usePermissions'), invitePermissionsStub)

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

const onOpenMemberMessages = mock((_from: string) => {})

const renderHeader = () =>
  render(
    <ConversationHeader
      conversation={conversation}
      mentionables={{ people: [], agents: [], groups: [] } as any}
      me="u-ada"
      onChanged={() => {}}
      onLeft={() => {}}
      onOpenMemberMessages={onOpenMemberMessages}
    />,
  )

afterEach(() => {
  cleanup()
  inviteStub.reset()
})
beforeEach(() => onOpenMemberMessages.mockClear())

describe('ConversationHeader — filter by member', () => {
  test('the header action opens the pane on you, so the switcher is already showing a list', () => {
    renderHeader()
    fireEvent.click(screen.getByLabelText('Filter by member'))
    expect(onOpenMemberMessages).toHaveBeenCalledWith('user:u-ada')
  })

  test('the Members list offers "Messages" on every member, people and agents alike', () => {
    renderHeader()
    fireEvent.click(screen.getByLabelText('Members'))
    fireEvent.click(screen.getByLabelText('Messages from Alpha'))
    expect(onOpenMemberMessages).toHaveBeenCalledWith('agent:p-alpha')

    fireEvent.click(screen.getByLabelText('Members'))
    fireEvent.click(screen.getByLabelText('Messages from Shogo'))
    expect(onOpenMemberMessages).toHaveBeenCalledWith('agent:ws')
  })

  // SHO-454 acceptance 4: an address that is not a member is an invitation,
  // not a dead end.
  test('an email that is nobody here offers to invite them, with the address filled in', () => {
    inviteStub.canInvite = true
    renderHeader()
    fireEvent.click(screen.getByLabelText('Members'))
    fireEvent.change(screen.getByPlaceholderText('Search people and agents'), {
      target: { value: 'new@example.com' },
    })

    fireEvent.click(screen.getByText('Invite new@example.com'))
    expect(inviteStub.opened).toEqual([{ workspaceId: 'w-1', emails: ['new@example.com'] }])
  })

  test('no invite row when the caller cannot invite', () => {
    inviteStub.canInvite = false
    renderHeader()
    fireEvent.click(screen.getByLabelText('Members'))
    fireEvent.change(screen.getByPlaceholderText('Search people and agents'), {
      target: { value: 'new@example.com' },
    })
    expect(screen.queryByText('Invite new@example.com')).toBeNull()
  })
})
