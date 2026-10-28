// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The call's side panels: chat, polls and Q&A follow the resolved chat (the DM
 * for two people, the group for more, so an invited non-member can use them),
 * the "wants to join" requests answer with Admit and Deny, and the invite
 * sheet only offers people who are not already in the call.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const calls: string[] = []
const timelineArgs: Array<[string | null | undefined, string | null | undefined, string | null | undefined]> = []
let timelineMessages: any[] = []
let sendResult = true
let failure: Error | null = null
const people = [
  { id: 'me', name: 'Eby', email: 'eby@x.com' },
  { id: 'gaurav', name: 'Gaurav', email: 'gaurav@x.com' },
  { id: 'crab', name: 'Code the Crab', email: 'crab@x.com' },
  { id: 'dee', name: 'Dee', email: 'dee@x.com' },
]

const button = ({ accessibilityLabel, accessibilityState, children, onPress, disabled, testID, accessibilityRole }: any) =>
  createElement(
    accessibilityRole ? 'button' : 'div',
    { 'aria-label': accessibilityLabel, 'aria-checked': accessibilityState?.checked, 'data-testid': testID, 'data-role': accessibilityRole, disabled, onClick: onPress },
    children,
  )

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web' },
    Pressable: button,
    Text: ({ children, testID }: any) => createElement('span', { 'data-testid': testID }, children),
    View: ({ children, testID }: any) => createElement('div', { 'data-testid': testID }, children),
    ScrollView: ({ children }: any) => createElement('div', null, children),
    Modal: ({ children }: any) => createElement('div', null, children),
    ActivityIndicator: () => null,
    TextInput: ({ value, onChangeText, accessibilityLabel, placeholder }: any) =>
      createElement('input', { value, 'aria-label': accessibilityLabel ?? placeholder, onChange: (e: any) => onChangeText?.(e.target.value) }),
  }),
)
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }))
mock.module('lucide-react-native', () => ({
  BarChart3: () => null,
  Check: () => null,
  ChevronUp: () => null,
  HelpCircle: () => null,
  Lock: () => null,
  Plus: () => null,
  Send: () => null,
  X: () => null,
}))
mock.module('../UserAvatar', () => ({ UserAvatar: () => null }))
mock.module('../PresenceDot', () => ({ PresenceDot: () => null }))

mock.module('../../../hooks/useTeamChat', () => ({
  useMyUserId: () => 'me',
  useMentionables: () => ({ people, agents: [], channels: [] }),
  useConversationTimeline: (ws: string | null, conversation: string | null, thread: string | null = null) => {
    timelineArgs.push([ws, conversation, thread])
    return {
      state: { messages: timelineMessages },
      loading: false,
      error: null,
      send: async ({ text }: { text: string }) => {
        calls.push(`send:${conversation}:${thread}:${text}`)
        return sendResult
      },
    }
  },
}))

const realApi = await import('../../../lib/team-chat-api')
mock.module('../../../lib/team-chat-api', () => ({
  ...realApi,
  teamChatApi: () => ({
    postHuddlePoll: async (id: string, input: any) => {
      calls.push(`poll:${id}:${input.question}:${input.options.join('|')}`)
      if (failure) throw failure
    },
    postHuddleQuestion: async (id: string, text: string) => {
      calls.push(`question:${id}:${text}`)
    },
  }),
}))
mock.module('../../../lib/huddle-call', () => ({
  admitHuddleRequest: async (id: string) => void calls.push(`admit:${id}`),
  denyHuddleRequest: async (id: string) => void calls.push(`deny:${id}`),
  inviteToHuddleCall: async (ids: string[]) => void calls.push(`invite:${ids.join(',')}`),
  cancelHuddleCallInvite: async (id: string) => void calls.push(`cancel:${id}`),
}))

const { HuddleThreadPanel, pollOptionsFrom } = await import('../HuddleThreadPanel')
const { HuddleRequests, HuddleRequestStrip } = await import('../HuddleRequests')
const { HuddleInviteSheet, invitablePeople } = await import('../HuddleInviteSheet')

const dmChat = { conversationId: 'dm-1', threadRootId: 'start-msg', moved: false, members: ['me', 'gaurav'] }
const groupChat = { conversationId: 'group-1', threadRootId: null, moved: true, members: ['me', 'gaurav', 'crab'] }
const line = (id: string, text: string, over: Record<string, unknown> = {}) =>
  ({ id, text, authorType: 'user', authorUserId: 'gaurav', author: { name: 'Gaurav' }, ...over }) as any

beforeEach(() => {
  calls.length = 0
  timelineArgs.length = 0
  timelineMessages = []
  sendResult = true
  failure = null
})
afterEach(cleanup)

describe('HuddleThreadPanel', () => {
  test('waits for the chat to be worked out', () => {
    const { getByText, queryByLabelText } = render(createElement(HuddleThreadPanel, { workspaceId: 'ws', huddleConversationId: 'dm-1', chat: null, canModerate: false }))
    expect(getByText('Chat opens once the call has started.')).toBeTruthy()
    expect(queryByLabelText('Huddle message')).toBeNull()
  })

  test('in a two-person call it chats in the DM under the huddle message', async () => {
    timelineMessages = [line('start-msg', 'started a huddle', { authorType: 'system' }), line('m1', 'hello there')]
    const { getByText, queryByText, getByLabelText, queryByTestId } = render(
      createElement(HuddleThreadPanel, { workspaceId: 'ws', huddleConversationId: 'dm-1', chat: dmChat, canModerate: false }),
    )
    expect(timelineArgs.at(-1)).toEqual(['ws', 'dm-1', 'start-msg'])
    expect(getByText('hello there')).toBeTruthy()
    // The start message is the thread root, not a line of the chat; and there is no "group" banner.
    expect(queryByText('started a huddle')).toBeNull()
    expect(queryByTestId('huddle-chat-group-note')).toBeNull()

    fireEvent.change(getByLabelText('Huddle message'), { target: { value: 'hi back' } })
    fireEvent.click(getByLabelText('Send'))
    await waitFor(() => expect(calls).toEqual(['send:dm-1:start-msg:hi back']))
  })

  test('once people are added it moves to the group and says who it is shared with', async () => {
    const { rerender, getByTestId, getByLabelText } = render(
      createElement(HuddleThreadPanel, { workspaceId: 'ws', huddleConversationId: 'dm-1', chat: dmChat, canModerate: false }),
    )
    rerender(createElement(HuddleThreadPanel, { workspaceId: 'ws', huddleConversationId: 'dm-1', chat: groupChat, canModerate: false }))
    expect(timelineArgs.at(-1)).toEqual(['ws', 'group-1', null])
    expect(getByTestId('huddle-chat-group-note').textContent).toBe('Chatting with the 3 people in this call')

    fireEvent.change(getByLabelText('Huddle message'), { target: { value: 'crab here' } })
    fireEvent.click(getByLabelText('Send'))
    await waitFor(() => expect(calls).toEqual(['send:group-1:null:crab here']))
  })

  test('a message that did not send stays in the box to retry', async () => {
    sendResult = false
    const { getByLabelText } = render(createElement(HuddleThreadPanel, { workspaceId: 'ws', huddleConversationId: 'dm-1', chat: dmChat, canModerate: false }))
    const input = getByLabelText('Huddle message') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'try me' } })
    fireEvent.click(getByLabelText('Send'))
    await waitFor(() => expect(calls).toHaveLength(1))
    await waitFor(() => expect(input.value).toBe('try me'))
  })

  test('mentions read as names', () => {
    timelineMessages = [line('m1', 'ping <@u:crab> please')]
    const { getByText } = render(createElement(HuddleThreadPanel, { workspaceId: 'ws', huddleConversationId: 'dm-1', chat: dmChat, canModerate: false }))
    expect(getByText('ping @Code the Crab please')).toBeTruthy()
  })

  test('polls and questions go through the call conversation, whatever chat the person is in', async () => {
    const { getByLabelText, getByText } = render(createElement(HuddleThreadPanel, { workspaceId: 'ws', huddleConversationId: 'dm-1', chat: groupChat, canModerate: false }))
    fireEvent.click(getByLabelText('Start a poll'))
    fireEvent.change(getByLabelText('Poll question'), { target: { value: 'Lunch?' } })
    fireEvent.change(getByLabelText('Poll option 1'), { target: { value: 'Pizza' } })
    fireEvent.change(getByLabelText('Poll option 2'), { target: { value: 'Sushi' } })
    fireEvent.click(getByText('Post poll'))
    await waitFor(() => expect(calls).toEqual(['poll:dm-1:Lunch?:Pizza|Sushi']))

    fireEvent.click(getByLabelText('Ask a question'))
    fireEvent.change(getByLabelText('Question'), { target: { value: 'Who drives?' } })
    fireEvent.click(getByText('Ask'))
    await waitFor(() => expect(calls).toContain('question:dm-1:Who drives?'))
  })

  test('a poll the server refuses says why', async () => {
    failure = new Error('Join the huddle first')
    const { getByLabelText, getByText } = render(createElement(HuddleThreadPanel, { workspaceId: 'ws', huddleConversationId: 'dm-1', chat: dmChat, canModerate: false }))
    fireEvent.click(getByLabelText('Start a poll'))
    fireEvent.change(getByLabelText('Poll question'), { target: { value: 'Q' } })
    fireEvent.change(getByLabelText('Poll option 1'), { target: { value: 'A' } })
    fireEvent.change(getByLabelText('Poll option 2'), { target: { value: 'B' } })
    fireEvent.click(getByText('Post poll'))
    await waitFor(() => expect(getByText('Join the huddle first')).toBeTruthy())
  })

  test('questions show on the Q&A tab with a count', () => {
    timelineMessages = [line('q1', 'Who drives?', { blocks: { question: { answered: false, upvotes: 0, voters: [] } } }), line('m1', 'plain')]
    const { getByText } = render(createElement(HuddleThreadPanel, { workspaceId: 'ws', huddleConversationId: 'dm-1', chat: dmChat, canModerate: false }))
    expect(getByText('Q&A (1)')).toBeTruthy()
  })

  test('poll options are trimmed, de-duplicated and capped at ten', () => {
    expect(pollOptionsFrom([' Yes ', 'yes', '', 'No  way'])).toEqual(['Yes', 'No way'])
    expect(pollOptionsFrom(Array.from({ length: 14 }, (_, i) => `o${i}`))).toHaveLength(10)
  })
})

describe('HuddleRequests', () => {
  const request = (id: string, name: string, guest = false) => ({ id, userId: guest ? null : `u-${id}`, name, image: null, guest, createdAt: '2026-10-21T00:00:00Z' })

  test('renders nothing when nobody is waiting', () => {
    const { container } = render(createElement(HuddleRequests, { requests: [] }))
    expect(container.innerHTML).toBe('')
  })

  test('lists who wants in, marks guests, and answers with Admit or Deny', async () => {
    const { getByText, getByLabelText } = render(createElement(HuddleRequests, { requests: [request('r1', 'Cy'), request('r2', 'Stranger', true)] }))
    expect(getByText('Cy wants to join')).toBeTruthy()
    expect(getByText('Guest · not in your workspace')).toBeTruthy()
    fireEvent.click(getByLabelText('Admit Cy'))
    await waitFor(() => expect(calls).toContain('admit:r1'))
    fireEvent.click(getByLabelText('Deny Stranger'))
    await waitFor(() => expect(calls).toContain('deny:r2'))
  })

  test('the floating card shows one request at a time with a count of the rest', () => {
    const { getByText, queryByText } = render(createElement(HuddleRequestStrip, { requests: [request('r1', 'Cy'), request('r2', 'Dee'), request('r3', 'Ed')] }))
    expect(getByText('Cy wants to join')).toBeTruthy()
    expect(queryByText('Dee wants to join')).toBeNull()
    expect(getByText('+2 more waiting')).toBeTruthy()
  })
})

describe('invitablePeople', () => {
  const huddle = { participants: [{ userId: 'me' }, { userId: 'gaurav' }] } as any

  test('leaves out you and everyone already in the call', () => {
    expect(invitablePeople(people, 'me', huddle, '').map((p) => p.id)).toEqual(['crab', 'dee'])
  })

  test('searches by name or email, ignoring case', () => {
    expect(invitablePeople(people, 'me', huddle, ' CRAB ').map((p) => p.id)).toEqual(['crab'])
    expect(invitablePeople(people, 'me', huddle, 'dee@').map((p) => p.id)).toEqual(['dee'])
    expect(invitablePeople(people, 'me', huddle, 'nobody')).toEqual([])
  })
})

describe('HuddleInviteSheet', () => {
  const huddle = {
    id: 'h1',
    participants: [{ userId: 'me' }, { userId: 'gaurav' }],
    invited: [{ userId: 'dee', name: 'Dee', image: null, status: 'ringing', invitedById: 'me' }],
  } as any

  test('rings the people picked and closes', async () => {
    let closed = false
    const { getByLabelText, queryByLabelText } = render(createElement(HuddleInviteSheet, { workspaceId: 'ws', huddle, onClose: () => void (closed = true) }))
    expect(queryByLabelText(/^Gaurav/)).toBeNull()
    fireEvent.click(getByLabelText('Code the Crab, crab@x.com'))
    fireEvent.click(getByLabelText('Ring 1 person'))
    await waitFor(() => expect(closed).toBe(true))
    expect(calls).toEqual(['invite:crab'])
  })

  test('someone already ringing can be cancelled', async () => {
    const { getByLabelText } = render(createElement(HuddleInviteSheet, { workspaceId: 'ws', huddle, onClose: () => {} }))
    fireEvent.click(getByLabelText('Cancel invitation to Dee'))
    await waitFor(() => expect(calls).toEqual(['cancel:dee']))
  })

  test('shows nothing to pick when everyone is already in', () => {
    const everyone = { ...huddle, participants: people.map((p) => ({ userId: p.id })) }
    const { getByText } = render(createElement(HuddleInviteSheet, { workspaceId: 'ws', huddle: everyone, onClose: () => {} }))
    expect(getByText('No one else to invite.')).toBeTruthy()
  })
})
