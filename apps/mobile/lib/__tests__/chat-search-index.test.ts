// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { ChatSearchIndex, buildChatSearchSnippet, highlightChatSearchText } from '../chat-search-index'

const now = Date.now()

describe('ChatSearchIndex', () => {
  test('ranks exact title matches ahead of message matches', () => {
    const index = ChatSearchIndex.fromSnapshot({
      conversations: [
        { id: 'payments', title: 'Payment API', projectName: 'Checkout', updatedAt: now - 1_000 },
        { id: 'auth', title: 'Authentication', projectName: 'Identity', updatedAt: now - 500 },
      ],
      messages: [
        { id: 'm1', conversationId: 'auth', content: 'payment retry payment timeout payment', createdAt: now - 500 },
      ],
    })

    const result = index.search('Payment')

    expect(result.conversations[0].conversationId).toBe('payments')
    expect(result.conversations[0].hits[0].field).toBe('title')
  })

  test('supports prefix matching without duplicate indexing on update', () => {
    const index = new ChatSearchIndex()
    index.upsertConversation({ id: 'c1', title: 'Backend', updatedAt: now })
    index.upsertMessage({ id: 'm1', conversationId: 'c1', content: 'stripe timeout after retry', createdAt: now })
    index.upsertMessage({ id: 'm1', conversationId: 'c1', content: 'jwt refresh token', createdAt: now })

    expect(index.search('str').conversations).toHaveLength(0)
    expect(index.search('ref').conversations[0].hits[0].messageId).toBe('m1')
    expect(index.documentCount).toBe(2)
  })

  test('groups message and project matches by conversation', () => {
    const index = ChatSearchIndex.fromSnapshot({
      conversations: [
        { id: 'c1', title: 'API work', projectName: 'Payment Gateway', updatedAt: now },
      ],
      messages: [
        { id: 'm1', conversationId: 'c1', content: 'stripe timeout after retry', createdAt: now },
        { id: 'm2', conversationId: 'c1', content: 'stripe webhook signature', createdAt: now - 100 },
      ],
    })

    const result = index.search('stripe pay')

    expect(result.conversations).toHaveLength(1)
    expect(result.conversations[0].hits.map((hit) => hit.messageId).filter(Boolean)).toContain('m1')
    expect(result.conversations[0].hits.some((hit) => hit.field === 'project')).toBe(true)
  })
})

describe('chat search snippets and highlights', () => {
  test('builds highlight ranges for partial tokens', () => {
    expect(highlightChatSearchText('stripe timeout after retry', ['time'])).toEqual([{ start: 7, end: 11 }])
  })

  test('anchors long snippets near the first match', () => {
    const text = `${'x'.repeat(200)} jwt refresh token ${'y'.repeat(200)}`
    const snippet = buildChatSearchSnippet(text, ['jwt'])

    expect(snippet.startsWith('...')).toBe(true)
    expect(snippet).toContain('jwt refresh token')
    expect(snippet.length).toBeLessThanOrEqual(166)
  })
})