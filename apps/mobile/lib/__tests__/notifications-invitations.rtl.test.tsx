// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'ios' },
    RefreshControl: () => null,
    Pressable: ({ accessibilityLabel, children, onPress, disabled }: any) =>
      createElement('button', { 'aria-label': accessibilityLabel, onClick: onPress, disabled }, children),
  } as any),
)
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...a: unknown[]) => a.filter(Boolean).join(' '),
}))
mock.module('lucide-react-native', () => {
  const Icon = () => null
  const names = ['ArrowLeft', 'Bell', 'CheckCheck', 'CheckCircle2', 'Clock3', 'AlertTriangle', 'Receipt', 'Gauge', 'ShieldAlert', 'Mail', 'Users', 'Building2', 'Inbox', 'X']
  return Object.fromEntries(names.map((n) => [n, Icon]))
})
mock.module('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: any) => createElement('div', null, children),
}))
mock.module('mobx-react-lite', () => ({ observer: (c: any) => c }))
mock.module('expo-router', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, canGoBack: () => true }),
}))
mock.module('../../components/phone/NativePhoneSheet', () => ({ NativePhoneSheet: () => null }))
mock.module('../api', () => ({ isInvitationExpired: () => false }))
mock.module('../notification-events', () => ({ notificationEvents: { emit: () => {} } }))

const collection = { all: [] as any[], isLoading: false, loadAll: async () => {} }
mock.module('../../contexts/domain', () => ({
  useNotificationCollection: () => collection,
  useDomainActions: () => ({ markNotificationRead: async () => {} }),
}))

let hookValue: any
mock.module('../use-pending-invitations', () => ({ usePendingInvitations: () => hookValue }))

const { default: NotificationsScreen } = await import('../../app/(app)/notifications')

const invite = { id: 'inv-1', workspaceId: 'ws-1', role: 'member', status: 'pending', workspace: { name: 'Acme' } }

beforeEach(() => {
  collection.all = []
  hookValue = {
    pendingInvites: [invite],
    processingInvite: null,
    loadInvites: async () => {},
    acceptInvite: mock(async () => true),
    declineInvite: mock(async () => true),
  }
})
afterEach(cleanup)

describe('Notifications screen invitations', () => {
  test('shows pending invitations even with no notifications, and accept calls the hook', () => {
    render(createElement(NotificationsScreen))
    expect(screen.getByText('Invitations')).toBeTruthy()
    expect(screen.getByText('Acme')).toBeTruthy()
    expect(screen.queryByText("You're all caught up")).toBeNull()
    fireEvent.click(screen.getByLabelText('Accept invitation'))
    expect(hookValue.acceptInvite).toHaveBeenCalledWith(invite)
  })

  test('shows the empty state when there are no invitations or notifications', () => {
    hookValue.pendingInvites = []
    render(createElement(NotificationsScreen))
    expect(screen.getByText("You're all caught up")).toBeTruthy()
  })
})
