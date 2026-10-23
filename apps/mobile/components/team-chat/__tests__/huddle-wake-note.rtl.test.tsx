// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The note a spoken "hey Shogo" leaves in the huddle chat. Its message text is
 * the whole transcript the agent was given, so the chat must show the request
 * and keep the transcript behind a toggle — otherwise a minute of speech lands
 * in the channel as one enormous message.
 */
import { describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Pressable: ({ onPress, children, ...props }: any) => createElement('button', { ...props, onClick: onPress }, children),
  }),
)
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

const { HuddleWakeNote, huddleWakeBlockOf } = await import('../HuddleWakeNote')

const block = {
  huddleId: 'h1',
  meetingId: 'm1',
  speakerId: 'u1',
  speakerName: 'Ada',
  request: 'make a card for the login bug',
  contextSeconds: 60,
  participants: ['u1', 'u2'],
  transcript: [
    { speaker: 'Grace', start: 5, text: 'the login button is broken on safari' },
    { speaker: 'Ada', start: 65, text: 'hey shogo make a card for the login bug' },
  ],
}

const note = () => document.querySelector('[data-rn-shim="huddle-wake-note"]')

describe('HuddleWakeNote', () => {
  test('shows who woke the agent and what they asked for', () => {
    render(createElement(HuddleWakeNote, { block, createdAt: '10:04' }))
    expect(note()).not.toBeNull()
    expect(screen.getByText('⚡ Ada woke Shogo in the huddle')).toBeInTheDocument()
    expect(screen.getByText('“make a card for the login bug”')).toBeInTheDocument()
    expect(screen.getByText('10:04')).toBeInTheDocument()
  })

  test('keeps the transcript behind a toggle, then shows it with speaker and clock', () => {
    render(createElement(HuddleWakeNote, { block }))
    expect(screen.queryByText('the login button is broken on safari')).toBeNull()

    fireEvent.click(screen.getByText('▸ Show transcript (2)'))
    expect(screen.getByText('the login button is broken on safari')).toBeInTheDocument()
    expect(screen.getByText('Grace')).toBeInTheDocument()
    // 5 s into the call, and 65 s in.
    expect(screen.getByText('0:05')).toBeInTheDocument()

    fireEvent.click(screen.getByText('▾ Hide transcript'))
    expect(screen.queryByText('the login button is broken on safari')).toBeNull()
  })

  test('a wake with nothing transcribed says so instead of offering an empty list', () => {
    render(createElement(HuddleWakeNote, { block: { ...block, request: '', transcript: [] } }))
    expect(screen.getByText('Asked Shogo to listen to the call')).toBeInTheDocument()
    expect(screen.queryByText(/transcript/)).toBeNull()
  })

  test('reads the block out of a message, and ignores a message without one', () => {
    expect(huddleWakeBlockOf({ huddleWake: block })).toMatchObject({ speakerName: 'Ada' })
    expect(huddleWakeBlockOf(null)).toBeNull()
    expect(huddleWakeBlockOf({ huddleNotes: { huddleId: 'h1' } })).toBeNull()
    expect(huddleWakeBlockOf({ huddleWake: { request: 'x' } })).toBeNull()
  })
})
