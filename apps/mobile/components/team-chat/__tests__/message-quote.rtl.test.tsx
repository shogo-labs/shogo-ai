// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A quoted message as a reader meets it: who wrote it, when, the opening of
 * what they said — and, for a message this viewer can't read, one neutral card
 * that says nothing about which channel it lives in.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import * as lucideStub from '../../../test/stubs/lucide-react-native'

const pushes: Array<{ pathname: string; params: Record<string, unknown> }> = []

mock.module('expo-router', () => ({
  useRouter: () => ({
    push: (target: { pathname: string; params: Record<string, unknown> }) => pushes.push(target),
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
  conversation: { id: 'conv-1', name: 'shogo-dev', kind: 'public' as const },
}

function failWith(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status })
}

/** Every message id the card asked the server for, in order. */
const asked: string[] = []

mock.module(resolve(import.meta.dir, '../../../lib/team-chat-api'), () => ({
  teamChatApi: () => ({
    message: async (id: string) => {
      asked.push(id)
      if (id === 'm-gone') throw failWith(404)
      if (id === 'm-deleted') return { ...quoted, id, deletedAt: '2026-10-19T18:00:00.000Z', text: '' }
      if (id === 'm-dm')
        return { ...quoted, id, conversation: { id: 'dm-1', name: null, kind: 'dm' as const } }
      return { ...quoted, id }
    },
    // This replacement is process-wide, so keep the rest of the surface a sibling
    // suite in the same run expects; nothing here calls it.
    fileMeta: async () => {
      throw failWith(404)
    },
    fileText: async () => {
      throw failWith(404)
    },
  }),
  absoluteApiUrl: (url: string) => url,
}))

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

const { MessageQuoteCard, resetMessageQuoteCache } = await import('../MessageQuoteCard')

afterEach(cleanup)

beforeEach(() => {
  pushes.length = 0
  asked.length = 0
  resetMessageQuoteCache()
})

const target = (messageId: string) => ({ conversationId: 'conv-1', messageId, threadRootId: null })
const href = 'https://studio.shogo.ai/c/conv-1?msg=m-1'

describe('a quoted message', () => {
  test('shows where it came from, who wrote it, when, and the opening of the message', async () => {
    const { container } = render(<MessageQuoteCard quote={{ href, target: target('m-1') }} />)

    await screen.findByText('Ana Lopez')
    // A quote is only a reference if you can see which channel it came from.
    expect(container.textContent).toContain('#shogo-dev')
    expect(container.textContent).toContain('Ana Lopez')
    expect(container.textContent).toContain('The migration is ready for review')
    expect(container.textContent).toContain('Jump to message')
  })

  test('a quote from a DM says DM, not a channel name', async () => {
    const { container } = render(<MessageQuoteCard quote={{ href, target: target('m-dm') }} />)

    await screen.findByText('Ana Lopez')
    expect(container.textContent).toContain('DM')
    expect(container.textContent).not.toContain('#')
  })

  test('two quotes of the same message ask the server once', async () => {
    render(<MessageQuoteCard quote={{ href, target: target('m-1') }} />)
    await screen.findByText('Ana Lopez')

    cleanup()
    render(<MessageQuoteCard quote={{ href, target: target('m-1') }} />)
    await screen.findByText('Ana Lopez')

    expect(asked).toEqual(['m-1'])
  })

  test('opens the message in place when tapped', async () => {
    render(<MessageQuoteCard quote={{ href, target: target('m-1') }} />)
    await screen.findByText('Ana Lopez')

    fireEvent.click(screen.getByTestId('message-quote'))
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.pathname).toBe('/(app)/c/[conversationId]')
    expect(pushes[0]!.params).toMatchObject({ conversationId: 'conv-1', msg: 'm-1' })
  })

  test('a message that was deleted says so and goes nowhere', async () => {
    const { container } = render(<MessageQuoteCard quote={{ href, target: target('m-deleted') }} />)
    await screen.findByText((content) => content.includes('deleted'))
    expect(container.textContent).toContain('This message was deleted.')

    fireEvent.click(screen.getByTestId('message-quote'))
    expect(pushes).toHaveLength(0)
  })

  test('a message this viewer cannot read is one neutral card, not a hint', async () => {
    const { container } = render(<MessageQuoteCard quote={{ href, target: target('m-gone') }} />)
    await screen.findByText('Message unavailable')

    expect(container.textContent).toContain('Message unavailable')
    // Nothing about which conversation it was in, or whether it exists.
    expect(container.textContent).not.toContain('conv-1')
    expect(container.textContent).not.toContain('Ana')
    // And nothing here is a link: there is nowhere useful for it to go.
    expect(container.querySelector('button')).toBeNull()
    expect(pushes).toHaveLength(0)
  })
})
