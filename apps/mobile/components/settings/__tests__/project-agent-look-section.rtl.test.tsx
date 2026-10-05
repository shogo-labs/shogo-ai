// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const saved: Array<{ projectId: string | null; look: any }> = []
let canEdit = true

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Pressable: ({ accessibilityLabel, children, onPress }: any) =>
      createElement('div', { role: 'button', 'aria-label': accessibilityLabel, onClick: onPress }, children),
  } as any),
)
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }))
mock.module('../account-sheet-chrome', () => ({
  Text: ({ children }: any) => createElement('span', null, children),
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
      role: null,
      owner: null,
      channels: [],
    }),
    setAgentMuted: async () => {},
    setAgentBuddyLook: async (_ws: string, projectId: string | null, look: any) => {
      saved.push({ projectId, look })
      return look
    },
  }),
}))
const { resolveAgentLook } = await import('@shogo/shared-app/buddy-look')
mock.module('../../../hooks/useTeamChat', () => ({
  useAgentLook: (_ws: string | null | undefined, projectId: string | null) => resolveAgentLook(null, projectId),
  setAgentLookLocal: () => {},
  invalidateConversationList: () => {},
}))
mock.module('../../island/buddy/ShogoBuddy', () => ({
  ShogoBuddy: () => createElement('div', { 'data-rn-shim': 'buddy' }),
}))
mock.module('../../personal/BuddyLookSheet', () => ({
  BuddyLookEditor: ({ target }: any) =>
    createElement(
      'div',
      { 'data-rn-shim': 'look-editor' },
      createElement('button', { onClick: () => target.onChange({ ...target.look, topper: 'wizard' }) }, 'pick wizard'),
      createElement('button', { onClick: () => target.onReset?.() }, 'reset'),
    ),
}))

const { ProjectAgentLookSection } = await import('../ProjectAgentLookSection')

afterEach(() => {
  cleanup()
  saved.length = 0
  canEdit = true
})

describe('ProjectAgentLookSection', () => {
  test('editors get the customizer right on the page and changes are saved', async () => {
    render(<ProjectAgentLookSection workspaceId="ws" projectId="proj-1" projectName="Billing" />)
    fireEvent.click(await screen.findByText('pick wizard'))
    await new Promise((r) => setTimeout(r, 0))
    expect(saved[0]).toMatchObject({ projectId: 'proj-1', look: { topper: 'wizard' } })
    fireEvent.click(screen.getByText('reset'))
    await new Promise((r) => setTimeout(r, 0))
    expect(saved.at(-1)).toEqual({ projectId: 'proj-1', look: null })
  })

  test('people who cannot edit see the buddy but no customizer', async () => {
    canEdit = false
    render(<ProjectAgentLookSection workspaceId="ws" projectId="proj-1" projectName="Billing" />)
    expect(await screen.findByText(/Only the project owner and workspace admins/)).toBeTruthy()
    expect(document.querySelector('[data-rn-shim="buddy"]')).toBeTruthy()
    expect(document.querySelector('[data-rn-shim="look-editor"]')).toBeNull()
  })
})
