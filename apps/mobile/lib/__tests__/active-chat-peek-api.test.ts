// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-501: the peek client read `res.ok` off the SDK's `HttpClient` response,
 * which is `{ data, status, headers }` — no `ok` flag. Every peek therefore
 * resolved to `null`, `useRunPeek` reported `done`, and the hover card closed in
 * the same tick it opened, so the two SHO-466 e2e tests could never see it.
 */
import { describe, expect, test } from 'bun:test'
import { api } from '../api'

const PEEK = {
  chatSessionId: 'chat-card',
  turnId: 'turn-card',
  title: 'SHO-466 hover test run',
  agentName: 'Shogo Dev 3',
  startedAt: '2026-11-22T00:00:00.000Z',
  where: { kind: 'public', conversationId: 'conv-1', conversationName: 'shogo-dev', threadRootId: null },
  card: { key: 'SHO-466', title: 'Hover peek', column: 'In Development' },
  trigger: null,
  reply: null,
  hidden: false,
}

/** A real `HttpClient` answer: data, status and headers — and no `ok`. */
function httpReturning(data: unknown, status = 200) {
  return {
    get: async (url: string) => {
      calls.push(url)
      return { data, status, headers: new Headers() }
    },
  } as any
}
const calls: string[] = []

describe('api.getActiveChatPeek', () => {
  test('a 200 answer is the peek, not "nothing running"', async () => {
    calls.length = 0
    const peek = await api.getActiveChatPeek(httpReturning(PEEK), 'ws-1', 'chat-card')

    expect(peek).not.toBeNull()
    expect(peek?.title).toBe('SHO-466 hover test run')
    expect(calls[0]).toBe('/api/workspaces/ws-1/active-chats/chat-card/peek')
  })

  test('a 404 from the route means the turn ended, which is null rather than an error', async () => {
    const http = {
      get: async () => {
        throw Object.assign(new Error('not_running'), { status: 404 })
      },
    } as any

    expect(await api.getActiveChatPeek(http, 'ws-1', 'chat-card')).toBeNull()
  })

  test('any other failure still throws, so the card can say what went wrong', async () => {
    const http = {
      get: async () => {
        throw Object.assign(new Error('boom'), { status: 500 })
      },
    } as any

    await expect(api.getActiveChatPeek(http, 'ws-1', 'chat-card')).rejects.toThrow('boom')
  })
})
