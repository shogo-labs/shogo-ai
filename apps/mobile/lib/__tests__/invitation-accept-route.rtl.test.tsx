// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'ios' },
    Pressable: ({ accessibilityLabel, children, onPress, disabled }: any) =>
      createElement('button', { 'aria-label': accessibilityLabel, onClick: onPress, disabled }, children),
  } as any),
)
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...a: unknown[]) => a.filter(Boolean).join(' '),
  Button: ({ children, onPress }: any) => createElement('button', { onClick: onPress }, children),
}))
mock.module('lucide-react-native', () => {
  const Icon = () => null
  return { Users: Icon, AlertTriangle: Icon, Inbox: Icon, X: Icon }
})
mock.module('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: any) => createElement('div', null, children),
}))
mock.module('../../components/phone/NativePhoneSheet', () => ({ NativePhoneSheet: () => null }))
mock.module('../api', () => ({
  isInvitationExpired: (i: any) => i.status === 'expired',
}))

const router = { replace: mock((_: unknown) => {}), push: mock((_: unknown) => {}) }
let searchParams: { id?: string } = { id: 'inv-1' }
mock.module('expo-router', () => ({
  useRouter: () => router,
  useLocalSearchParams: () => searchParams,
}))

let authValue: any
mock.module('../../contexts/auth', () => ({ useAuth: () => authValue }))
mock.module('../../contexts/domain', () => ({
  DomainProvider: ({ children }: any) => createElement('div', null, children),
}))

const setActiveWorkspaceId = mock((_: string) => {})
mock.module('../workspace-store', () => ({ setActiveWorkspaceId }))

let hookValue: any
mock.module('../use-pending-invitations', () => ({ usePendingInvitations: () => hookValue }))

const { default: InvitationAcceptScreen } = await import('../../app/invitations/[id]/accept')

const invite = { id: 'inv-1', workspaceId: 'ws-9', role: 'member', status: 'pending', workspace: { name: 'Acme' } }

beforeEach(() => {
  router.replace.mockClear()
  setActiveWorkspaceId.mockClear()
  searchParams = { id: 'inv-1' }
  authValue = { isAuthenticated: true, isLoading: false, user: { id: 'u1', email: 'me@x.com' } }
  hookValue = {
    pendingInvites: [invite],
    processingInvite: null,
    isLoading: false,
    loadInvites: async () => {},
    acceptInvite: mock(async () => true),
    declineInvite: mock(async () => true),
  }
})
afterEach(cleanup)

describe('/invitations/:id/accept', () => {
  test('signed out: offers sign-in and returns here via next', () => {
    authValue = { isAuthenticated: false, isLoading: false, user: null }
    render(createElement(InvitationAcceptScreen))
    fireEvent.click(screen.getByText('Sign In'))
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/(auth)/sign-in',
      params: { next: '/invitations/inv-1/accept' },
    })
  })

  test('shows not-found state when the invite belongs to another account', () => {
    hookValue.pendingInvites = []
    render(createElement(InvitationAcceptScreen))
    expect(screen.getByText('Invitation not found')).toBeTruthy()
    expect(screen.getByText(/me@x\.com/)).toBeTruthy()
  })

  test('accept activates the workspace and goes home', async () => {
    render(createElement(InvitationAcceptScreen))
    expect(screen.getByText('Acme')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Accept invitation'))
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'))
    expect(hookValue.acceptInvite).toHaveBeenCalledWith(invite)
    expect(setActiveWorkspaceId).toHaveBeenCalledWith('ws-9')
  })

  test('failed accept stays on the screen', async () => {
    hookValue.acceptInvite = mock(async () => false)
    render(createElement(InvitationAcceptScreen))
    fireEvent.click(screen.getByLabelText('Accept invitation'))
    await waitFor(() => expect(hookValue.acceptInvite).toHaveBeenCalled())
    expect(router.replace).not.toHaveBeenCalled()
    expect(setActiveWorkspaceId).not.toHaveBeenCalled()
  })

  test('decline goes home', async () => {
    render(createElement(InvitationAcceptScreen))
    fireEvent.click(screen.getByLabelText('Decline invitation'))
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'))
    expect(hookValue.declineInvite).toHaveBeenCalledWith(invite)
  })
})
