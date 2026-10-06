// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../../test/react-native-mock'

const pushed: unknown[] = []
const created: unknown[] = []
let sessions: any[] = []

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Pressable: ({ accessibilityLabel, children, onPress }: any) =>
      createElement('div', { role: 'button', 'aria-label': accessibilityLabel, onClick: onPress }, children),
  } as any),
)
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }))
mock.module('expo-router', () => ({
  useRouter: () => ({ push: (p: unknown) => pushed.push(p) }),
  usePathname: () => '/agent',
  useFocusEffect: (fn: () => void) => {
    const { useEffect } = require('react')
    useEffect(fn, [fn])
  },
}))
// The hook is covered on its own; here it is the seam to the API.
mock.module('../../../../hooks/useWorkspaceChatHistory', () => {
  return {
    useWorkspaceChatHistory: () => ({
      chats: sessions.filter((s) => !s.isPrimary),
      loading: false,
      creating: false,
      reload: async () => {},
      createChat: async () => {
        created.push('ws-1')
        return 'new-chat'
      },
    }),
  }
})
mock.module('../../../../hooks/useHomeSignals', () => ({ useHomeSignals: () => ({ chat: {}, running: [], failed: [], mentions: [], starred: [], openEntry() {} }) }))
mock.module('../../../../hooks/useWorkspaceExperience', () => ({ useWorkspaceExperience: () => ({ kind: 'team' }) }))
mock.module('../../../../lib/platform-config', () => ({ usePlatformConfig: () => ({ features: {} }) }))
mock.module('../../../activity/ActivityFeed', () => ({ RunningNow: () => null }))
mock.module('../NavItem', () => ({ NavItem: () => null }))
mock.module('../../../team-chat/TeamChatSidebarProvider', () => ({ useTeamChatNav: () => ({}) }))
mock.module('../../../team-chat/ConversationRows', () => ({
  PanelSection: ({ label, addLabel, onAdd, children }: any) =>
    createElement('div', null, createElement('span', null, label), createElement('button', { 'aria-label': addLabel, onClick: onAdd }), children),
  PanelLink: () => null,
  ConversationRow: () => null,
}))

const { WorkspaceChatHistory } = await import('../TabPanels')

afterEach(() => {
  cleanup()
  pushed.length = 0
  created.length = 0
  sessions = []
})

describe('WorkspaceChatHistory', () => {
  test('lists the user\'s chats and opens one', async () => {
    sessions = [
      { id: 'main', isPrimary: true, name: 'Chat' },
      { id: 'c1', name: 'Quarterly report', lastActiveAt: '2026-10-02T00:00:00Z' },
    ]
    render(<WorkspaceChatHistory />)
    fireEvent.click(await screen.findByLabelText('Quarterly report'))
    expect(pushed).toEqual([{ pathname: '/(app)/side-chats/[id]', params: { id: 'c1' } }])
    expect(screen.queryByLabelText('Chat')).toBeNull()
  })

  test('New chat creates a chat in the workspace and opens it', async () => {
    const closed = mock(() => {})
    render(<WorkspaceChatHistory onNavPress={closed} />)
    await screen.findByText(/No chats yet/)
    fireEvent.click(screen.getByLabelText('New chat'))
    await waitFor(() => expect(pushed).toEqual([{ pathname: '/(app)/side-chats/[id]', params: { id: 'new-chat' } }]))
    expect(created).toEqual(['ws-1'])
    expect(closed).toHaveBeenCalled()
  })
})
