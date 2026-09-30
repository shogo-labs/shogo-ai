// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createElement, forwardRef } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const sentTyping: string[] = []

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Pressable: ({ accessibilityLabel, children, onPress, onHoverIn, onHoverOut, disabled }: any) =>
      createElement(
        'div',
        { role: 'button', 'aria-label': accessibilityLabel, onClick: onPress, onMouseEnter: onHoverIn, onMouseLeave: onHoverOut, disabled },
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
  } as any),
)
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }))
mock.module('lucide-react-native', () => {
  const Icon = () => createElement('span')
  const names = ['AlertCircle', 'Bot', 'CornerDownRight', 'FileText', 'Loader2', 'MessageSquare', 'Pencil', 'SmilePlus', 'Square', 'Trash2', 'Paperclip', 'SendHorizontal', 'User', 'Users', 'X']
  return Object.fromEntries(names.map((n) => [n, Icon]))
})
mock.module('../../chat/MarkdownText', () => ({ MarkdownText: ({ children }: any) => createElement('p', null, children) }))
mock.module('../../../lib/team-chat-connection', () => ({
  sendTyping: (_ws: string, conversationId: string) => sentTyping.push(conversationId),
}))
mock.module('../../../lib/team-chat-api', () => ({
  teamChatApi: () => ({ upload: async () => ({ id: 'att-1', name: 'a.txt', mimeType: 'text/plain', size: 1, width: null, height: null, url: '/f' }) }),
}))

const { Composer } = await import('../Composer')
const { MessageRow } = await import('../MessageRow')

const mentionables = {
  people: [
    { id: 'u-me', name: 'Me Myself', email: 'me@x.io', image: null, role: 'owner' },
    { id: 'u-ana', name: 'Ana Lopez', email: 'ana@x.io', image: null, role: 'member' },
  ],
  agents: [{ key: 'p:proj-1', projectId: 'proj-1', name: 'Billing Bot', description: null, image: null }],
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
})
