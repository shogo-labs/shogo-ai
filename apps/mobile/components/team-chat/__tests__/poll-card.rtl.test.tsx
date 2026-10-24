// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Polls and audience questions posted in a huddle thread: voting shows the
 * server's tally straight away, closed polls take no votes, and a question is
 * upvoted and marked answered by the people allowed to.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const calls: string[] = []
let nextMessage: any = null
let failure: Error | null = null

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web' },
    Pressable: ({ accessibilityLabel, accessibilityState, children, onPress, disabled, testID, accessibilityRole }: any) =>
      createElement(
        'button',
        {
          'aria-label': accessibilityLabel,
          'aria-checked': accessibilityState?.checked,
          'data-testid': testID,
          'data-role': accessibilityRole,
          disabled,
          onClick: onPress,
        },
        children,
      ),
    Text: ({ children }: any) => createElement('span', null, children),
  }),
)
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }))
mock.module('lucide-react-native', () => ({
  BarChart3: () => null,
  Check: () => null,
  ChevronUp: () => null,
  HelpCircle: () => null,
  Lock: () => null,
}))

const realApi = await import('../../../lib/team-chat-api')
mock.module('../../../lib/team-chat-api', () => ({
  ...realApi,
  teamChatApi: () => ({
    voteOnMessage: async (id: string, option: string) => {
      calls.push(`vote:${id}:${option}`)
      if (failure) throw failure
      return nextMessage
    },
    closePoll: async (id: string) => {
      calls.push(`close:${id}`)
      return nextMessage
    },
    setQuestionAnswered: async (id: string, answered: boolean) => {
      calls.push(`answered:${id}:${answered}`)
      return nextMessage
    },
  }),
}))

const { PollCardView, AudienceQuestionCardView } = await import('../PollCard')

const poll = (over: Record<string, unknown> = {}) => ({
  question: 'Ship it?',
  options: [{ id: 'y', text: 'Yes' }, { id: 'n', text: 'No' }],
  multiple: false,
  closed: false,
  tally: { y: 1 },
  voters: { y: ['ana'], n: [] },
  ...over,
})
const message = (blocks: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ id: 'm-1', text: 'Ship it?', authorUserId: 'ana', author: { name: 'Ana' }, blocks, ...over }) as any

beforeEach(() => {
  calls.length = 0
  nextMessage = null
  failure = null
})
afterEach(cleanup)

describe('PollCardView', () => {
  test('shows each option with its votes, and which one is yours', () => {
    const { getByLabelText, getByText } = render(createElement(PollCardView, { message: message({ poll: poll() }), me: 'ana' }))
    expect(getByText('Ship it?')).toBeTruthy()
    expect(getByLabelText('Yes, 1 vote').getAttribute('aria-checked')).toBe('true')
    expect(getByLabelText('No, 0 votes').getAttribute('aria-checked')).toBe('false')
    expect(getByText('1 person has voted')).toBeTruthy()
  })

  test('voting sends the pick and then shows the server tally', async () => {
    nextMessage = message({ poll: poll({ tally: { y: 1, n: 1 }, voters: { y: ['ana'], n: ['ben'] } }) })
    const { getByLabelText, getByText } = render(createElement(PollCardView, { message: message({ poll: poll() }), me: 'ben' }))
    fireEvent.click(getByLabelText('No, 0 votes'))
    await waitFor(() => expect(getByText('2 people have voted')).toBeTruthy())
    expect(calls).toEqual(['vote:m-1:n'])
    expect(getByLabelText('No, 1 vote').getAttribute('aria-checked')).toBe('true')
  })

  test('single choice uses radios, multiple choice uses checkboxes', () => {
    const single = render(createElement(PollCardView, { message: message({ poll: poll() }), me: 'ben' }))
    expect(single.getByTestId('poll-option-y').getAttribute('data-role')).toBe('radio')
    cleanup()
    const multi = render(createElement(PollCardView, { message: message({ poll: poll({ multiple: true }) }), me: 'ben' }))
    expect(multi.getByTestId('poll-option-y').getAttribute('data-role')).toBe('checkbox')
    expect(multi.getByText('1 person has voted · pick any')).toBeTruthy()
  })

  test('a closed poll takes no votes and offers no close button', () => {
    const { getByTestId, queryByText } = render(createElement(PollCardView, { message: message({ poll: poll({ closed: true }) }), me: 'ana' }))
    expect((getByTestId('poll-option-y') as HTMLButtonElement).disabled).toBe(true)
    expect(queryByText('Close poll')).toBeNull()
  })

  test('only the author or someone who manages the call can close it', async () => {
    const other = render(createElement(PollCardView, { message: message({ poll: poll() }), me: 'ben' }))
    expect(other.queryByText('Close poll')).toBeNull()
    cleanup()

    nextMessage = message({ poll: poll({ closed: true }) })
    const author = render(createElement(PollCardView, { message: message({ poll: poll() }), me: 'ana' }))
    fireEvent.click(author.getByText('Close poll'))
    await waitFor(() => expect(author.getByText(/closed/)).toBeTruthy())
    expect(calls).toEqual(['close:m-1'])
    cleanup()

    const host = render(createElement(PollCardView, { message: message({ poll: poll() }), me: 'ben', canManage: true }))
    expect(host.getByText('Close poll')).toBeTruthy()
  })

  test('a vote that fails says why and keeps the poll as it was', async () => {
    failure = new Error('This poll is closed')
    const { getByLabelText, getByText } = render(createElement(PollCardView, { message: message({ poll: poll() }), me: 'ben' }))
    fireEvent.click(getByLabelText('No, 0 votes'))
    await waitFor(() => expect(getByText('This poll is closed')).toBeTruthy())
    expect(getByLabelText('No, 0 votes').getAttribute('aria-checked')).toBe('false')
  })

  test('a message that is not a poll renders nothing', () => {
    const { container } = render(createElement(PollCardView, { message: message({}), me: 'ana' }))
    expect(container.innerHTML).toBe('')
  })
})

describe('AudienceQuestionCardView', () => {
  const question = (over: Record<string, unknown> = {}) => ({ answered: false, upvotes: 2, upvoters: ['ben'], ...over })

  test('shows who asked and the upvotes, and upvoting goes to the server', async () => {
    nextMessage = message({ question: question({ upvotes: 3, upvoters: ['ben', 'cy'] }), }, { text: 'When do we ship?' })
    const { getByLabelText, getByText } = render(createElement(AudienceQuestionCardView, { message: message({ question: question() }, { text: 'When do we ship?' }), me: 'cy' }))
    expect(getByText('Ana asked')).toBeTruthy()
    expect(getByText('When do we ship?')).toBeTruthy()
    fireEvent.click(getByLabelText('Upvote, 2 upvotes'))
    await waitFor(() => expect(getByLabelText('Remove upvote, 3 upvotes')).toBeTruthy())
    expect(calls).toEqual(['vote:m-1:up'])
  })

  test('the asker (or a host) can mark it answered, and others cannot', async () => {
    const other = render(createElement(AudienceQuestionCardView, { message: message({ question: question() }), me: 'ben' }))
    expect(other.queryByText('Mark answered')).toBeNull()
    cleanup()

    nextMessage = message({ question: question({ answered: true }) })
    const asker = render(createElement(AudienceQuestionCardView, { message: message({ question: question() }), me: 'ana' }))
    fireEvent.click(asker.getByText('Mark answered'))
    await waitFor(() => expect(asker.getByText('Mark unanswered')).toBeTruthy())
    expect(asker.getByText('Answered')).toBeTruthy()
    expect(calls).toEqual(['answered:m-1:true'])
    cleanup()

    const host = render(createElement(AudienceQuestionCardView, { message: message({ question: question() }), me: 'ben', canManage: true }))
    expect(host.getByText('Mark answered')).toBeTruthy()
  })
})
