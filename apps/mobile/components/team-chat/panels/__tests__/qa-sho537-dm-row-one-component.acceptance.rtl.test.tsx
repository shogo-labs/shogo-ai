// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-537 acceptance: in the DMs panel an agent and a person are the same row,
 * and people come before agents.
 *
 * `ConversationRows` and `PanelSection` are NOT stubbed, so this file asserts
 * the real row both kinds render, not a stand-in. It covers what the dev's
 * parity test leaves open: pressing an agent still routes to that agent's chat
 * list (AC5) and the two kinds have the same row geometry (AC1) and order (AC3).
 *
 *   bun test apps/mobile/components/team-chat/panels/__tests__/qa-sho537-dm-row-one-component.acceptance.rtl.test.tsx
 */
import { resolve } from 'node:path'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock, reactNativeMockBase } from '../../../../test/react-native-mock'

let viewport = { width: 1024, height: 768, scale: 1, fontScale: 1 }
let chat: any
let recentAgentChats: any[]
const pushes: any[] = []

/** Pressable as a real button, so a row can be clicked and its role/name queried. */
const PressableButton = ({ accessibilityLabel, accessibilityRole, testID, children, onPress, ...props }: any) =>
  createElement('button', { ...props, 'data-testid': testID, 'aria-label': accessibilityLabel, onClick: onPress, role: accessibilityRole }, children)

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { ...reactNativeMockBase.Platform, OS: 'web' },
    useWindowDimensions: () => viewport,
    Pressable: PressableButton as any,
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
mock.module(resolve(import.meta.dir, '../../PresenceDot'), () => ({ PresenceDot: () => createElement('span') }))
mock.module(resolve(import.meta.dir, '../../AgentAvatar'), () => ({
  AgentAvatar: ({ name, size }: any) => createElement('span', { 'data-testid': 'agent-avatar', 'data-name': name, 'data-size': String(size) }),
}))
mock.module(resolve(import.meta.dir, '../../TeamChatSidebarProvider'), () => ({ useTeamChatNav: () => chat }))
mock.module(resolve(import.meta.dir, '../../../../hooks/useRecentAgentChats'), () => ({
  useRecentAgentChats: () => ({ chats: recentAgentChats, loading: false }),
}))
mock.module('expo-router', () => ({
  useRouter: () => ({ push: (to: any) => pushes.push(to) }),
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
const projectAgent = { key: 'p1', name: 'Project agent', projectId: 'p1', description: null, image: null }

const personRow = () => screen.getByRole('link', { name: 'Ana Lopez' })
/** Agent rows are the only rows this panel renders as buttons with a label. */
const agentRow = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) })
/** A row's shape: what it sets on itself and on its two slots. */
const shape = (row: HTMLElement) => ({
  className: row.className,
  slots: [...row.children].map((child) => (child as HTMLElement).className),
  startWidth: (row.firstElementChild as HTMLElement).style.width,
})

const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

beforeEach(() => {
  cleanup()
  pushes.length = 0
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

describe('SHO-537 — an agent row is a person row', () => {
  test('AC1: both rows are the same geometry in the compact sidebar', () => {
    render(createElement(DmsPanel, {}))

    expect(shape(agentRow('Workspace agent') as HTMLElement)).toEqual(shape(personRow() as HTMLElement))
    expect((agentRow('Workspace agent') as HTMLElement).className).toContain('px-2')
    expect((agentRow('Workspace agent') as HTMLElement).className).toContain('py-1')
    // The start slot is what sizes the avatar, and both take it from the row.
    expect((agentRow('Workspace agent') as HTMLElement).firstElementChild).toHaveProperty('style.width', '12px')
    expect(screen.getByTestId('agent-avatar').getAttribute('data-size')).toBe('12')
  })

  test('AC1: both rows are the same geometry at phone density, with the bigger slot', () => {
    viewport = { width: 390, height: 844, scale: 1, fontScale: 1 }
    render(createElement(DmsPanel, {}))

    expect(shape(agentRow('Workspace agent') as HTMLElement)).toEqual(shape(personRow() as HTMLElement))
    expect((agentRow('Workspace agent') as HTMLElement).className).toContain('min-h-12')
    expect(screen.getByTestId('agent-avatar').getAttribute('data-size')).toBe('22')
  })

  test('AC2: the sidebar keeps both rows to one line; the phone screen gives both a second line', () => {
    chat.list = [convo({ lastMessage: { preview: 'see you at 5', authorId: 'ana', authorType: 'user', createdAt: '2026-10-01T10:00:00Z' } })]
    const sidebar = render(createElement(DmsPanel, {}))
    expect(sidebar.container.querySelector('[data-rn-shim="conversation-preview"]')).toBeNull()
    expect(screen.queryByText('Start a chat')).toBeNull()
    sidebar.unmount()

    viewport = { width: 390, height: 844, scale: 1, fontScale: 1 }
    const { container } = render(createElement(DmsPanel, { variant: 'screen' }))
    const preview = container.querySelector('[data-rn-shim="conversation-preview"]') as HTMLElement
    expect(preview.textContent).toBe('see you at 5')
    const subtitle = screen.getByText('Start a chat')
    // The agent's line sits in the same slot, styled the same way, as a person's preview.
    expect(subtitle.className).toBe(preview.parentElement!.className)
  })

  test('AC3: under All, people and New message come before the Agents heading', () => {
    chat.list = [convo({ id: 'ana', starred: true, participants: [person('ana', 'Ana Lopez')] }), convo({ id: 'bob', participants: [person('bob', 'Bob Ray')] })]
    render(createElement(DmsPanel, {}))

    // The section heading, not the "Agents" chip in the filter row above it.
    const heading = screen.getByRole('button', { name: 'Collapse Agents' })
    const agent = agentRow('Workspace agent')
    expect(before(screen.getByRole('link', { name: 'Ana Lopez' }), heading)).toBe(true)
    expect(before(screen.getByRole('link', { name: 'Bob Ray' }), heading)).toBe(true)
    expect(before(screen.getByRole('button', { name: 'New message' }), heading)).toBe(true)
    expect(before(heading, agent)).toBe(true)
  })

  test('AC5: pressing a workspace agent row opens the workspace chat list', () => {
    render(createElement(DmsPanel, {}))
    fireEvent.click(agentRow('Workspace agent'))
    expect(pushes).toEqual(['/(app)/chats'])
  })

  test('AC5: pressing a project agent row opens that project\'s chat list', () => {
    chat.mentionables = { agents: [projectAgent] }
    render(createElement(DmsPanel, {}))
    fireEvent.click(agentRow('Project agent'))
    expect(pushes).toEqual([{ pathname: '/(app)/project-chats', params: { id: 'p1' } }])
  })

  test('AC5: the compact row still announces its last chat', () => {
    recentAgentChats = [
      {
        chatSessionId: 's1',
        title: 'Help with onboarding',
        projectId: null,
        agentKey: 'ws',
        agentName: null,
        lastActiveAt: new Date().toISOString(),
        preview: null,
      },
    ]
    render(createElement(DmsPanel, {}))

    expect(screen.queryByText(/Help with onboarding/)).toBeNull()
    expect(agentRow('Workspace agent').getAttribute('aria-label')).toMatch(/^Workspace agent, Help with onboarding · .+$/)
  })
})
