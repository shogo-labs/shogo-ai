// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A prompt belongs to the person who typed it (SHO-199).
 *
 * `ChatMessage.authorUserId` is stamped in the create hook, server-side, so a
 * teammate's activity report can credit the sender. Before this, a shared
 * project chat — where the session has no owner — could not say who typed a
 * prompt at all. The value in the request body is ignored: the hook is the one
 * insert point every chat (project, workspace, voice) goes through.
 *
 * Run: bun test apps/api/src/__tests__/chat-message-author-stamp.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { chatMessageHooks } from '../generated/chat-message.hooks'

function ctx(userId: string | null) {
  return {
    body: {},
    params: {},
    query: {},
    userId,
    tunnelAuthenticated: true,
    prisma: {
      chatSession: { findUnique: async () => ({ id: 'sess-1' }) },
    },
  }
}

const userPrompt = { sessionId: 'sess-1', role: 'user' as const, content: 'add the export button' }

describe('chat message author stamp', () => {
  test('a user prompt is attributed to the signed-in sender', async () => {
    const result = await chatMessageHooks.beforeCreate!(userPrompt as any, ctx('alice') as any)
    expect(result?.ok).toBe(true)
    expect(result?.data).toMatchObject({ authorUserId: 'alice' })
  })

  test('a forged authorUserId in the body is replaced, not trusted', async () => {
    const result = await chatMessageHooks.beforeCreate!(
      { ...userPrompt, authorUserId: 'someone-else' } as any,
      ctx('alice') as any,
    )
    expect(result?.data).toMatchObject({ authorUserId: 'alice' })
  })

  test('agent output is attributed to nobody', async () => {
    const result = await chatMessageHooks.beforeCreate!(
      { sessionId: 'sess-1', role: 'assistant', content: 'done' } as any,
      ctx('alice') as any,
    )
    expect(result?.data).toMatchObject({ authorUserId: null })
  })

  test('a write with no signed-in user is still refused, so no author is invented', async () => {
    const result = await chatMessageHooks.beforeCreate!(
      { sessionId: 'sess-1', role: 'assistant', content: 'wake note' } as any,
      ctx(null) as any,
    )
    expect(result?.ok).toBe(false)
    expect(result?.error?.code).toBe('unauthorized')
  })
})
