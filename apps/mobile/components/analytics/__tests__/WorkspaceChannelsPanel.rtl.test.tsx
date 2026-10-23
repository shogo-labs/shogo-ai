// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Pressable: ({ onPress, children, ...props }: any) =>
      createElement('button', { ...props, onClick: onPress }, children),
  }),
)
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

const http = { id: 'http' }
mock.module('../../../contexts/domain', () => ({ useDomainHttp: () => http }))

const getWorkspaceAnalytics = mock(async (..._args: any[]): Promise<any> => ({}))
mock.module('../../../lib/api', () => ({ api: { getWorkspaceAnalytics } }))

mock.module('../../../hooks/useActiveWorkspace', () => ({
  useActiveWorkspace: () => ({ id: 'ws_1', name: 'Acme' }),
}))
mock.module('../../../lib/native-active-shadow', () => ({
  nativeActivePill: () => ({ className: '', style: undefined }),
}))
mock.module('../../settings/account-sheet-chrome', () => ({
  Text: ({ children, ...props }: any) => createElement('span', props, children),
  accountSheetIcon: (icon: any) => icon,
}))
// The real module pulls the model catalog; the panel only needs StatCard.
mock.module('../SharedAnalytics', () => ({
  StatCard: ({ label, value, subtitle }: any) =>
    createElement('div', { 'data-testid': `stat-${label}` }, [
      createElement('span', { key: 'v', 'data-testid': `value-${label}` }, String(value)),
      subtitle ? createElement('span', { key: 's' }, subtitle) : null,
    ]),
}))

const { WorkspaceChannelsPanel } = await import('../WorkspaceChannelsPanel')

const row = (over: Record<string, any> = {}) => ({
  conversationId: 'conv_1',
  name: 'general',
  slug: 'general',
  kind: 'public',
  provider: 'shogo',
  bridged: false,
  messages: 12,
  humanMessages: 9,
  agentMessages: 3,
  bridgedMessages: 0,
  agentMentions: 4,
  activeMembers: 3,
  lastMessageAt: new Date(Date.now() - 60_000).toISOString(),
  ...over,
})

const breakdown = (over: Record<string, any> = {}) => ({
  workspaceId: 'ws_1',
  period: '7d',
  window: { from: '2026-10-10T00:00:00.000Z', to: '2026-10-17T00:00:00.000Z' },
  totals: {
    channels: 2,
    activeUsers: 4,
    messages: 15,
    humanMessages: 11,
    agentMessages: 4,
    bridgedMessages: 3,
    agentMentions: 5,
    bridgedShare: 0.2,
    messagesPerActiveUser: 2.75,
  },
  channels: [
    row(),
    row({
      conversationId: 'conv_2',
      name: 'support',
      slug: 'support',
      provider: 'slack',
      bridged: true,
      messages: 3,
      humanMessages: 0,
      agentMessages: 0,
      bridgedMessages: 3,
      agentMentions: 1,
      activeMembers: 1,
    }),
  ],
  ...over,
})

beforeEach(() => {
  getWorkspaceAnalytics.mockReset()
  getWorkspaceAnalytics.mockImplementation(async () => breakdown())
})

describe('WorkspaceChannelsPanel', () => {
  test('asks for the channels breakdown for the active workspace and 7d by default', async () => {
    render(<WorkspaceChannelsPanel />)

    expect(await screen.findByText('general')).toBeTruthy()
    expect(getWorkspaceAnalytics).toHaveBeenCalledTimes(1)
    const [passedHttp, workspaceId, endpoint, params] = getWorkspaceAnalytics.mock.calls[0]
    expect(passedHttp).toBe(http)
    expect(workspaceId).toBe('ws_1')
    expect(endpoint).toBe('channels')
    expect(params).toEqual({ period: '7d' })
  })

  test('renders one row per channel, with provider badges and the totals row', async () => {
    render(<WorkspaceChannelsPanel />)
    await screen.findByText('general')

    expect(screen.getByText('support')).toBeTruthy()
    // Native and bridged channels are labelled by provider.
    expect(screen.getByText('Native')).toBeTruthy()
    expect(screen.getByText('Slack')).toBeTruthy()
    expect(screen.getByText('3 bridged')).toBeTruthy()
    expect(screen.getByText('Workspace total (2)')).toBeTruthy()
    // Same share twice on purpose: the totals strip and the "Active people" subtitle.
    expect(screen.getAllByText('20% bridged')).toHaveLength(2)
    // Table header: the columns the card asks for.
    expect(screen.getByText('Channel')).toBeTruthy()
    expect(screen.getByText('Active members')).toBeTruthy()
    expect(screen.getByText('Agent mentions')).toBeTruthy()

    // Workspace totals on top.
    expect(screen.getByTestId('value-Active people').textContent).toBe('4')
    expect(screen.getByTestId('value-Messages').textContent).toBe('15')
  })

  test('switching the period refetches', async () => {
    render(<WorkspaceChannelsPanel />)
    await screen.findByText('general')

    fireEvent.click(screen.getByText('30d'))
    await waitFor(() => expect(getWorkspaceAnalytics).toHaveBeenCalledTimes(2))
    expect(getWorkspaceAnalytics.mock.calls[1][3]).toEqual({ period: '30d' })
  })

  test('an empty workspace shows the empty state instead of a table', async () => {
    getWorkspaceAnalytics.mockImplementation(async () =>
      breakdown({ channels: [], totals: { channels: 0, activeUsers: 0, messages: 0, humanMessages: 0, agentMessages: 0, bridgedMessages: 0, agentMentions: 0, bridgedShare: 0, messagesPerActiveUser: 0 } }),
    )
    render(<WorkspaceChannelsPanel />)

    expect(await screen.findByText('No channels yet')).toBeTruthy()
    expect(screen.queryByText("Channel")).toBeNull()
  })

  test('a 403 explains the plan/permission gate instead of showing an error', async () => {
    getWorkspaceAnalytics.mockImplementation(async () => {
      throw Object.assign(new Error('Advanced workspace analytics require a Business plan or higher.'), { status: 403 })
    })
    render(<WorkspaceChannelsPanel />)

    expect(await screen.findByText('Channel activity')).toBeTruthy()
    expect(screen.getByText(/Business plan or higher/)).toBeTruthy()
    expect(screen.queryByText("Channel")).toBeNull()
  })

  test('other failures surface the server message', async () => {
    getWorkspaceAnalytics.mockImplementation(async () => {
      throw new Error('analytics_failed: boom')
    })
    render(<WorkspaceChannelsPanel />)

    expect(await screen.findByText('analytics_failed: boom')).toBeTruthy()
  })
})
