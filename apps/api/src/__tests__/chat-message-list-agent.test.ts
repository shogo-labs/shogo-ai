// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The technical thread includes project_call prompts so the called project's
 * transcript still shows them. Analytics counts only agent = 'technical', so
 * those prompts stay out of human-message funnels.
 *
 * Run: bun test apps/api/src/__tests__/chat-message-list-agent.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { chatMessageHooks } from '../generated/chat-message.hooks'

function ctx(agent?: string) {
  return {
    body: {},
    params: {},
    query: agent ? { sessionId: 'sess-1', agent } : { sessionId: 'sess-1' },
    userId: 'user-1',
    tunnelAuthenticated: true,
    prisma: {
      chatSession: { findUnique: async () => ({ id: 'sess-1' }) },
    },
  }
}

describe('chat message list agent filter', () => {
  test('technical includes project_call prompts', async () => {
    const result = await chatMessageHooks.beforeList!(ctx('technical'))
    expect(result?.ok).toBe(true)
    expect(result?.data?.where).toEqual({
      sessionId: 'sess-1',
      agent: { in: ['technical', 'project_call'] },
    })
  })

  test('voice stays voice-only', async () => {
    const result = await chatMessageHooks.beforeList!(ctx('voice'))
    expect(result?.data?.where).toEqual({ sessionId: 'sess-1', agent: 'voice' })
  })

  test('omitting agent does not filter', async () => {
    const result = await chatMessageHooks.beforeList!(ctx())
    expect(result?.data?.where).toEqual({ sessionId: 'sess-1' })
  })

  test('rejects an unknown agent', async () => {
    const result = await chatMessageHooks.beforeList!(ctx('project_call'))
    expect(result?.ok).toBe(false)
    expect(result?.error?.code).toBe('bad_request')
  })
})
