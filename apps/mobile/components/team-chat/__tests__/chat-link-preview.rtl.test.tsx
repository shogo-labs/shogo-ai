// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

// A `button` host does not translate `onPress` to a DOM handler; map it here so
// a click in the test is a press in the component.
mock.module('react-native', () =>
  createReactNativeMock({
    Pressable: ({ children, onPress, accessibilityLabel, testID, ...rest }: any) =>
      createElement(
        'button',
        { onClick: onPress, 'aria-label': accessibilityLabel, 'data-testid': testID, 'data-rn-shim': testID, ...rest },
        children,
      ),
  } as any),
)

mock.module('lucide-react-native', () => {
  const Icon = () => createElement('span')
  return { Hash: Icon, Lock: Icon, MessageSquare: Icon }
})
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }))
mock.module('../../../lib/chat-attachment-url', () => ({ resolveAvatarUrl: (u: string | null) => u }))
const opened: string[] = []
mock.module('../../../lib/chat-link-navigation', () => ({
  openChatLinkInApp: (target: any) => {
    opened.push(`${target.kind}:${target.conversationId}:${target.messageId ?? ''}`)
    return true
  },
}))

const calls: Array<{ kind: string; id: string }> = []
const previews: { message: () => Promise<any>; conversation: () => Promise<any> } = {
  message: async () => {
    throw new Error('set message')
  },
  conversation: async () => {
    throw new Error('set conversation')
  },
}

mock.module('../../../lib/team-chat-api', () => ({
  teamChatApi: () => ({
    messagePreview: async (id: string) => {
      calls.push({ kind: 'message', id })
      return previews.message()
    },
    conversationPreview: async (id: string) => {
      calls.push({ kind: 'conversation', id })
      return previews.conversation()
    },
  }),
}))

const { ChatLinkPreviews, __resetLinkPreviewCacheForTest } = await import('../ChatLinkPreview')

afterEach(() => {
  cleanup()
  calls.length = 0
  opened.length = 0
  // The card caches resolved and refused previews for the session; without this
  // one test's refusal would silence every later one.
  __resetLinkPreviewCacheForTest()
})

const MESSAGE_LINK = 'https://studio.shogo.ai/c/c1?msg=m1'

function message(text: string, blocks: Record<string, unknown> | null = null) {
  return { id: 'self', text, blocks }
}

function readyMessagePreview(overrides: Record<string, unknown> = {}) {
  return {
    conversation: { id: 'c1', name: 'team-us-shift', kind: 'private', topic: null, private: true },
    message: {
      id: 'm1',
      conversationId: 'c1',
      authorName: 'Eby Paul Daniel',
      authorImage: null,
      text: 'the 2.6.0 email goes out Monday',
      truncated: false,
      createdAt: new Date().toISOString(),
      threadRootId: null,
      replyCount: 0,
      deleted: false,
      ...overrides,
    },
  }
}

describe('link previews on a message', () => {
  test('a message with no chat link asks the server nothing', async () => {
    render(createElement(ChatLinkPreviews, { message: message('nothing to see, https://example.com/x') }))
    expect(calls).toEqual([])
    expect(screen.queryByTestId('chat-link-preview')).toBeNull()
  })

  test('renders the referenced message with its author and channel', async () => {
    previews.message = async () => readyMessagePreview()
    render(createElement(ChatLinkPreviews, { message: message(`look ${MESSAGE_LINK}`) }))
    const card = await screen.findByTestId('chat-link-preview')
    expect(card).toBeTruthy()
    expect(screen.getByText('Eby Paul Daniel')).toBeTruthy()
    expect(screen.getByText('the 2.6.0 email goes out Monday')).toBeTruthy()
    expect(screen.getByText('#team-us-shift')).toBeTruthy()
    expect(calls).toEqual([{ kind: 'message', id: 'm1' }])
  })

  test('a reader without access gets no card at all', async () => {
    previews.message = async () => {
      throw Object.assign(new Error('Message not found'), { status: 404 })
    }
    render(createElement(ChatLinkPreviews, { message: message(`look ${MESSAGE_LINK}`) }))
    await waitFor(() => expect(calls).toHaveLength(1))
    // Nothing renders — not a card, not a "no access" hint, and no fallback to
    // the generic website unfurl, which would reveal that something is there.
    expect(screen.queryByTestId('chat-link-preview')).toBeNull()
  })

  test('a link the author declined a preview for never reaches the server', async () => {
    render(
      createElement(ChatLinkPreviews, {
        message: message(`look ${MESSAGE_LINK}`, { linkPreviewsOff: [MESSAGE_LINK] }),
      }),
    )
    expect(screen.queryByTestId('chat-link-preview')).toBeNull()
    expect(calls).toEqual([])
  })

  test('"Show more" appears only when there is more to show', async () => {
    previews.message = async () => readyMessagePreview({ text: 'one line, nothing hidden' })
    const { unmount } = render(createElement(ChatLinkPreviews, { message: message(`look ${MESSAGE_LINK}`) }))
    await screen.findByTestId('chat-link-preview')
    expect(screen.queryByTestId('chat-link-preview-toggle')).toBeNull()
    unmount()
    cleanup()
    // Two different answers for the same link cannot both be cached — drop the
    // first so the second one is actually asked for.
    __resetLinkPreviewCacheForTest()

    previews.message = async () => readyMessagePreview({ text: 'line one\nline two\nline three' })
    render(createElement(ChatLinkPreviews, { message: message(`look ${MESSAGE_LINK}`) }))
    await screen.findByTestId('chat-link-preview')
    const toggle = screen.getByTestId('chat-link-preview-toggle')
    expect(toggle.textContent).toBe('Show more')
    fireEvent.click(toggle)
    expect(screen.getByTestId('chat-link-preview-toggle').textContent).toBe('Show less')
  })

  test('a deleted message says so instead of quoting it', async () => {
    previews.message = async () => readyMessagePreview({ deleted: true, text: '' })
    render(createElement(ChatLinkPreviews, { message: message(`look ${MESSAGE_LINK}`) }))
    await screen.findByTestId('chat-link-preview')
    expect(screen.getByText('This message was deleted.')).toBeTruthy()
  })

  test('a bare conversation link renders the channel, not a message', async () => {
    previews.conversation = async () => ({
      conversation: { id: 'c9', name: 'hiring', kind: 'public', topic: 'We are hiring', private: false },
    })
    render(createElement(ChatLinkPreviews, { message: message('see https://studio.shogo.ai/c/c9') }))
    await screen.findByTestId('chat-link-preview')
    expect(screen.getByText('#hiring')).toBeTruthy()
    expect(screen.getByText('We are hiring')).toBeTruthy()
    expect(calls).toEqual([{ kind: 'conversation', id: 'c9' }])
  })

  test('pressing the card opens the message in place', async () => {
    previews.message = async () => readyMessagePreview()
    render(createElement(ChatLinkPreviews, { message: message(`look ${MESSAGE_LINK}`) }))
    const card = await screen.findByTestId('chat-link-preview')
    fireEvent.click(card)
    expect(opened).toEqual(['message:c1:m1'])
  })

  test('"Show more" expands the card without navigating away', async () => {
    previews.message = async () => readyMessagePreview({ text: 'line one\nline two' })
    render(createElement(ChatLinkPreviews, { message: message(`look ${MESSAGE_LINK}`) }))
    await screen.findByTestId('chat-link-preview')
    fireEvent.click(screen.getByTestId('chat-link-preview-toggle'))
    expect(screen.getByTestId('chat-link-preview-toggle').textContent).toBe('Show less')
    // The card is NOT an ancestor of the toggle, so expanding cannot open the link.
    expect(opened).toEqual([])
  })

  test('a re-rendered row reuses the resolved preview instead of asking again', async () => {
    previews.message = async () => readyMessagePreview()
    const first = render(createElement(ChatLinkPreviews, { message: message(`look ${MESSAGE_LINK}`) }))
    await screen.findByTestId('chat-link-preview')
    expect(calls).toHaveLength(1)
    first.unmount()
    cleanup()

    // Same link, fresh row — the virtualized list does this constantly.
    render(createElement(ChatLinkPreviews, { message: message(`look ${MESSAGE_LINK}`) }))
    await screen.findByTestId('chat-link-preview')
    expect(calls).toHaveLength(1)
  })

  test('a transient failure is not remembered, so a retry can still work', async () => {
    previews.message = async () => {
      throw Object.assign(new Error('network'), { status: 500 })
    }
    const first = render(createElement(ChatLinkPreviews, { message: message(`look ${MESSAGE_LINK}`) }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(screen.queryByTestId('chat-link-preview')).toBeNull()
    first.unmount()
    cleanup()

    previews.message = async () => readyMessagePreview()
    render(createElement(ChatLinkPreviews, { message: message(`look ${MESSAGE_LINK}`) }))
    expect(await screen.findByTestId('chat-link-preview')).toBeTruthy()
    expect(calls).toHaveLength(2)
  })

  test('a thread reply is labelled as one', async () => {
    previews.message = async () => readyMessagePreview({ threadRootId: 'root' })
    render(createElement(ChatLinkPreviews, { message: message(`look ${MESSAGE_LINK}`) }))
    await screen.findByTestId('chat-link-preview')
    expect(screen.getByText('Replied in a thread')).toBeTruthy()
  })
})
