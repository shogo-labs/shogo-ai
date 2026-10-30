// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reproduction: opening an agent session shows the channel dispatch wrapper
 * ("Team chat context: …") as the user's message. That text is the prompt the
 * model sees, not something to render. A message that carries a
 * data-channel-dispatch part should show a card instead.
 *
 * MessageContent and ChatInput are stubbed so this file does not evaluate
 * react-native-marked (it imports a second copy of React Native that Bun
 * cannot parse). The stub still prints the text part, which is what the
 * session shows today.
 */

import { resolve } from 'node:path'
import { createElement } from 'react'
import { describe, expect, mock, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () => createReactNativeMock())
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))
mock.module('expo-router', () => ({ useRouter: () => ({ push: () => {} }) }))
mock.module('expo-clipboard', () => ({ setStringAsync: async () => {} }))
mock.module(resolve(import.meta.dir, '../ChatInput.tsx'), () => ({
  ChatInput: () => null,
}))
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

const prompt = [
  'You are Ops, a teammate in the #ops channel.',
  'Team chat context: channel id c1, thread id t1.',
  '',
  'member [mentions you]: @Ops run the check',
].join('\n')

const message = {
  id: 'm1',
  role: 'user' as const,
  content: prompt,
  parts: [
    { type: 'text', text: prompt },
    {
      type: 'data-channel-dispatch',
      data: {
        conversationId: 'c1',
        conversationName: 'ops',
        threadRootId: 't1',
        agentName: 'Ops',
        trigger: { authorName: 'member', text: '@Ops run the check' },
        contextMode: 'shared',
      },
    },
  ],
}

describe('channel dispatch rendering', () => {
  test('the dispatch wrapper is not shown as the message text', () => {
    render(<EditableUserMessage message={message as any} />)
    expect(screen.queryByText(/Team chat context:/)).toBeNull()
  })
})
