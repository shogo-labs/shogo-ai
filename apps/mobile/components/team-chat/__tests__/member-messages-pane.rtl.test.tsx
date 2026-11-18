// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Messages from <member>" (SHO-419): the pane lists one member's messages
 * newest first, the switcher changes who you are looking at without closing it,
 * and tapping a row hands the message back so the channel can jump to it.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import type { ChatMessage, ConversationDetail } from '../../../lib/team-chat-api'

const FlatList = ({ data, renderItem, keyExtractor, ListEmptyComponent }: Record<string, any>) =>
  createElement(
    'div',
    null,
    (data ?? []).length
      ? (data ?? []).map((item: unknown, index: number) =>
          createElement('div', { key: keyExtractor ? keyExtractor(item) : index }, renderItem({ item, index })),
        )
      : typeof ListEmptyComponent === 'function'
        ? createElement(ListEmptyComponent)
        : ListEmptyComponent ?? null,
  )

const Pressable = ({ onPress, accessibilityLabel, disabled, children }: Record<string, any>) =>
  createElement('button', { 'aria-label': accessibilityLabel, onClick: disabled ? undefined : onPress }, children as ReactNode)

mock.module('react-native', () => createReactNativeMock({ FlatList, Pressable }))
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }))
mock.module(resolve(import.meta.dir, '../AgentAvatar'), () => ({
  AgentAvatar: ({ name }: { name: string }) => createElement('span', null, `agent:${name}`),
}))
mock.module(resolve(import.meta.dir, '../UserAvatar'), () => ({
  UserAvatar: ({ name }: { name: string }) => createElement('span', null, `user:${name}`),
}))
mock.module(resolve(import.meta.dir, '../InlineMarkdown'), () => ({
  InlineMarkdown: ({ text }: { text?: string }) => createElement('span', null, text ?? ''),
}))

let messages: ChatMessage[] = []
let loading = false
let error: string | null = null

mock.module(resolve(import.meta.dir, '../../../hooks/useMemberMessages'), () => ({
  useMemberMessages: () => ({
    messages,
    loading,
    loadingMore: false,
    error,
    hasMore: false,
    loadMore: async () => {},
    reload: async () => {},
  }),
}))

const { MemberMessagesPane } = await import('../MemberMessagesPane')

const conversation = {
  id: 'c-1',
  kind: 'public',
  name: 'launch',
  members: [
    { id: 'm-1', type: 'user', userId: 'u-ada', role: 'member', name: 'Ada', image: null },
    { id: 'm-2', type: 'user', userId: 'u-grace', role: 'member', name: 'Grace', image: null },
    { id: 'm-3', type: 'agent', projectId: 'p-alpha', name: 'Alpha', agentTrigger: 'all', agentKeywords: null },
    { id: 'm-4', type: 'agent', projectId: null, name: 'Shogo', agentTrigger: 'all', agentKeywords: null },
  ],
} as unknown as ConversationDetail

function message(over: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    conversationId: 'c-1',
    workspaceId: 'w-1',
    seq: 1,
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    alsoSentToChannel: false,
    authorType: 'user',
    author: { id: 'u-ada', name: 'Ada', image: null },
    authorUserId: 'u-ada',
    authorAgent: null,
    text: 'hello',
    blocks: null,
    clientMsgId: null,
    agentSessionId: null,
    agentStatus: null,
    reactions: [],
    attachments: [],
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-11-18T09:00:00.000Z',
    ...over,
  } as ChatMessage
}

const onClose = mock(() => {})
const onChangeMember = mock((_from: string) => {})
const onShowInChat = mock((_message: ChatMessage) => {})

const renderPane = (from = 'user:u-ada') =>
  render(
    <MemberMessagesPane
      workspaceId="w-1"
      conversation={conversation}
      from={from}
      onClose={onClose}
      onChangeMember={onChangeMember}
      onShowInChat={onShowInChat}
    />,
  )

afterEach(cleanup)
beforeEach(() => {
  messages = []
  loading = false
  error = null
  onClose.mockClear()
  onChangeMember.mockClear()
  onShowInChat.mockClear()
})

describe('MemberMessagesPane', () => {
  test('names the member it is showing', () => {
    renderPane()
    expect(screen.getByText('Messages from Ada')).toBeTruthy()
  })

  test('lists their messages and labels the ones in a thread', () => {
    messages = [
      message({ id: 'm-2', text: 'second', createdAt: '2026-11-18T10:00:00.000Z' }),
      message({ id: 'm-1', text: 'first', threadRootId: 'root-1', createdAt: '2026-11-18T09:00:00.000Z' }),
    ]
    renderPane()
    expect(screen.getByText('second')).toBeTruthy()
    expect(screen.getByText('first')).toBeTruthy()
    expect(screen.getByText('in thread')).toBeTruthy()
  })

  test('the switcher changes member without closing the pane', () => {
    renderPane()
    fireEvent.click(screen.getByLabelText('Messages from Grace'))
    expect(onChangeMember).toHaveBeenCalledWith('user:u-grace')
    expect(onClose).not.toHaveBeenCalled()
  })

  test('the workspace agent is switched to as agent:ws', () => {
    renderPane()
    fireEvent.click(screen.getByLabelText('Messages from Shogo'))
    expect(onChangeMember).toHaveBeenCalledWith('agent:ws')
  })

  test('a project agent is switched to by its project id', () => {
    renderPane()
    fireEvent.click(screen.getByLabelText('Messages from Alpha'))
    expect(onChangeMember).toHaveBeenCalledWith('agent:p-alpha')
  })

  test('tapping a row hands the message back to jump to', () => {
    messages = [message({ id: 'm-1', text: 'first', threadRootId: 'root-1' })]
    renderPane()
    fireEvent.click(screen.getByLabelText(/Show message from/))
    expect(onShowInChat).toHaveBeenCalledTimes(1)
    expect((onShowInChat.mock.calls[0][0] as ChatMessage).id).toBe('m-1')
  })

  test('an empty list says so, naming the channel', () => {
    renderPane()
    expect(screen.getByText(/Ada hasn’t posted in #launch yet\./)).toBeTruthy()
  })

  test('an API error is shown as the API worded it', () => {
    error = 'from must be user:<userId>, agent:<projectId> or agent:ws'
    renderPane()
    expect(screen.getByText('from must be user:<userId>, agent:<projectId> or agent:ws')).toBeTruthy()
  })

  test('closing the pane is its own control', () => {
    renderPane()
    fireEvent.click(screen.getByLabelText('Close member messages'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
