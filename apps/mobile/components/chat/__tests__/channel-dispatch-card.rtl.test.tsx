// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The session shows a channel dispatch as a card in the same shape as an
 * answered question: who sent it, which channel, and the message. The wrapper
 * prompt stays hidden. An ordinary user message is unchanged, and the card
 * cannot be edited.
 */

import { resolve } from 'node:path'
import { createElement } from 'react'
import { describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import { conversationThreadRoute } from '../../../lib/team-chat-nav'

const pushed: unknown[] = []

mock.module('react-native', () => createReactNativeMock({
  Pressable: ({ accessibilityLabel, children, onPress, disabled }: any) =>
    createElement('button', { 'aria-label': accessibilityLabel, type: 'button', disabled, onClick: onPress }, children),
}))
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))
mock.module('expo-router', () => ({
  useRouter: () => ({ push: (route: unknown) => { pushed.push(route) } }),
}))
mock.module('expo-clipboard', () => ({ setStringAsync: async () => {} }))
mock.module(resolve(import.meta.dir, '../ChatInput.tsx'), () => ({ ChatInput: () => null }))
mock.module(resolve(import.meta.dir, '../turns/MessageContent.tsx'), () => ({
  MessageContent: ({ message }: { message: { content?: string; parts?: Array<{ type: string; text?: string }> } }) =>
    createElement('div', null, message.parts?.find((part) => part.type === 'text')?.text ?? message.content ?? ''),
}))
mock.module(resolve(import.meta.dir, '../../../lib/native-phone-layout.ts'), () => ({
  useIsNativePhoneLayout: () => false,
  usePhoneLayout: () => false,
  usePhoneLayoutOverride: () => null,
}))
mock.module(resolve(import.meta.dir, '../ChatContext.tsx'), () => ({
  useChatContextSafe: () => null,
}))

const { EditableUserMessage } = await import('../turns/EditableUserMessage')
const { MessageEditProvider } = await import('../turns/MessageEditContext')

const prompt = [
  'You are Ops, a teammate in the #ops channel.',
  'Team chat context: channel id c1, thread id t1.',
  '',
  'member [mentions you]: @Ops run the check',
].join('\n')

const dispatch = {
  conversationId: 'c1',
  conversationName: 'ops',
  threadRootId: 't1',
  agentName: 'Ops',
  trigger: { authorName: 'Russell', text: '@Ops run the check' },
  contextMode: 'shared',
}

function message(extra?: { parts?: unknown; content?: string }) {
  return {
    id: 'm1',
    role: 'user' as const,
    content: extra?.content ?? prompt,
    parts: extra?.parts ?? [
      { type: 'text', text: prompt },
      { type: 'data-channel-dispatch', data: dispatch },
    ],
  }
}

function renderMessage(node: ReturnType<typeof message>) {
  return render(
    <MessageEditProvider
      editMessage={async () => {}}
      retryFromMessage={async () => {}}
      countMessagesAfter={() => 0}
      isStreaming={false}
      canEditMessage={() => true}
      composerProps={{ isPro: true }}
    >
      <EditableUserMessage message={node as any} />
    </MessageEditProvider>,
  )
}

describe('channel dispatch card', () => {
  test('shows who asked, where, and what they said, and opens the thread', () => {
    pushed.length = 0
    renderMessage(message())
    expect(screen.getByText('Russell')).toBeTruthy()
    expect(screen.getByText('#ops')).toBeTruthy()
    expect(screen.getByText('@Ops run the check')).toBeTruthy()
    expect(screen.queryByText(/Team chat context:/)).toBeNull()
    expect(screen.queryByText(/Show full prompt/)).toBeNull()
    expect(screen.queryByLabelText('Edit this message and re-run from here')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Open #ops' }))
    expect(pushed).toEqual([conversationThreadRoute('c1', 't1')])
  })

  test('a hand-off says who passed the work', () => {
    renderMessage(message({
      parts: [
        { type: 'text', text: prompt },
        { type: 'data-channel-dispatch', data: { ...dispatch, handedOffBy: 'Builder' } },
      ],
    }))
    expect(screen.getByText('Builder')).toBeTruthy()
    expect(screen.getByText('#ops')).toBeTruthy()
    expect(screen.getByText('@Ops run the check')).toBeTruthy()
  })

  test('the message is rendered as markdown', () => {
    renderMessage(message({
      parts: [
        { type: 'text', text: prompt },
        { type: 'data-channel-dispatch', data: { ...dispatch, trigger: { authorName: 'Russell', text: '**bold** ask' } } },
      ],
    }))
    expect(screen.getByText('bold')).toBeTruthy()
    expect(screen.getByText(/ask/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('**')
  })

  test('an ordinary user message still shows its text and can be edited', () => {
    renderMessage(message({ content: 'please rename the button', parts: [{ type: 'text', text: 'please rename the button' }] }))
    expect(screen.getByText('please rename the button')).toBeTruthy()
    expect(screen.queryByText(/mentioned you in/)).toBeNull()
    expect(screen.getByLabelText('Edit this message and re-run from here')).toBeTruthy()
  })
})
