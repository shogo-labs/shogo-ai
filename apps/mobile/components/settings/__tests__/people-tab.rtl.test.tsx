// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Fragment, createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Pressable: ({ testID, children, onPress, disabled, accessibilityLabel }: any) =>
      createElement(
        'div',
        {
          role: 'button',
          'data-testid': testID,
          'aria-label': accessibilityLabel,
          'aria-disabled': disabled || undefined,
          onClick: disabled ? undefined : onPress,
        },
        children,
      ),
    View: ({ testID, children }: any) => createElement('div', { 'data-testid': testID }, children),
    Modal: ({ visible, children }: any) => (visible ? createElement('div', { role: 'dialog' }, children) : null),
    TextInput: ({ testID, value, onChangeText, placeholder }: any) =>
      createElement('input', { 'data-testid': testID, value, placeholder, onChange: (e: any) => onChangeText(e.target.value) }),
  } as any),
)
const passthrough = ({ children }: any) => createElement('div', null, children)
mock.module('@shogo/shared-ui/primitives', () => ({
  Badge: passthrough,
  Card: passthrough,
  CardContent: passthrough,
  Button: ({ children, onPress, testID, disabled }: any) =>
    createElement('button', { onClick: onPress, 'data-testid': testID, disabled }, children),
  cn: (...a: unknown[]) => a.filter(Boolean).join(' '),
}))
mock.module('../account-sheet-chrome', () => ({
  Text: ({ children, testID }: any) => createElement('span', { 'data-testid': testID }, children),
  TextInput: ({ value, onChangeText }: any) =>
    createElement('input', { value, onChange: (e: any) => onChangeText(e.target.value) }),
  useAccountSheetIcons: (icons: Record<string, unknown>) =>
    Object.fromEntries(Object.keys(icons).map((k) => [k, () => null])),
}))
mock.module('@/components/ui/popover', () => ({
  Popover: ({ children, trigger, isOpen }: any) => createElement(Fragment, null, trigger?.({}), isOpen ? children : null),
  PopoverBackdrop: () => null,
  PopoverContent: passthrough,
  PopoverBody: passthrough,
}))
const toasts: string[] = []
const toastApi = {
  show: ({ render }: any) => {
    const el: any = render({ id: 't' })
    // Toast > ToastTitle: collect the title text for assertions.
    toasts.push(String(el?.props?.children?.[0]?.props?.children ?? ''))
  },
}
mock.module('@/components/ui/toast', () => ({
  useToast: () => toastApi,
  Toast: passthrough,
  ToastTitle: ({ children }: any) => createElement('span', null, children),
  ToastDescription: ({ children }: any) => createElement('span', null, children),
}))
mock.module('expo-router', () => ({ useRouter: () => ({ replace: () => {}, push: () => {} }) }))
mock.module('../../../lib/workspace-store', () => ({ setActiveWorkspaceId: () => {} }))
mock.module('../../../lib/invitation-events', () => ({
  invitationEvents: { subscribe: () => () => {}, emit: () => {} },
}))
mock.module('../MemberUsageDetail', () => ({
  MemberDetailSheet: ({ visible, profile, access }: any) =>
    visible ? createElement('div', { 'data-testid': 'member-sheet' }, profile?.name, access) : null,
}))
mock.module('../people/InviteMembersModal', () => ({ InviteMembersModal: () => null }))

let currentUser: { id: string; name: string; email: string }
let authValue: { user: typeof currentUser }
mock.module('../../../contexts/auth', () => ({ useAuth: () => authValue }))
const activeWorkspace = { id: 'ws-1', name: 'Acme' }
mock.module('../../../hooks/useActiveWorkspace', () => ({ useActiveWorkspace: () => activeWorkspace }))

let memberRows: any[]
const http = {}
const noopCollection = (all: () => any[]) => ({ get all() { return all() }, loadAll: async () => {} })
// Collections must be referentially stable (like the real MST ones), otherwise
// PeopleTab's load effect re-runs every render.
const workspaceCollection = noopCollection(() => [{ id: 'ws-1' }, { id: 'ws-2' }])
const memberCollection = noopCollection(() => memberRows)
const invitationCollection = noopCollection(() => [])
mock.module('../../../contexts/domain', () => ({
  useDomainHttp: () => http,
  useWorkspaceCollection: () => workspaceCollection,
  useMemberCollection: () => memberCollection,
  useInvitationCollection: () => invitationCollection,
}))

const removeCalls: Array<[string, string]> = []
const roleCalls: Array<[string, string]> = []
let removeError: string | null = null
mock.module('@shogo/shared-app/domain', () => ({
  useDomainActions: () => ({
    removeMember: async (id: string, by: string) => {
      removeCalls.push([id, by])
      if (removeError) throw new Error(removeError)
    },
    updateMemberRole: async (id: string, role: string) => {
      roleCalls.push([id, role])
    },
    cancelInvitation: async () => {},
  }),
}))

const USERS: Record<string, { name: string; email: string }> = {
  'u-olga': { name: 'Olga', email: 'olga@acme.test' },
  'u-otto': { name: 'Otto', email: 'otto@acme.test' },
  'u-amy': { name: 'Amy', email: 'amy@acme.test' },
  'u-bob': { name: 'Bob', email: 'bob@acme.test' },
}
mock.module('../../../lib/api', () => ({
  isInvitationExpired: () => false,
  api: {
    getWorkspaceMembers: async () => Object.entries(USERS).map(([id, u]) => ({ user: { id, ...u } })),
    getMemberInsights: async () => ({ rows: [{ userId: 'u-bob', spendUsd: 4.5, models: [], daily: [] }], total: 1 }),
    getReceivedInvitations: async () => [],
    getUsageLogCsvUrl: () => 'https://example.test/usage.csv',
    leaveWorkspace: async () => ({ ok: true }),
  },
}))

const { PeopleTab } = await import('../people/PeopleTab')

function setMembers(roles: Record<string, string>) {
  memberRows = Object.entries(roles).map(([userId, role]) => ({
    id: `m-${userId.slice(2)}`,
    userId,
    role,
    workspaceId: 'ws-1',
    projectId: null,
  }))
}
function signInAs(userId: string) {
  currentUser = { id: userId, ...USERS[userId] }
  authValue = { user: currentUser }
}
async function openMenuFor(name: string) {
  fireEvent.click(await screen.findByTestId(`member-actions-${name}`))
}

beforeEach(() => {
  setMembers({ 'u-olga': 'owner', 'u-amy': 'admin', 'u-bob': 'member' })
  signInAs('u-olga')
})

afterEach(() => {
  cleanup()
  removeCalls.length = 0
  roleCalls.length = 0
  toasts.length = 0
  removeError = null
})

describe('PeopleTab', () => {
  test('an owner removes a member from the actions menu after confirming', async () => {
    render(<PeopleTab />)
    await openMenuFor('Bob')
    fireEvent.click(screen.getByTestId('member-action-remove'))

    const dialog = await screen.findByTestId('remove-member-dialog')
    expect(within(dialog).getByText('Remove Bob from Acme?')).toBeTruthy()
    expect(removeCalls).toEqual([])

    fireEvent.click(screen.getByTestId('remove-member-dialog-confirm'))
    await waitFor(() => expect(removeCalls).toEqual([['m-bob', 'u-olga']]))
    await waitFor(() => expect(screen.queryByTestId('remove-member-dialog')).toBeNull())
    expect(toasts).toContain('Removed Bob')
  })

  test('a failed removal keeps the dialog open and shows the server message inline', async () => {
    removeError = 'Cannot remove the last owner'
    render(<PeopleTab />)
    await openMenuFor('Bob')
    fireEvent.click(screen.getByTestId('member-action-remove'))
    fireEvent.click(await screen.findByTestId('remove-member-dialog-confirm'))

    const error = await screen.findByTestId('remove-member-dialog-error')
    expect(error.textContent).toBe('Cannot remove the last owner')
    expect(screen.getByTestId('remove-member-dialog')).toBeTruthy()
  })

  test('an owner can change a role from the actions menu', async () => {
    render(<PeopleTab />)
    await openMenuFor('Bob')
    fireEvent.click(screen.getByTestId('member-action-role'))
    fireEvent.click(screen.getByTestId('role-option-admin'))
    await waitFor(() => expect(roleCalls).toEqual([['m-bob', 'admin']]))
  })

  test('a plain member only gets View details on other people', async () => {
    signInAs('u-bob')
    render(<PeopleTab />)
    await openMenuFor('Amy')
    expect(screen.getByTestId('member-action-details')).toBeTruthy()
    expect(screen.queryByTestId('member-action-remove')).toBeNull()
    expect(screen.queryByTestId('member-action-role')).toBeNull()
    expect(screen.queryByTestId('role-dropdown-Amy')).toBeNull()
  })

  test('an admin sees Remove disabled for an owner, with the reason', async () => {
    signInAs('u-amy')
    render(<PeopleTab />)
    await openMenuFor('Olga')
    const remove = screen.getByTestId('member-action-remove')
    expect(remove.getAttribute('aria-disabled')).toBe('true')
    expect(within(remove).getByText('Only owners can remove owners')).toBeTruthy()
  })

  test('your own row offers Leave workspace instead of Remove', async () => {
    setMembers({ 'u-olga': 'owner', 'u-otto': 'owner', 'u-bob': 'member' })
    render(<PeopleTab />)
    await openMenuFor('Olga')
    expect(screen.queryByTestId('member-action-remove')).toBeNull()
    const leave = screen.getByTestId('member-action-leave')
    expect(leave.getAttribute('aria-disabled')).toBeNull()

    fireEvent.click(leave)
    expect(await screen.findByTestId('leave-workspace-dialog')).toBeTruthy()
  })

  test('Leave workspace is disabled for the last owner', async () => {
    render(<PeopleTab />)
    await openMenuFor('Olga')
    const leave = screen.getByTestId('member-action-leave')
    expect(leave.getAttribute('aria-disabled')).toBe('true')
    expect(within(leave).getByText(/last owner/)).toBeTruthy()
  })

  test('shows one usage figure per member for managers and hides it from members', async () => {
    const { unmount } = render(<PeopleTab />)
    const bobRow = await screen.findByTestId('member-row-Bob')
    expect(within(bobRow).getByText('$4.50')).toBeTruthy()
    unmount()

    signInAs('u-bob')
    render(<PeopleTab />)
    const amyRow = await screen.findByTestId('member-row-Amy')
    expect(within(amyRow).getByText('—')).toBeTruthy()
  })
})
