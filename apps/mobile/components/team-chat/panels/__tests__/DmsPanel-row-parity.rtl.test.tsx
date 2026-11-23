// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-537: an agent and a person are the same row in the DMs panel.
 *
 * The point of this file is that it does NOT stub `ConversationRows`: both
 * kinds are rendered by the real `ChatRowView`, so the assertions compare the
 * two rows' actual output — the same row classes, the same start-slot width,
 * the same title classes — in the compact sidebar and at phone density.
 *
 *   bun test apps/mobile/components/team-chat/panels/__tests__/DmsPanel-row-parity.rtl.test.tsx
 */
import { resolve } from 'node:path'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../../test/react-native-mock'

let viewport = { width: 1024, height: 768, scale: 1, fontScale: 1 }
let chat: any
let recentAgentChats: any[]

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web' },
    useWindowDimensions: () => viewport,
    Pressable: ({ accessibilityLabel, accessibilityRole, testID, children, onPress, ...props }: any) =>
      createElement('button', { ...props, 'data-testid': testID, 'aria-label': accessibilityLabel, onClick: onPress, role: accessibilityRole }, children),
  }),
)
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  Avatar: () => createElement('span'),
}))
mock.module('lucide-react-native', () => {
  const Icon = () => createElement('span')
  return { Bot: Icon, ChevronDown: Icon, ChevronRight: Icon, Hash: Icon, Lock: Icon, Mail: Icon, Pencil: Icon, Plus: Icon, Radio: Icon, Users: Icon }
})
mock.module(resolve(import.meta.dir, '../../PresenceDot'), () => ({
  PresenceDot: () => createElement('span'),
}))
mock.module(resolve(import.meta.dir, '../../AgentAvatar'), () => ({
  AgentAvatar: ({ name, size }: any) => createElement('span', { 'data-testid': 'agent-avatar', 'data-name': name, 'data-size': String(size) }),
}))
mock.module(resolve(import.meta.dir, '../../TeamChatSidebarProvider'), () => ({ useTeamChatNav: () => chat }))
mock.module(resolve(import.meta.dir, '../../../../hooks/useRecentAgentChats'), () => ({
  useRecentAgentChats: () => ({ chats: recentAgentChats, loading: false }),
}))
mock.module('expo-router', () => ({
  useRouter: () => ({ push: () => {} }),
  useFocusEffect: () => {},
}))

const { DmsPanel } = await import('../DmsPanel')

const person = (id: string, name: string) => ({ type: 'user', id, name, image: null })

function convo(over: any = {}) {
  return {
    id: 'c1',
    workspaceId: 'w1',
    kind: 'dm',
    name: null,
    slug: null,
    topic: null,
    lastSeq: 1,
    lastMessageAt: '2026-10-01T10:00:00Z',
    archivedAt: null,
    createdAt: '2026-09-01T00:00:00Z',
    joined: true,
    starred: false,
    muted: false,
    notifyLevel: 'all',
    lastReadSeq: 1,
    unreadCount: 0,
    mentionCount: 0,
    participants: [person('ana', 'Ana Lopez')],
    ...over,
  }
}

const workspaceAgent = { key: 'ws', name: 'Workspace agent', projectId: null, description: null, image: null }

const personRow = () => screen.getByRole('link', { name: 'Ana Lopez' })
const agentRow = () => screen.getByTestId('agent-row')
/** The fixed-width start slot, which is what sets an avatar's size. */
const startWidth = (row: HTMLElement) => (row.firstElementChild as HTMLElement).style.width

beforeEach(() => {
  cleanup()
  viewport = { width: 1024, height: 768, scale: 1, fontScale: 1 }
  recentAgentChats = []
  chat = {
    enabled: true,
    workspaceId: 'w1',
    list: [convo()],
    activeId: null,
    openConversation: () => {},
    startCreate: () => {},
    mentionables: { agents: [workspaceAgent] },
  }
})

describe('DmsPanel — an agent row is a person row (SHO-537)', () => {
  test('in the compact sidebar both rows have the same classes and start slot', () => {
    render(createElement(DmsPanel, {}))

    expect(agentRow().className).toBe(personRow().className)
    expect(agentRow().className).toContain('px-2')
    expect(agentRow().className).toContain('py-1')
    expect(startWidth(agentRow())).toBe('12px')
    expect(startWidth(personRow())).toBe('12px')
    expect(screen.getByText('Workspace agent').className).toBe(screen.getByText('Ana Lopez').className)
  })

  test('at phone density both rows are the phone row, with the same bigger slot', () => {
    viewport = { width: 390, height: 844, scale: 1, fontScale: 1 }
    render(createElement(DmsPanel, {}))

    expect(agentRow().className).toBe(personRow().className)
    expect(agentRow().className).toContain('min-h-12')
    expect(startWidth(agentRow())).toBe('22px')
    expect(startWidth(personRow())).toBe('22px')
  })

  test('the agent avatar is the size of a person row slot, not its own', () => {
    render(createElement(DmsPanel, {}))

    expect(screen.getByTestId('agent-avatar').getAttribute('data-size')).toBe('12')
  })

  test('the compact sidebar keeps agent rows to one line', () => {
    render(createElement(DmsPanel, {}))

    expect(screen.queryByText('Start a chat')).toBeNull()
  })

  test('on the phone screen both rows carry a second line', () => {
    chat.list = [convo({ lastMessage: { preview: 'see you at 5', authorId: 'ana', authorType: 'user', createdAt: '2026-10-01T10:00:00Z' } })]
    const { container } = render(createElement(DmsPanel, { variant: 'screen' }))

    expect(container.querySelector('[data-rn-shim="conversation-preview"]')?.textContent).toBe('see you at 5')
    expect(screen.getByText('Start a chat')).toBeTruthy()
  })

  test('an agent with a history says which chat it was, even in the sidebar', () => {
    recentAgentChats = [
      {
        chatSessionId: 's1',
        title: 'Ship the migration',
        projectId: null,
        agentKey: 'ws',
        agentName: null,
        lastActiveAt: new Date().toISOString(),
        preview: null,
      },
    ]
    render(createElement(DmsPanel, {}))

    expect(screen.queryByText(/Ship the migration/)).toBeNull()
    expect(agentRow().getAttribute('aria-label')).toContain('Ship the migration')
  })
})
