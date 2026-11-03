// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-294: a quote card tapped inside an open thread replaces that thread.
 *
 * This is the click Russell described — a thread open in a channel, then a
 * quote card pointing at another thread. It used to `router.push` a second
 * `/c/[conversationId]` screen, so the new thread landed on top of the open one
 * instead of taking its place.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import * as lucideStub from '../../../test/stubs/lucide-react-native'
import { setThreadFocus } from '../../../lib/team-chat-nav'

const pushes: Array<{ pathname: string; params: Record<string, unknown> }> = []
const setParamsCalls: Array<Record<string, unknown>> = []

// The shared mock forwards props to the DOM, but `onPress` is not a DOM
// handler — a shim that wires it to onClick is what makes a tap testable.
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
      children?: unknown
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
        children as never,
      )) as never,
  }),
)

mock.module('expo-router', () => ({
  useRouter: () => ({
    push: (target: { pathname: string; params: Record<string, unknown> }) => pushes.push(target),
    setParams: (next: Record<string, unknown>) => setParamsCalls.push(next),
  }),
}))
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))
mock.module('lucide-react-native', () => lucideStub)

const quoted = {
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
  text: 'Thread B is the one that should be on screen.',
  blocks: null,
  clientMsgId: null,
  agentSessionId: null,
  agentStatus: null,
  reactions: [],
  attachments: [],
  editedAt: null,
  deletedAt: null,
  createdAt: '2026-11-02T09:00:00.000Z',
  conversation: { id: 'conv-1', name: 'shogo-dev', kind: 'public' as const },
}

mock.module(resolve(import.meta.dir, '../../../lib/team-chat-api'), () => ({
  teamChatApi: () => ({ message: async (id: string) => ({ ...quoted, id }) }),
}))

const { MessageQuoteCard } = await import('../MessageQuoteCard')

const quote = {
  href: 'https://studio.shogo.ai/c/conv-1?msg=m-1&thread=B',
  target: { conversationId: 'conv-1', messageId: 'm-1', threadRootId: 'B' },
}

describe('a quote card inside an open thread', () => {
  const owner = {}
  beforeEach(() => {
    pushes.length = 0
    setParamsCalls.length = 0
  })
  afterEach(() => {
    setThreadFocus(null, owner)
    cleanup()
  })

  test('replaces the open thread in place', async () => {
    setThreadFocus({ conversationId: 'conv-1', threadRootId: 'A' }, owner)
    render(createElement(MessageQuoteCard, { names: {}, quote } as never))
    await screen.findByText('Ana Lopez')

    fireEvent.click(screen.getByTestId('message-quote'))

    expect(pushes).toEqual([])
    expect(setParamsCalls.at(-1)).toMatchObject({ thread: 'B', msg: 'm-1' })
  })

  test('still pushes when no thread is open, so Back closes it', async () => {
    setThreadFocus({ conversationId: 'conv-1', threadRootId: null }, owner)
    render(createElement(MessageQuoteCard, { names: {}, quote } as never))
    await screen.findByText('Ana Lopez')

    fireEvent.click(screen.getByTestId('message-quote'))

    expect(setParamsCalls).toEqual([])
    expect(pushes).toEqual([
      { pathname: '/(app)/c/[conversationId]', params: { conversationId: 'conv-1', thread: 'B', msg: 'm-1' } },
    ])
  })
})
