// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * RTL tests for the Agents section and chip added in SHO-473 (AC §7).
 *
 *   bun test apps/mobile/components/team-chat/panels/__tests__/DmsPanel-agents.rtl.test.tsx
 */

import { resolve } from 'node:path'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../../test/react-native-mock'

let chat: any
let recentChats: any[]

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web' },
    Pressable: ({ accessibilityLabel, accessibilityRole, children, onPress, ...props }: any) =>
      createElement('button', { ...props, 'aria-label': accessibilityLabel, onClick: onPress, role: accessibilityRole }, children),
  }),
)
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' '), Avatar: () => createElement('span') }))
mock.module('lucide-react-native', () => ({ Plus: () => createElement('span'), ChevronRight: () => createElement('span') }))
mock.module(resolve(import.meta.dir, '../../PresenceDot'), () => ({ PresenceDot: () => createElement('span') }))
mock.module(resolve(import.meta.dir, '../../ConversationRows'), () => ({
  ConversationRow: ({ conversation }: any) => createElement('div', { 'data-testid': `row-${conversation.id}` }),
  PanelSection: ({ label, children }: any) => createElement('section', { 'data-section': label }, createElement('h3', null, label), children),
  PanelLink: ({ label, onPress }: any) => createElement('button', { onClick: onPress }, label),
  CountPill: () => createElement('span'),
  attentionCount: () => 0,
  rowTitle: (c: any) => c.name ?? c.id,
}))
mock.module(resolve(import.meta.dir, '../../TeamChatSidebarProvider'), () => ({ useTeamChatNav: () => chat }))
mock.module(resolve(import.meta.dir, '../../../hooks/useRecentAgentChats'), () => ({
  useRecentAgentChats: () => ({ chats: recentChats, loading: false }),
}))
mock.module(resolve(import.meta.dir, '../../../lib/activity-feed'), () => ({
  relativeTime: () => '2h ago',
}))
mock.module(resolve(import.meta.dir, '../../AgentAvatar'), () => ({
  AgentAvatar: ({ name }: any) => createElement('span', { 'data-testid': `avatar-${name}` }),
}))
mock.module('expo-router', () => ({
  useRouter: () => ({ push: () => {} }),
}))

const { DmsPanel } = await import('../DmsPanel')

function agent(key: string, name: string, projectId: string | null = null) {
  return { key, name, projectId }
}

function recentChat(sessionId: string, agentKey: string, projectId: string | null, title: string) {
  return {
    chatSessionId: sessionId,
    title,
    projectId,
    agentKey,
    agentName: projectId ? `Bot-${agentKey}` : null,
    lastActiveAt: new Date().toISOString(),
    preview: null,
  }
}

beforeEach(() => {
  cleanup()
  recentChats = []
  chat = {
    enabled: true,
    workspaceId: 'w1',
    list: [],
    activeId: null,
    openConversation: () => {},
    startCreate: () => {},
    mentionables: { agents: [] },
  }
})

describe('DmsPanel — Agents chip (SHO-473)', () => {
  test('shows the Agents chip in the filter row', () => {
    render(createElement(DmsPanel, {}))
    expect(screen.getByRole('button', { name: 'Agents' })).toBeTruthy()
  })

  test('Agents chip is present alongside People, All and Unreads', () => {
    render(createElement(DmsPanel, {}))
    expect(screen.getByRole('button', { name: 'All' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'People' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Unreads' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Agents' })).toBeTruthy()
  })

  test('Agents section appears with known agents when Agents chip is selected', () => {
    chat.mentionables = { agents: [agent('ws', 'Workspace agent', null), agent('p1', 'My Bot', 'p1')] }
    render(createElement(DmsPanel, {}))

    fireEvent.click(screen.getByRole('button', { name: 'Agents' }))

    expect(screen.getByText('Agents')).toBeTruthy()
    expect(screen.getByText('Workspace agent')).toBeTruthy()
    expect(screen.getByText('My Bot')).toBeTruthy()
  })

  test('Agents section is not shown on the People chip', () => {
    chat.mentionables = { agents: [agent('ws', 'Workspace agent', null)] }
    render(createElement(DmsPanel, {}))

    fireEvent.click(screen.getByRole('button', { name: 'People' }))

    expect(screen.queryByText('Workspace agent')).toBeNull()
  })

  test('agent row shows last chat title when chat history exists', () => {
    chat.mentionables = { agents: [agent('ws', 'Workspace agent', null)] }
    recentChats = [recentChat('s1', 'ws', null, 'Help with onboarding')]

    render(createElement(DmsPanel, {}))
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }))

    expect(screen.getByText(/Help with onboarding/)).toBeTruthy()
  })

  test('agent row shows "Start a chat" when no history exists', () => {
    chat.mentionables = { agents: [agent('ws', 'Workspace agent', null)] }
    recentChats = []

    render(createElement(DmsPanel, {}))
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }))

    expect(screen.getByText('Start a chat')).toBeTruthy()
  })

  test('initialFilter=agents opens the Agents view directly', () => {
    chat.mentionables = { agents: [agent('ws', 'Workspace agent', null)] }
    render(createElement(DmsPanel, { initialFilter: 'agents' }))

    expect(screen.getByText('Agents')).toBeTruthy()
    expect(screen.getByText('Workspace agent')).toBeTruthy()
  })

  test('All filter shows agents section when agents exist with chat history', () => {
    chat.mentionables = { agents: [agent('ws', 'Workspace agent', null)] }
    recentChats = [recentChat('s1', 'ws', null, 'My chat')]

    render(createElement(DmsPanel, {}))
    // Default filter is 'all'
    expect(screen.getByText('Agents')).toBeTruthy()
    expect(screen.getByText('Workspace agent')).toBeTruthy()
  })
})
