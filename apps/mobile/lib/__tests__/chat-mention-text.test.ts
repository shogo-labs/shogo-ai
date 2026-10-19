// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  chatIdsIn,
  encodeChatMentionTokens,
  sanitizeChatMentionLabel,
} from '../chat-mention-text'

describe('sanitizeChatMentionLabel', () => {
  test('collapses whitespace so a title stays on one line', () => {
    expect(sanitizeChatMentionLabel('  Deploy\n\nnotes ')).toBe('Deploy notes')
  })

  test('strips token brackets so a title cannot break the wire form', () => {
    expect(sanitizeChatMentionLabel('Fix <@c:abc> bug')).toBe('Fix @c:abc bug')
  })

  test('falls back to "chat" and caps long titles', () => {
    expect(sanitizeChatMentionLabel('   ')).toBe('chat')
    expect(sanitizeChatMentionLabel('x'.repeat(200))).toHaveLength(60)
  })
})

describe('encodeChatMentionTokens', () => {
  const reference = { type: 'chat', id: 'chat-1', label: '@Deploy notes' }

  test('sends the wire token in place of the label', () => {
    expect(
      encodeChatMentionTokens('@Deploy notes can you take this?', [reference]),
    ).toBe('<@c:chat-1> can you take this?')
  })

  test('replaces a label mid-sentence and before punctuation', () => {
    expect(
      encodeChatMentionTokens('ping @Deploy notes. thanks', [reference]),
    ).toBe('ping <@c:chat-1>. thanks')
  })

  test('leaves text alone when the label was edited away', () => {
    expect(encodeChatMentionTokens('@Deploy can you look', [reference])).toBe(
      '@Deploy can you look',
    )
  })

  test('does not touch a label that only appears inside a word', () => {
    expect(encodeChatMentionTokens('x@Deploy notes', [reference])).toBe(
      'x@Deploy notes',
    )
  })

  test('ignores non-chat references and empty input', () => {
    expect(
      encodeChatMentionTokens('@src/app.ts', [
        { type: 'file', id: 'f1', label: '@src/app.ts' },
      ]),
    ).toBe('@src/app.ts')
    expect(encodeChatMentionTokens('', [reference])).toBe('')
    expect(encodeChatMentionTokens('hi', undefined)).toBe('hi')
  })

  test('encodes several chats in one message', () => {
    expect(
      encodeChatMentionTokens('@A and @B', [
        { type: 'chat', id: 'a', label: '@A' },
        { type: 'chat', id: 'b', label: '@B' },
      ]),
    ).toBe('<@c:a> and <@c:b>')
  })
})

describe('chatIdsIn', () => {
  test('reads ids in order, once each', () => {
    expect(chatIdsIn('a <@c:x> b <@c:y> c <@c:x>')).toEqual(['x', 'y'])
    expect(chatIdsIn('no tags here')).toEqual([])
  })
})
