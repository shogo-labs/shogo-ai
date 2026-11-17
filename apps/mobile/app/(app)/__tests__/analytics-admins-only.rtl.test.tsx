// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-404 — the Analytics screen is owner/admin only.
 *
 * A member who opens `/analytics` (a stale link, a deep link) must see the
 * "Workspace admins only" empty state and must not fire a single analytics
 * request. An admin still gets the tabs.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
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

const back = mock(() => {})
mock.module('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ back, push: () => {}, replace: () => {} }),
}))
mock.module('lucide-react-native', () => ({ BarChart3: () => null }))

mock.module('../../../hooks/useActiveWorkspace', () => ({
  useActiveWorkspace: () => ({ id: 'ws_1', name: 'Acme' }),
}))

let permissions = new Set<string>()
mock.module('../../../hooks/usePermissions', () => ({
  usePermissions: () => ({ can: (p: string) => permissions.has(p) }),
}))

// The four panels each fetch on mount; a member must never reach them.
const panelRenders = { usage: 0, channels: 0, heartbeats: 0, costs: 0 }
mock.module('../../../components/analytics/WorkspaceUsagePanel', () => ({
  WorkspaceUsagePanel: () => { panelRenders.usage++; return null },
}))
mock.module('../../../components/analytics/WorkspaceChannelsPanel', () => ({
  WorkspaceChannelsPanel: () => { panelRenders.channels++; return null },
}))
mock.module('../../../components/analytics/WorkspaceHeartbeatsPanel', () => ({
  WorkspaceHeartbeatsPanel: () => { panelRenders.heartbeats++; return null },
}))
mock.module('../../../components/analytics/WorkspaceCostPanel', () => ({
  WorkspaceCostPanel: () => { panelRenders.costs++; return null },
}))

mock.module('../../../components/layout/TabScreenHeader', () => ({
  TabScreen: ({ children, testID }: any) => createElement('div', { 'data-testid': testID }, children),
  TabScreenScrollView: ({ children }: any) => createElement('div', {}, children),
}))
mock.module('../../../components/settings/account-sheet-chrome', () => ({
  Text: ({ children, ...props }: any) => createElement('span', props, children),
}))
mock.module('../../../components/ui/button', () => ({
  Button: ({ children, onPress }: any) => createElement('button', { onClick: onPress }, children),
  ButtonText: ({ children }: any) => createElement('span', {}, children),
}))

const { default: AnalyticsScreen } = await import('../analytics')

beforeEach(() => {
  permissions = new Set()
  panelRenders.usage = 0
  panelRenders.channels = 0
  panelRenders.heartbeats = 0
  panelRenders.costs = 0
  back.mockClear()
})

describe('Analytics screen', () => {
  test('a member sees the admins-only empty state and no panel mounts', () => {
    permissions = new Set(['workspace:read'])
    render(createElement(AnalyticsScreen))

    expect(screen.getByText('Workspace admins only')).toBeTruthy()
    expect(screen.getByText('Ask a workspace owner or admin for access.')).toBeTruthy()
    expect(screen.queryByText('Usage')).toBeNull()
    expect(panelRenders).toEqual({ usage: 0, channels: 0, heartbeats: 0, costs: 0 })
  })

  test('an admin gets the tabs and the usage panel', () => {
    permissions = new Set(['workspace:read', 'workspace.analytics:read'])
    render(createElement(AnalyticsScreen))

    expect(screen.queryByText('Workspace admins only')).toBeNull()
    expect(screen.getByText('Usage')).toBeTruthy()
    expect(screen.getByText('Channels')).toBeTruthy()
    expect(screen.getByText('Cost Optimizer')).toBeTruthy()
    expect(panelRenders.usage).toBe(1)
  })
})
