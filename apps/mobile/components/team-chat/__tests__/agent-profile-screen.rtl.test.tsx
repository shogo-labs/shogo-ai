// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const routed: any[] = []
const saved: Array<{ projectId: string | null; look: any }> = []
const localLooks: Array<{ projectId: string | null; look: any }> = []
let canEdit = true
let windowWidth = 1280

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    useWindowDimensions: () => ({ width: windowWidth, height: 800, scale: 1, fontScale: 1 }),
    Pressable: ({ accessibilityLabel, children, onPress, disabled }: any) =>
      createElement('div', { role: 'button', 'aria-label': accessibilityLabel, onClick: disabled ? undefined : onPress }, children),
  } as any),
)
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }))
mock.module('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaView: ({ children }: any) => createElement('div', null, children),
}))
mock.module('expo-router', () => ({
  useRouter: () => ({ push: (r: any) => routed.push(r), replace: () => {}, back: () => {}, canGoBack: () => true }),
}))
mock.module('../../../lib/team-chat-api', () => ({
  absoluteApiUrl: (url: string) => url,
  teamChatApi: () => ({
    agentCard: async (_ws: string, projectId: string | null) => ({
      projectId,
      name: 'Billing Bot',
      iconUrl: null,
      buddyLook: null,
      canEdit,
      role: 'Sends invoices',
      owner: { id: 'u-ana', name: 'Ana Lopez' },
      channels: [],
    }),
    setAgentMuted: async () => {},
    setAgentBuddyLook: async (_ws: string, projectId: string | null, look: any) => {
      saved.push({ projectId, look })
      return look
    },
    openAgentDm: async () => ({ id: 'dm-1' }),
  }),
}))
const { resolveAgentLook } = await import('@shogo/shared-app/buddy-look')
mock.module('../../../hooks/useTeamChat', () => ({
  useAgentLook: (_ws: string | null | undefined, projectId: string | null) => resolveAgentLook(null, projectId),
  setAgentLookLocal: (_ws: string, projectId: string | null, look: any) => localLooks.push({ projectId, look }),
  invalidateConversationList: () => {},
}))
mock.module('../../island/buddy/ShogoBuddy', () => ({
  ShogoBuddy: ({ look }: any) => createElement('div', { 'data-rn-shim': 'buddy', 'data-topper': look.topper }),
}))
// The customizer sheet is covered with the buddy tests; here it just reports its target.
mock.module('../../personal/BuddyLookSheet', () => ({
  BuddyLookSheet: ({ visible, target }: any) =>
    visible
      ? createElement(
          'div',
          { 'data-rn-shim': 'look-sheet' },
          createElement('span', null, target.title),
          createElement('button', { onClick: () => target.onChange({ ...target.look, topper: 'wizard' }) }, 'pick wizard'),
          createElement('button', { onClick: () => target.onReset?.() }, 'reset'),
        )
      : null,
}))

const { AgentProfileScreen, agentKeyProjectId } = await import('../AgentProfileScreen')

afterEach(() => {
  cleanup()
  routed.length = 0
  saved.length = 0
  localLooks.length = 0
  canEdit = true
  windowWidth = 1280
})

describe('agentKeyProjectId', () => {
  test('ws is the workspace agent; anything else is a project id', () => {
    expect(agentKeyProjectId('ws')).toBeNull()
    expect(agentKeyProjectId(undefined)).toBeNull()
    expect(agentKeyProjectId('proj-1')).toBe('proj-1')
    expect(agentKeyProjectId('p:proj-1')).toBe('proj-1')
  })
})

describe('AgentProfileScreen', () => {
  test('shows the agent with its own buddy, role and owner, and links to its project', async () => {
    render(<AgentProfileScreen workspaceId="ws" agentKey="proj-1" />)
    expect(await screen.findByText('Sends invoices')).toBeTruthy()
    expect(screen.getByText('Billing Bot')).toBeTruthy()
    expect(screen.getByText('Ana Lopez')).toBeTruthy()
    expect(document.querySelector('[data-rn-shim="buddy"]')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Open project'))
    expect(routed).toEqual([{ pathname: '/(app)/projects/[id]', params: { id: 'proj-1' } }])
  })

  test('Customize look is only for people who can edit the agent', async () => {
    canEdit = false
    render(<AgentProfileScreen workspaceId="ws" agentKey="proj-1" />)
    await screen.findByText('Sends invoices')
    expect(screen.queryByLabelText('Customize look')).toBeNull()
    cleanup()

    canEdit = true
    render(<AgentProfileScreen workspaceId="ws" agentKey="proj-1" />)
    await screen.findByText('Sends invoices')
    expect(screen.getByLabelText('Customize look')).toBeTruthy()
  })

  test('a picked look shows straight away and is saved; reset goes back to the generated look', async () => {
    render(<AgentProfileScreen workspaceId="ws" agentKey="proj-1" />)
    await screen.findByText('Sends invoices')
    fireEvent.click(screen.getByLabelText('Customize look'))
    expect(screen.getByText('Dress up Billing Bot')).toBeTruthy()
    fireEvent.click(screen.getByText('pick wizard'))
    await new Promise((r) => setTimeout(r, 0))
    expect(localLooks[0].look.topper).toBe('wizard')
    expect(saved[0]).toMatchObject({ projectId: 'proj-1', look: { topper: 'wizard' } })

    fireEvent.click(screen.getByText('reset'))
    await new Promise((r) => setTimeout(r, 0))
    expect(saved.at(-1)).toEqual({ projectId: 'proj-1', look: null })
  })

  test('the workspace agent has no project links', async () => {
    render(<AgentProfileScreen workspaceId="ws" agentKey="ws" />)
    await screen.findByText('Sends invoices')
    expect(screen.queryByLabelText('Open project')).toBeNull()
    expect(screen.queryByLabelText('Show in side panel')).toBeNull()
  })

  test('the side panel link needs a wide screen and opens the DM with the project pane', async () => {
    windowWidth = 600
    render(<AgentProfileScreen workspaceId="ws" agentKey="proj-1" />)
    await screen.findByText('Sends invoices')
    expect(screen.queryByLabelText('Show in side panel')).toBeNull()
    cleanup()

    windowWidth = 1280
    render(<AgentProfileScreen workspaceId="ws" agentKey="proj-1" />)
    await screen.findByText('Sends invoices')
    fireEvent.click(screen.getByLabelText('Show in side panel'))
    await new Promise((r) => setTimeout(r, 0))
    expect(routed).toEqual([{ pathname: '/(app)/c/[conversationId]', params: { conversationId: 'dm-1', project: 'proj-1' } }])
  })
})
