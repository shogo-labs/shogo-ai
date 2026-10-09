// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const pushed: string[] = []
let showMarketplace = true

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Pressable: ({ accessibilityLabel, children, onPress, disabled }: any) =>
      createElement('div', { role: 'button', 'aria-label': accessibilityLabel, onClick: disabled ? undefined : onPress }, children),
  } as any),
)
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }))
mock.module('expo-router', () => ({ useRouter: () => ({ push: (p: string) => pushed.push(p) }) }))
mock.module('../../../hooks/useAgentActivity', () => ({ useAgentActivity: () => ({ tasks: [], activeChats: [] }) }))
mock.module('../../../hooks/useTeamChat', () => ({ invalidateConversationList() {} }))
mock.module('../../../hooks/useWorkspaceExperience', () => ({ useWorkspaceExperience: () => ({ kind: 'team', showMarketplace }) }))
mock.module('../TeamChatSidebarProvider', () => ({
  useTeamChatNav: () => ({ enabled: true, workspaceId: 'ws-1', mentionables: { agents: [], people: [] }, startCreate() {}, openConversation() {} }),
}))
mock.module('../AgentProfileCard', () => ({ AgentAvatar: () => null, AgentProfileCard: () => null }))
mock.module('../ConversationRows', () => ({
  PanelSection: ({ children }: any) => createElement('div', null, children),
  PanelLink: ({ label, onPress }: any) => createElement('div', { role: 'button', 'aria-label': label, onClick: onPress }, label),
}))

const { AgentsPanel } = await import('../panels/AgentsPanel')

afterEach(() => {
  cleanup()
  pushed.length = 0
  showMarketplace = true
})

describe('AgentsPanel', () => {
  test('Create agent opens the new-project chat home; Add agent opens the marketplace', () => {
    const closed = mock(() => {})
    render(<AgentsPanel onNavPress={closed} />)
    fireEvent.click(screen.getByLabelText('Create agent'))
    expect(pushed).toEqual(['/(app)/new-project'])
    fireEvent.click(screen.getByLabelText('Add agent'))
    expect(pushed).toEqual(['/(app)/new-project', '/(app)/marketplace'])
    expect(closed).toHaveBeenCalledTimes(2)
  })

  test('Create agent stays available when the marketplace is hidden', () => {
    showMarketplace = false
    render(<AgentsPanel />)
    expect(screen.getByLabelText('Create agent')).toBeTruthy()
    expect(screen.queryByLabelText('Add agent')).toBeNull()
  })
})
