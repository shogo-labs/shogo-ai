// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `appendChatQuery` — the URL composer used by both
 * `useChatConversation` (web) and (native) to thread `projectId` /
 * `conversationId` onto the consumer-supplied chat endpoint.
 *
 * The hook itself is exercised indirectly via the apps/api route
 * test (`apps/api/src/__tests__/chat-turn-route.test.ts`); this
 * file pins down the bits of behaviour that are easy to get wrong
 * and don't need a React renderer.
 */

import { describe, expect, test } from 'bun:test'
import { appendChatQuery } from '../shared/chatUrl'

describe('appendChatQuery', () => {
  test('returns the base path unchanged when no params are set', () => {
    expect(appendChatQuery('/api/chat/turn', {})).toBe('/api/chat/turn')
    expect(
      appendChatQuery('/api/chat/turn', {
        projectId: undefined,
        conversationId: undefined,
      }),
    ).toBe('/api/chat/turn')
  })

  test('drops empty-string params', () => {
    expect(
      appendChatQuery('/api/chat/turn', { projectId: '', conversationId: '' }),
    ).toBe('/api/chat/turn')
  })

  test('appends a single param with `?` when no query exists yet', () => {
    expect(
      appendChatQuery('/api/chat/turn', { projectId: 'p-1' }),
    ).toBe('/api/chat/turn?projectId=p-1')
  })

  test('appends multiple params separated by `&`', () => {
    expect(
      appendChatQuery('/api/chat/turn', {
        projectId: 'p-1',
        conversationId: 'c-7',
      }),
    ).toBe('/api/chat/turn?projectId=p-1&conversationId=c-7')
  })

  test('preserves an existing query string with `&`', () => {
    expect(
      appendChatQuery('https://api.example.com/chat?foo=bar', {
        projectId: 'p-1',
      }),
    ).toBe('https://api.example.com/chat?foo=bar&projectId=p-1')
  })

  test('encodes special characters in param values', () => {
    expect(
      appendChatQuery('/api/chat/turn', {
        projectId: 'a b',
        conversationId: 'a/b?c',
      }),
    ).toBe('/api/chat/turn?projectId=a%20b&conversationId=a%2Fb%3Fc')
  })

  test('does NOT encode the base path (the consumer owns it)', () => {
    // If the consumer hands us a raw path with a space, that is their
    // problem; we don't mangle it. This guards against double-encoding
    // when the consumer has already encoded the base.
    expect(
      appendChatQuery('https://api.example.com/v1/chat%20turn', {
        projectId: 'p-1',
      }),
    ).toBe('https://api.example.com/v1/chat%20turn?projectId=p-1')
  })
})
