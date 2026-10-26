// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const agentDms: Array<{ workspaceId: string; projectId: string | null }> = []
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
mock.module('../../../lib/team-chat-api', () => ({
  absoluteApiUrl: (url: string) => url,
  teamChatApi: () => ({
    openAgentDm: async (workspaceId: string, projectId: string | null) => {
      agentDms.push({ workspaceId, projectId })
      return { id: `agent-dm-${projectId}` }
    },
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
mock.module('../PresenceDot', () => ({ PresenceDot: () => createElement('span', { 'data-rn-shim': 'presence' }) }))

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
  agentDms.length = 0
  dms.length = 0
  selfDms.length = 0
  huddles.length = 0
})

describe('filterRecipients', () => {
  test('leaves out the current user and matches names, emails and agent descriptions', () => {
    expect(filterRecipients(mentionables, 'me', '').people.map((p) => p.id)).toEqual(['u-ana', 'u-ben'])
    expect(filterRecipients(mentionables, 'me', 'ben@').people.map((p) => p.id)).toEqual(['u-ben'])
    expect(filterRecipients(mentionables, 'me', 'invoices').agents.map((a) => a.key)).toEqual(['p:proj-1'])
    expect(filterRecipients(null, 'me', '')).toEqual({ people: [], agents: [], selfRecipient: null })
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
  test('lists teammates and agents together', () => {
    renderPicker()
    // Each name is both a filter chip and a section heading.
    expect(screen.getAllByText('People')).toHaveLength(2)
    expect(screen.getAllByText('Agents')).toHaveLength(2)
    expect(screen.getByLabelText('Ana Lopez, ana@example.com')).toBeTruthy()
    expect(screen.getByLabelText('Billing Bot, agent')).toBeTruthy()
    expect(screen.getByLabelText('Workspace agent, agent')).toBeTruthy()
    // You do not message yourself.
    expect(screen.queryByLabelText('Me Myself, me@example.com')).toBeNull()
  })

  test('search filters people and agents at once', () => {
    renderPicker()
    fireEvent.change(screen.getByLabelText('Search people and agents'), { target: { value: 'bil' } })
    expect(screen.getByLabelText('Billing Bot, agent')).toBeTruthy()
    expect(screen.queryByLabelText('Workspace agent, agent')).toBeNull()
    expect(screen.queryByLabelText('Ana Lopez, ana@example.com')).toBeNull()

    fireEvent.change(screen.getByLabelText('Search people and agents'), { target: { value: 'zzz' } })
    expect(screen.getByText('No people or agents match.')).toBeTruthy()
  })

  test('the filter chips narrow the list to people or agents', () => {
    renderPicker()
    fireEvent.click(screen.getByRole('tab', { name: 'Agents' }))
    expect(screen.queryByLabelText('Ana Lopez, ana@example.com')).toBeNull()
    expect(screen.getByLabelText('Billing Bot, agent')).toBeTruthy()
  })

  test('starts on the agents list when asked to', () => {
    renderPicker({ initialFilter: 'agents' })
    expect(screen.queryByLabelText('Ana Lopez, ana@example.com')).toBeNull()
    expect(screen.getByLabelText('Billing Bot, agent')).toBeTruthy()
  })

  test('tapping an agent opens its DM right away', async () => {
    const created = renderPicker()
    fireEvent.click(screen.getByLabelText('Billing Bot, agent'))
    await waitFor(() => expect(created).toEqual([{ id: 'agent-dm-proj-1' }]))
    expect(agentDms).toEqual([{ workspaceId: 'ws-1', projectId: 'proj-1' }])
    expect(dms).toEqual([])
  })

  test('the workspace agent is messaged with a null project', async () => {
    renderPicker()
    fireEvent.click(screen.getByLabelText('Workspace agent, agent'))
    await waitFor(() => expect(agentDms).toEqual([{ workspaceId: 'ws-1', projectId: null }]))
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

  test('the Agents chip leaves your own row out, since it is not an agent', () => {
    renderPicker({ initialFilter: 'agents' })
    expect(screen.queryByLabelText('Me Myself (you), message yourself')).toBeNull()
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
})
