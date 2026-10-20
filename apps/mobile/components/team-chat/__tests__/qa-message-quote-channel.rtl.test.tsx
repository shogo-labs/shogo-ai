// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for SHO-70, criterion 1: "A message link in a channel, group DM
 * or DM renders as a quote card (channel, author, snippet, time)".
 *
 * The dev's own quoted-message spec covers author, time and snippet; this file
 * pins the part that is still missing: the quote has to say *where* the message
 * lives. A quote whose only label is the author is ambiguous the moment two
 * people are talking about the same thing in two channels, which is exactly the
 * case a shared link is for.
 *
 * The channel identity rides on the message response as `message.conversation`
 * (`GET /api/conversation-messages/:id`), the same shape
 * `qa-sho70-quote-and-viewer.acceptance.test.ts` pins server-side, so the card
 * never needs a second request it has no id for.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const pushes: Array<{ pathname: string; params: Record<string, unknown> }> = []

mock.module('expo-router', () => ({
  useRouter: () => ({
    push: (target: { pathname: string; params: Record<string, unknown> }) => pushes.push(target),
  }),
}))

mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

mock.module('lucide-react-native', () => ({
  CornerDownRight: () => createElement('span', { 'data-icon': 'CornerDownRight' }),
  MessageSquare: () => createElement('span', { 'data-icon': 'MessageSquare' }),
}))

const base = {
  id: 'm-1',
  conversationId: 'conv-1',
  workspaceId: 'ws-1',
  seq: 4,
  threadRootId: null,
  replyCount: 0,
  lastReplyAt: null,
  alsoSentToChannel: false,
  authorType: 'user' as const,
  author: { id: 'u-1', name: 'Ana Lopez', image: null },
  authorUserId: 'u-1',
  authorAgent: null,
  text: 'The migration is ready for review — 12 tables, no data loss.',
  blocks: null,
  clientMsgId: null,
  agentSessionId: null,
  agentStatus: null,
  reactions: [],
  attachments: [],
  editedAt: null,
  deletedAt: null,
  createdAt: '2026-10-19T17:04:00.000Z',
}

mock.module(resolve(import.meta.dir, '../../../lib/team-chat-api'), () => ({
  teamChatApi: () => ({
    message: async (id: string) => {
      if (id === 'm-dm') {
        return { ...base, id, conversation: { id: 'dm-1', name: null, kind: 'dm' } }
      }
      return { ...base, id, conversation: { id: 'conv-1', name: 'shogo-dev', kind: 'public' } }
    },
  }),
}))

mock.module('react-native', () =>
  createReactNativeMock({
    Pressable: (({
      accessibilityLabel,
      accessibilityRole,
      children,
      onPress,
      disabled,
      testID,
      ...props
    }: {
      accessibilityLabel?: string
      accessibilityRole?: string
      children?: ReactNode
      onPress?: () => void
      disabled?: boolean
      testID?: string
    }) =>
      createElement(
        'button',
        {
          ...props,
          role: accessibilityRole,
          'aria-label': accessibilityLabel,
          'data-testid': testID,
          disabled,
          onClick: () => {
            if (!disabled) onPress?.()
          },
        },
        children,
      )) as never,
  }),
)

const { MessageQuoteCard } = await import('../MessageQuoteCard')

afterEach(cleanup)

beforeEach(() => {
  pushes.length = 0
})

const target = (messageId: string) => ({ conversationId: 'conv-1', messageId, threadRootId: null })
const href = 'https://studio.shogo.ai/c/conv-1?msg=m-1'

describe('a quoted message says where it came from', () => {
  test('a channel message is labelled with the channel it was posted in', async () => {
    const { container } = render(<MessageQuoteCard quote={{ href, target: target('m-1') }} />)
    await screen.findByText('Ana Lopez')

    expect(container.textContent).toContain('#shogo-dev')
    // The label does not come at the cost of the rest of the quote.
    expect(container.textContent).toContain('Ana Lopez')
    expect(container.textContent).toContain('The migration is ready for review')
  })

  test('a direct message is labelled as a DM rather than with a channel name', async () => {
    const { container } = render(<MessageQuoteCard quote={{ href, target: target('m-dm') }} />)
    await screen.findByText('Ana Lopez')

    expect(container.textContent).toContain('DM')
  })

  test('the channel label is still a single tap to the message', async () => {
    render(<MessageQuoteCard quote={{ href, target: target('m-1') }} />)
    await screen.findByText('Ana Lopez')

    fireEvent.click(screen.getByTestId('message-quote'))
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.params).toMatchObject({ conversationId: 'conv-1', msg: 'm-1' })
  })
})
