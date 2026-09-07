// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the fork-api helper.
 *
 * Locks the client-side contract used by the turn footer's "Fork
 * conversation from here" button: POSTs to
 * /api/chat-sessions/:id/fork with { messageId } and returns the new
 * session id + cloned message count; throws on non-ok bodies.
 */

import { describe, it, expect, vi } from 'vitest'
import { forkChatSession } from '../fork-api'

function makeFakeCollection(opts: { httpPost?: ReturnType<typeof vi.fn> }) {
  const collection: any = {}
  collection.__env = {
    http: {
      post: opts.httpPost ?? vi.fn(),
    },
  }
  return { collection }
}

vi.mock('mobx-state-tree', () => ({
  getEnv: (node: any) => node.__env,
}))

describe('forkChatSession', () => {
  it('POSTs to /api/chat-sessions/:id/fork with { messageId } and returns the result', async () => {
    const httpPost = vi.fn(async (_url: string, _body: any) => ({
      data: { ok: true, sessionId: 'new-session-1', messageCount: 4 },
    }))
    const { collection } = makeFakeCollection({ httpPost })

    const result = await forkChatSession(collection, 'session-1', 'msg-3')

    expect(httpPost).toHaveBeenCalledTimes(1)
    expect(httpPost).toHaveBeenCalledWith('/api/chat-sessions/session-1/fork', {
      messageId: 'msg-3',
    })
    expect(result).toEqual({ ok: true, sessionId: 'new-session-1', messageCount: 4 })
  })

  it('throws when the server response is non-ok so the footer can surface a real failure', async () => {
    const httpPost = vi.fn(async () => ({ data: { ok: false } }))
    const { collection } = makeFakeCollection({ httpPost })

    await expect(forkChatSession(collection, 'session-1', 'msg-3')).rejects.toThrow(
      'Failed to fork chat session',
    )
  })
})
