// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

let chat: any
const here = fileURLToPath(new URL('.', import.meta.url))

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Pressable: ({ accessibilityLabel, children, onPress, 'aria-expanded': expanded }: any) =>
      createElement('button', { 'aria-label': accessibilityLabel, 'aria-expanded': expanded, onClick: onPress }, children),
  } as any),
)
mock.module('expo-router', () => ({ useRouter: () => ({ push: () => {} }) }))
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }))
mock.module('lucide-react-native', () => {
  const Icon = () => createElement('span')
  return {
    Bell: Icon, Bot: Icon, ChevronDown: Icon, ChevronRight: Icon, Hash: Icon, Keyboard: Icon, Lock: Icon,
    NotebookText: Icon, Pencil: Icon, Plus: Icon, Radio: Icon, Search: Icon, Users: Icon,
  }
})
mock.module(resolve(here, '../TeamChatSidebarProvider'), () => ({ useTeamChatNav: () => chat }))
mock.module(resolve(here, '../PresenceDot'), () => ({ PresenceDot: () => null }))
mock.module(resolve(here, '../InlineMarkdown'), () => ({ InlineMarkdown: ({ children }: any) => children }))
mock.module(resolve(here, '../../../hooks/useChatItems'), () => ({ useHasDraft: () => false }))
mock.module(resolve(here, '../../../lib/team-chat-api'), () => ({
  conversationTitle: (c: any) => c.name ?? 'DM',
  isSelfDm: () => false,
}))

const { ChannelsPanel } = await import('../panels/ChannelsPanel')

const channel = (id: string, over: Record<string, unknown> = {}) => ({
  id, workspaceId: 'w1', kind: 'public', name: id, slug: id, topic: null, lastSeq: 1, lastMessageAt: null,
  archivedAt: null, createdAt: '2026-09-01T00:00:00Z', joined: true, starred: false, muted: false,
  notifyLevel: 'all', lastReadSeq: 1, unreadCount: 0, mentionCount: 0, ...over,
})

function setChat(list: any[], activeId: string | null = null) {
  chat = {
    enabled: true, workspaceId: 'w1', list, activeId,
    openConversation: mock((_c: any) => {}), startCreate: () => {}, openShortcuts: () => {},
  }
}

beforeEach(() => setChat([]))

describe('ChannelsPanel archived channels', () => {
  test('sit collapsed under their own label, apart from live channels', () => {
    setChat([
      channel('eng'),
      channel('old-launch', { archivedAt: '2026-10-01T00:00:00Z' }),
      channel('q3-plan', { archivedAt: '2026-10-04T00:00:00Z', joined: false }),
    ])
    render(<ChannelsPanel />)
    const toggle = screen.getByLabelText('Expand Archived (2)')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByLabelText('eng')).toBeTruthy()
    expect(screen.queryByLabelText('old-launch')).toBeNull()

    fireEvent.click(toggle)
    const rows = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))
    expect(rows.indexOf('q3-plan')).toBeLessThan(rows.indexOf('old-launch'))
    expect(rows.indexOf('eng')).toBeLessThan(rows.indexOf('Collapse Archived (2)'))
    expect(rows.indexOf('Collapse Archived (2)')).toBeLessThan(rows.indexOf('q3-plan'))
  })

  test('open like any other channel', () => {
    setChat([channel('old-launch', { archivedAt: '2026-10-01T00:00:00Z' })])
    render(<ChannelsPanel />)
    fireEvent.click(screen.getByLabelText('Expand Archived (1)'))
    fireEvent.click(screen.getByLabelText('old-launch'))
    expect(chat.openConversation).toHaveBeenCalledTimes(1)
    expect(chat.openConversation.mock.calls[0][0].id).toBe('old-launch')
  })

  test('start open when you are in one of them', () => {
    setChat([channel('eng'), channel('old-launch', { archivedAt: '2026-10-01T00:00:00Z' })], 'old-launch')
    render(<ChannelsPanel />)
    expect(screen.getByLabelText('Collapse Archived (1)').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText('old-launch')).toBeTruthy()
  })

  test('no label at all when nothing is archived', () => {
    setChat([channel('eng'), channel('dm-1', { kind: 'dm', name: null, archivedAt: '2026-10-01T00:00:00Z' })])
    render(<ChannelsPanel />)
    expect(screen.queryByLabelText(/Archived/)).toBeNull()
  })
})
