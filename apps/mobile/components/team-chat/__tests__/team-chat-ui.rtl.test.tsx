// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Fragment, createElement, forwardRef, useImperativeHandle } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const sentTyping: string[] = []
const copied: string[] = []
const uploaded: string[] = []
const updates: Array<{ id: string; patch: unknown }> = []

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Pressable: ({ accessibilityLabel, children, onPress, onHoverIn, onHoverOut, disabled, testID }: any) =>
      createElement(
        'div',
        { role: 'button', 'aria-label': accessibilityLabel, onClick: onPress, onMouseEnter: onHoverIn, onMouseLeave: onHoverOut, disabled, 'data-testid': testID },
        children,
      ),
    TextInput: forwardRef(function Input({ value, onChangeText, onSelectionChange, onKeyPress, placeholder, accessibilityLabel }: any, ref: any) {
      return createElement('textarea', {
        ref,
        value,
        placeholder,
        'aria-label': accessibilityLabel ?? placeholder,
        onChange: (e: any) => {
          onChangeText?.(e.target.value)
          const end = e.target.value.length
          onSelectionChange?.({ nativeEvent: { selection: { start: end, end } } })
        },
        onKeyDown: (e: any) => onKeyPress?.({ nativeEvent: { key: e.key, shiftKey: e.shiftKey }, preventDefault: () => e.preventDefault() }),
      })
    }),
    FlatList: forwardRef(function List({ data, renderItem, keyExtractor, ListEmptyComponent, ListFooterComponent }: any, ref: any) {
      useImperativeHandle(ref, () => ({ scrollToIndex() {}, scrollToOffset() {} }))
      return createElement(
        'div',
        null,
        data.length
          ? data.map((item: any, index: number) => createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index })))
          : ListEmptyComponent,
        ListFooterComponent,
      )
    }),
  } as any),
)
mock.module('expo-clipboard', () => ({
  setStringAsync: async (text: string) => {
    copied.push(text)
    return true
  },
}))
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }))
mock.module('../../chat/MarkdownText', () => ({ MarkdownText: ({ children }: any) => createElement('p', null, children) }))
mock.module('../../../lib/team-chat-connection', () => ({
  useTeamChatEvents: () => 'closed',
  sendTyping: (_ws: string, conversationId: string) => sentTyping.push(conversationId),
}))
mock.module('../../../lib/team-chat-api', () => ({
  absoluteApiUrl: (url: string) => url,
  newClientMsgId: () => 'client-msg-1',
  conversationTitle: () => 'DM',
  isAgentDm: () => false,
  teamChatApi: () => ({
    upload: async (_id: string, file: { name: string }) => {
      uploaded.push(file.name)
      return { id: `att-${file.name}`, name: file.name, mimeType: 'text/plain', size: 1, width: null, height: null, url: '/f' }
    },
    update: async (id: string, patch: unknown) => {
      updates.push({ id, patch })
      return {}
    },
  }),
}))
mock.module('../../../hooks/usePresence', () => ({ usePresence: () => null }))
mock.module('../../../hooks/useChatItems', () => ({
  useDraft: () => ({ stored: '', save: () => {} }),
  useIsSaved: () => false,
  toggleSaved: async () => {},
}))
mock.module('../../../hooks/useChatPrefs', () => ({
  useUserStatus: () => null,
}))
mock.module('../../../hooks/useCustomEmoji', () => ({
  useCustomEmoji: () => new Map(),
  customEmojiFor: () => null,
  jumboEmojiCodes: () => null,
}))
mock.module('../../../hooks/useChatShortcuts', () => ({
  useEditRequest: () => {},
}))
mock.module('../../../hooks/useTeamChat', () => ({}))
mock.module('expo-router', () => ({}))

const { Composer } = await import('../Composer')
const { MessageRow } = await import('../MessageRow')
const { MessageList } = await import('../MessageList')
const { ConversationHeader } = await import('../ConversationHeader')

const mentionables = {
  people: [
    { id: 'u-me', name: 'Me Myself', email: 'me@x.io', image: null, role: 'owner' },
    { id: 'u-ana', name: 'Ana Lopez', email: 'ana@x.io', image: null, role: 'member' },
  ],
  agents: [{ key: 'p:proj-1', projectId: 'proj-1', name: 'Billing Bot', description: null, image: null }],
}

/** Host views keep `testID` as `data-rn-shim`. */
function shim(id: string): HTMLElement | null {
  return document.querySelector(`[data-rn-shim="${id}"]`)
}

function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
}

describe('Composer', () => {
  test('@ autocomplete inserts a mention that is sent as a wire token', async () => {
    const onSend = mock(async () => {})
    render(
      <Composer workspaceId="ws" conversationId="c1" placeholder="Message #general" mentionables={mentionables} me="u-me" onSend={onSend} />,
    )
    const input = screen.getByLabelText('Message')
    type(input, 'ask @bil')
    expect(screen.getByText('Billing Bot')).toBeTruthy()
    expect(screen.queryByText('Me Myself')).toBeNull()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect((input as HTMLTextAreaElement).value).toBe('ask @Billing Bot ')

    type(input, 'ask @Billing Bot about @ana')
    fireEvent.keyDown(input, { key: 'Tab' })
    type(input, 'ask @Billing Bot about @Ana Lopez now')
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(onSend).toHaveBeenCalledWith({
      text: 'ask <@a:p:proj-1> about <@u:u-ana> now',
      attachmentIds: [],
      alsoSentToChannel: undefined,
    })
    expect((input as HTMLTextAreaElement).value).toBe('')
    expect(sentTyping).toContain('c1')
  })

  test('Escape dismisses suggestions; Shift+Enter does not send; threads offer "also send to channel"', async () => {
    const onSend = mock(async () => {})
    render(
      <Composer workspaceId="ws" conversationId="c1" threadRootId="root-1" placeholder="Reply" mentionables={mentionables} me="u-me" onSend={onSend} />,
    )
    const input = screen.getByLabelText('Message')
    type(input, '@an')
    expect(screen.getByText('Ana Lopez')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByText('Ana Lopez')).toBeNull()

    type(input, 'done')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Also send to channel'))
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(onSend).toHaveBeenCalledWith({ text: 'done', attachmentIds: [], alsoSentToChannel: true })
  })

  test('read-only conversations explain why instead of showing an input', () => {
    render(
      <Composer workspaceId="ws" conversationId="c1" placeholder="x" mentionables={null} me="u-me" disabled disabledReason="This channel is archived." onSend={() => {}} />,
    )
    expect(screen.getByText('This channel is archived.')).toBeTruthy()
    expect(screen.queryByLabelText('Message')).toBeNull()
  })
})

function message(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'm1', conversationId: 'c1', workspaceId: 'ws', seq: 1, threadRootId: null, replyCount: 0, lastReplyAt: null,
    alsoSentToChannel: false, authorType: 'user', author: { id: 'u-ana', name: 'Ana Lopez', image: null },
    authorUserId: 'u-ana', authorAgent: null, text: 'hi <@a:p:proj-1>', blocks: null, clientMsgId: null,
    agentSessionId: null, agentStatus: null, reactions: [], attachments: [], editedAt: null, deletedAt: null,
    createdAt: '2026-09-29T10:00:00.000Z', ...overrides,
  }
}

const names = { users: new Map([['u-ana', 'Ana Lopez']]), agents: new Map([['p:proj-1', 'Billing Bot']]) }
const handlers = () => ({
  onReact: mock(() => {}), onEdit: mock(async () => {}), onDelete: mock(() => {}), onStopAgent: mock(() => {}),
  onRetry: mock(() => {}), onDiscard: mock(() => {}), onReply: mock(() => {}), onOpenSession: mock(() => {}),
})

describe('MessageRow', () => {
  test('renders mentions by name, and a running agent reply streams with a Stop control', () => {
    const h = handlers()
    const { rerender } = render(<MessageRow message={message()} grouped={false} me="u-me" names={names} canManage={false} {...h} />)
    expect(screen.getByText('hi **@Billing Bot**')).toBeTruthy()

    const agentReply = message({
      id: 'm2', authorType: 'agent', author: null, authorUserId: null, authorAgent: { projectId: 'proj-1', name: 'Billing Bot' },
      text: '', agentStatus: 'running', agentSessionId: 's1', threadRootId: 'm1',
    })
    rerender(
      <MessageRow message={agentReply} grouped={false} me="u-me" names={names} canManage={false} inThread streaming={{ text: 'Checking invoices', tool: 'web_search' }} {...h} />,
    )
    expect(screen.getByText('AGENT')).toBeTruthy()
    expect(screen.getByText('Checking invoices')).toBeTruthy()
    expect(screen.getByText('Using web_search…')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Stop agent'))
    expect(h.onStopAgent).toHaveBeenCalled()
    expect(screen.queryByText('Open full session')).toBeNull()

    rerender(
      <MessageRow message={{ ...agentReply, agentStatus: 'done', text: 'All paid.' }} grouped={false} me="u-me" names={names} canManage={false} inThread {...h} />,
    )
    fireEvent.click(screen.getByText('Open full session'))
    expect(h.onOpenSession).toHaveBeenCalled()
  })

  test('failed sends offer retry and discard; threads show reply counts', () => {
    const h = handlers()
    const { rerender } = render(
      <MessageRow message={message({ pending: 'failed', clientMsgId: 'cm1', authorUserId: 'u-me' })} grouped={false} me="u-me" names={names} canManage={false} {...h} />,
    )
    fireEvent.click(screen.getByText('Retry'))
    expect(h.onRetry).toHaveBeenCalled()
    fireEvent.click(screen.getByText('Discard'))
    expect(h.onDiscard).toHaveBeenCalled()

    rerender(<MessageRow message={message({ replyCount: 3 })} grouped={false} me="u-me" names={names} canManage={false} {...h} />)
    fireEvent.click(screen.getByText('3 replies'))
    expect(h.onReply).toHaveBeenCalled()
  })

  test('#activity lines can be discussed in a thread', () => {
    const h = handlers()
    render(
      <MessageRow
        message={message({ authorType: 'system', author: null, authorUserId: null, text: '**Billing Bot** finished a task', blocks: { type: 'activity', kind: 'task.completed' }, replyCount: 1 })}
        grouped={false} me="u-me" names={names} canManage={false} {...h}
      />,
    )
    fireEvent.click(screen.getByText('1 reply'))
    expect(h.onReply).toHaveBeenCalledTimes(1)
  })

  test('copy link copies a link to the message; mark unread is offered outside threads', async () => {
    const h = { ...handlers(), onMarkUnread: mock(() => {}) }
    const { container } = render(
      <MessageRow message={message({ id: 'm7', seq: 7 })} grouped={false} me="u-me" names={names} canManage={false} {...h} />,
    )
    fireEvent.mouseEnter(container.querySelector('[role="button"]')!)
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Copy link'))
    })
    expect(copied.at(-1)).toMatch(/\/c\/c1\?msg=m7$/)
    expect(screen.getByLabelText('Link copied')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Mark unread'))
    expect(h.onMarkUnread).toHaveBeenCalledTimes(1)

    cleanup()
    const thread = render(<MessageRow message={message({ id: 'r1', threadRootId: 'm7' })} grouped={false} me="u-me" names={names} canManage={false} inThread {...h} />)
    fireEvent.mouseEnter(thread.container.querySelector('[role="button"]')!)
    expect(screen.queryByLabelText('Mark unread')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Copy link'))
    })
    expect(copied.at(-1)).toMatch(/\/c\/c1\?thread=m7&msg=r1$/)
  })

  test('more reactions opens the searchable picker', () => {
    const h = handlers()
    const { container } = render(<MessageRow message={message()} grouped={false} me="u-me" names={names} canManage={false} workspaceId="ws" {...h} />)
    fireEvent.mouseEnter(container.querySelector('[role="button"]')!)
    fireEvent.click(screen.getByLabelText('More reactions'))
    fireEvent.change(screen.getByLabelText('Search emoji'), { target: { value: 'rocket' } })
    fireEvent.click(screen.getByLabelText('rocket'))
    expect(h.onReact).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), '🚀')
    expect(shim('emoji-picker')).toBeNull()
  })
})

describe('Composer emoji and files', () => {
  test(':shortcode suggests emoji, and a finished :code: becomes the emoji', () => {
    render(<Composer workspaceId="ws" conversationId="c1" placeholder="x" mentionables={mentionables} me="u-me" onSend={() => {}} />)
    const input = screen.getByLabelText('Message') as HTMLTextAreaElement
    type(input, 'ship it :tad')
    expect(shim('emoji-suggestions')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe('ship it 🎉 ')

    type(input, 'nice :+1:')
    expect(input.value).toBe('nice 👍')
    type(input, 'see :not_an_emoji_code:')
    expect(input.value).toBe('see :not_an_emoji_code:')
  })

  test('the emoji button opens a searchable picker that inserts at the cursor', () => {
    render(<Composer workspaceId="ws" conversationId="c1" placeholder="x" mentionables={mentionables} me="u-me" onSend={() => {}} />)
    const input = screen.getByLabelText('Message') as HTMLTextAreaElement
    type(input, 'launch')
    fireEvent.click(screen.getByLabelText('Emoji'))
    fireEvent.change(screen.getByLabelText('Search emoji'), { target: { value: 'rocket' } })
    fireEvent.click(screen.getByLabelText('rocket'))
    expect(input.value).toBe('launch 🚀 ')
    expect(shim('emoji-picker')).toBeNull()
  })

  test('pasting files uploads them as attachments; pasting text does not', async () => {
    uploaded.length = 0
    render(<Composer workspaceId="ws" conversationId="c1" placeholder="x" mentionables={mentionables} me="u-me" onSend={() => {}} />)
    const input = screen.getByLabelText('Message')
    const paste = (files: File[]) => {
      const event = new Event('paste', { bubbles: true, cancelable: true }) as any
      event.clipboardData = { files }
      input.dispatchEvent(event)
      return event
    }
    expect(paste([]).defaultPrevented).toBe(false)
    await act(async () => {
      expect(paste([new File(['x'], 'screenshot.png', { type: 'image/png' })]).defaultPrevented).toBe(true)
    })
    expect(uploaded).toEqual(['screenshot.png'])
    expect(screen.getByText('screenshot.png')).toBeTruthy()
  })
})

describe('MessageList unread line', () => {
  const timeline = (messages: any[]) => ({ messages, streaming: {}, hasMoreOlder: false }) as any
  const list = (props: Record<string, unknown>) => (
    <MessageList state={timeline([
      message({ id: 'a', seq: 1, text: 'read already' }),
      message({ id: 'b', seq: 2, text: 'mine after', authorUserId: 'u-me', author: { id: 'u-me', name: 'Me', image: null } }),
      message({ id: 'c', seq: 3, text: 'first new' }),
      message({ id: 'd', seq: 4, text: 'second new' }),
    ])} loading={false} me="u-me" names={names} canManage={false} {...handlers()} {...props} />
  )

  test('a "New" line sits above the first unread message from someone else', () => {
    const { container, rerender } = render(list({ unreadAfterSeq: 1 }))
    const line = shim('new-messages-line')!
    expect(line.parentElement?.textContent).toContain('first new')
    expect(line.parentElement?.textContent).not.toContain('mine after')
    expect(container.querySelectorAll('[data-rn-shim="new-messages-line"]').length).toBe(1)

    rerender(list({ unreadAfterSeq: null }))
    expect(shim('new-messages-line')).toBeNull()
    rerender(list({ unreadAfterSeq: 1, unreadUpToSeq: 2 }))
    expect(shim('new-messages-line')).toBeNull()
  })

  test('the linked message is highlighted', () => {
    render(list({ highlightId: 'd' }))
    expect(screen.getByTestId('message-highlighted').textContent).toContain('second new')
  })

  test('unread messages older than what is loaded offer a jump', () => {
    const onRevealUnread = mock(() => {})
    render(list({ unreadAfterSeq: 0, unreadNotLoaded: true, onRevealUnread }))
    fireEvent.click(screen.getByLabelText('Jump to first unread message'))
    expect(onRevealUnread).toHaveBeenCalledTimes(1)
  })
})

describe('ConversationHeader channel editing', () => {
  const channel = (overrides: Record<string, unknown> = {}): any => ({
    id: 'c9', workspaceId: 'ws', kind: 'public', name: 'design', slug: 'design', topic: null, lastSeq: 0, lastMessageAt: null,
    archivedAt: null, createdAt: '2026-09-29T10:00:00.000Z', joined: true, starred: false, muted: false, notifyLevel: 'default',
    lastReadSeq: 0, canPost: true, canReply: true, canManage: true, members: [], ...overrides,
  })

  test('owners rename the channel and set its topic', async () => {
    updates.length = 0
    const onChanged = mock(() => {})
    render(<ConversationHeader conversation={channel()} mentionables={null} me="u-me" onChanged={onChanged} onLeft={() => {}} />)
    fireEvent.click(screen.getByLabelText('Edit channel'))
    fireEvent.change(screen.getByLabelText('Channel name'), { target: { value: 'Release Notes' } })
    expect(screen.getByText('Will be saved as #release-notes')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Channel topic'), { target: { value: 'What shipped this week' } })
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save channel'))
    })
    expect(updates).toEqual([{ id: 'c9', patch: { name: 'release-notes', topic: 'What shipped this week' } }])
    expect(onChanged).toHaveBeenCalled()
  })

  test('members who are not owners can only edit the topic', async () => {
    updates.length = 0
    render(<ConversationHeader conversation={channel({ canManage: false, topic: 'Old topic' })} mentionables={null} me="u-me" onChanged={() => {}} onLeft={() => {}} />)
    expect(screen.queryByLabelText('Edit channel')).toBeNull()
    fireEvent.click(screen.getByLabelText('Topic: Old topic. Edit topic'))
    expect(screen.queryByLabelText('Channel name')).toBeNull()
    fireEvent.change(screen.getByLabelText('Channel topic'), { target: { value: '' } })
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save channel'))
    })
    expect(updates).toEqual([{ id: 'c9', patch: { topic: null } }])
  })
})
