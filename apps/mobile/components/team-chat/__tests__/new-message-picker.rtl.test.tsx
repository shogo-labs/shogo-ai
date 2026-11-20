// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import { inviteDialogContextStub, invitePermissionsStub, inviteStub } from '../../../test/invite-dialog-stub'

const dms: Array<{ workspaceId: string; userIds: string[] }> = []
const selfDms: Array<{ workspaceId: string; userId: string }> = []
const huddles: Array<{ conversationId: string; workspaceId: string; label: string; kind?: string | null }> = []

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Pressable: ({ accessibilityLabel, accessibilityRole, children, onPress, disabled }: any) =>
      createElement(
        'div',
        { role: accessibilityRole ?? 'button', 'aria-label': accessibilityLabel, onClick: disabled ? undefined : onPress },
        children,
      ),
    TextInput: ({ value, onChangeText, placeholder, accessibilityLabel }: any) =>
      createElement('input', {
        value,
        placeholder,
        'aria-label': accessibilityLabel,
        onChange: (e: any) => onChangeText?.(e.target.value),
      }),
  } as any),
)
mock.module('../../../lib/huddle-call', () => ({
  huddleMediaSupported: true,
  joinHuddleCall: async (input: any) => void huddles.push(input),
}))
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }))
// Spread the real module: `mock.module` replaces it for every file in this
// process, so a partial stub breaks the other team-chat suites that run after
// this one (they need `nativeCookieHeader` and friends).
const realTeamChatApi = await import('../../../lib/team-chat-api')
mock.module('../../../lib/team-chat-api', () => ({
  ...realTeamChatApi,
  absoluteApiUrl: (url: string) => url,
  teamChatApi: () => ({
    openDm: async (workspaceId: string, userIds: string[]) => {
      dms.push({ workspaceId, userIds })
      return { id: 'people-dm' }
    },
    openSelfDm: async (workspaceId: string, userId: string) => {
      selfDms.push({ workspaceId, userId })
      return { id: 'self-dm' }
    },
  }),
}))
mock.module('../AgentAvatar', () => ({ AgentAvatar: () => createElement('span', { 'data-rn-shim': 'agent-avatar' }) }))
const realPresenceDot = await import('../PresenceDot')
mock.module('../PresenceDot', () => ({
  ...realPresenceDot,
  PresenceDot: () => createElement('span', { 'data-rn-shim': 'presence' }),
}))
// The picker offers "Invite x to Workspace" through the app shell's dialog
// (SHO-454); these tests render it on its own, so stub the context and the
// permissions hook it reads `canInvite` from.
mock.module('../../workspace/invite-dialog-context', inviteDialogContextStub)
mock.module('../../../hooks/usePermissions', invitePermissionsStub)

const { NewMessagePicker, filterRecipients } = await import('../NewMessagePicker')

const mentionables: any = {
  people: [
    { id: 'me', name: 'Me Myself', email: 'me@example.com', image: null, role: 'owner' },
    { id: 'u-ana', name: 'Ana Lopez', email: 'ana@example.com', image: null, role: 'member' },
    { id: 'u-ben', name: 'Ben Okafor', email: 'ben@example.com', image: null, role: 'member' },
  ],
  agents: [
    { key: 'ws', projectId: null, name: 'Workspace agent', description: 'Helps across the workspace', image: null },
    { key: 'p:proj-1', projectId: 'proj-1', name: 'Billing Bot', description: 'Sends invoices', image: null },
  ],
}

function renderPicker(props: Partial<React.ComponentProps<typeof NewMessagePicker>> = {}) {
  const created: any[] = []
  render(
    <NewMessagePicker workspaceId="ws-1" mentionables={mentionables} me="me" onCreated={(c) => created.push(c)} {...props} />,
  )
  return created
}

afterEach(() => {
  cleanup()
  dms.length = 0
  selfDms.length = 0
  huddles.length = 0
  inviteStub.reset()
})

describe('filterRecipients', () => {
  test('leaves out the current user and matches names and emails', () => {
    expect(filterRecipients(mentionables, 'me', '').people.map((p) => p.id)).toEqual(['u-ana', 'u-ben'])
    expect(filterRecipients(mentionables, 'me', 'ben@').people.map((p) => p.id)).toEqual(['u-ben'])
    expect(filterRecipients(null, 'me', '')).toEqual({ people: [], selfRecipient: null })
  })

  test('returns yourself apart from the people list, so you can message your own notes', () => {
    const { people, selfRecipient } = filterRecipients(mentionables, 'me', '')
    expect(people.map((p) => p.id)).toEqual(['u-ana', 'u-ben'])
    expect(selfRecipient?.id).toBe('me')
  })

  test('your own row follows the search like any other, and needs to know who you are', () => {
    expect(filterRecipients(mentionables, 'me', 'myself').selfRecipient?.id).toBe('me')
    expect(filterRecipients(mentionables, 'me', 'ana').selfRecipient).toBeNull()
    expect(filterRecipients(mentionables, null, '').selfRecipient).toBeNull()
  })
})

describe('NewMessagePicker', () => {
  test('lists teammates, and no agents: a chat with an agent is a project chat (SHO-412)', () => {
    renderPicker()
    // Each name is both a filter chip and a section heading.
    expect(screen.getAllByText('People')).toHaveLength(2)
    expect(screen.queryByText('Agents')).toBeNull()
    expect(screen.getByLabelText('Ana Lopez, ana@example.com')).toBeTruthy()
    expect(screen.queryByLabelText('Billing Bot, agent')).toBeNull()
    expect(screen.queryByLabelText('Workspace agent, agent')).toBeNull()
    // You do not message yourself.
    expect(screen.queryByLabelText('Me Myself, me@example.com')).toBeNull()
  })

  test('search filters the people list', () => {
    renderPicker()
    fireEvent.change(screen.getByLabelText('Search people'), { target: { value: 'ana' } })
    expect(screen.getByLabelText('Ana Lopez, ana@example.com')).toBeTruthy()
    expect(screen.queryByLabelText('Ben Okafor, ben@example.com')).toBeNull()

    fireEvent.change(screen.getByLabelText('Search people'), { target: { value: 'zzz' } })
    expect(screen.getByText('No teammates match.')).toBeTruthy()
  })

  test('your own row sits above People and opens your notes', async () => {
    const created = renderPicker()
    expect(screen.getByText('You')).toBeTruthy() // the section heading, not a person
    expect(screen.getByLabelText('Me Myself (you), message yourself')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Me Myself (you), message yourself'))
    await waitFor(() => expect(created).toEqual([{ id: 'self-dm' }]))
    expect(selfDms).toEqual([{ workspaceId: 'ws-1', userId: 'me' }])
    // Your own note is a one-to-one conversation, not a pick from the people list.
    expect(dms).toEqual([])
  })

  test('teammates are multi-selected and started together', async () => {
    const created = renderPicker()
    expect(screen.queryByLabelText('Start message')).toBeNull()

    fireEvent.click(screen.getByLabelText('Ana Lopez, ana@example.com'))
    expect(screen.getByLabelText('Start message')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Ben Okafor, ben@example.com'))
    fireEvent.click(screen.getByLabelText('Start group message (2)'))

    await waitFor(() => expect(created).toEqual([{ id: 'people-dm' }]))
    expect(dms).toEqual([{ workspaceId: 'ws-1', userIds: ['u-ana', 'u-ben'] }])
  })

  test('"Start huddle" opens the group DM for everyone checked and rings them into a call', async () => {
    const created = renderPicker()
    expect(screen.queryByLabelText('Start huddle')).toBeNull()

    fireEvent.click(screen.getByLabelText('Ana Lopez, ana@example.com'))
    expect(screen.getByLabelText('Start huddle')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Ben Okafor, ben@example.com'))
    fireEvent.click(screen.getByLabelText('Start huddle with 2 people'))

    await waitFor(() => expect(created).toEqual([{ id: 'people-dm' }]))
    expect(dms).toEqual([{ workspaceId: 'ws-1', userIds: ['u-ana', 'u-ben'] }])
    expect(huddles).toEqual([{ conversationId: 'people-dm', workspaceId: 'ws-1', label: 'Ana Lopez, Ben Okafor' }])
  })

  // SHO-454 acceptance 4: an address that is not a member is an invitation,
  // not a dead end.
  test('an email that is nobody here offers to invite them, with the address filled in', () => {
    inviteStub.canInvite = true
    renderPicker()
    fireEvent.change(screen.getByLabelText('Search people'), { target: { value: 'new@example.com' } })

    fireEvent.click(screen.getByLabelText('Invite new@example.com'))
    expect(inviteStub.opened).toEqual([{ workspaceId: 'ws-1', emails: ['new@example.com'] }])
  })

  test('no invite row when the caller cannot invite, or when the search is not an address', () => {
    inviteStub.canInvite = false
    renderPicker()
    fireEvent.change(screen.getByLabelText('Search people'), { target: { value: 'new@example.com' } })
    expect(screen.queryByLabelText('Invite new@example.com')).toBeNull()

    inviteStub.canInvite = true
    cleanup()
    renderPicker()
    fireEvent.change(screen.getByLabelText('Search people'), { target: { value: 'ana' } })
    expect(screen.queryByLabelText('Invite someone new')).toBeNull()
  })
})
