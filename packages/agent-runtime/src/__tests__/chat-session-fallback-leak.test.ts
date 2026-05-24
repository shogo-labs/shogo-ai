// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression: cross-chat history leak via a literal `'chat'` fallback.
 *
 * Background — the runtime USED to do this in two places:
 *
 *   // server.ts ( /agent/chat )
 *   const chatSessionKey = body.chatSessionId || 'chat'
 *   // gateway.ts ( processChatMessageStream )
 *   const sessionId      = options?.chatSessionId || 'chat'
 *
 * Both fell back to the literal string `'chat'` when the caller did not
 * include a `chatSessionId`. Because `SessionManager.sessions` is keyed
 * by that string, every fallback-keyed turn wrote into — AND read from —
 * a single shared `'chat'` bucket per runtime pod (one pod = one
 * project). Two unrelated chats that happened to send a turn without a
 * `chatSessionId` shared a conversation history; the second chat's first
 * message would arrive at the LLM with the first chat's full context.
 *
 * Reported in production as: "I swapped to a new chat and sent a message
 * but it seems the message was sent with context from the older chat."
 *
 * Fix landed in 3 layers:
 *   1. `apps/api/src/routes/project-chat.ts` — 400 at the edge when the
 *      `X-Chat-Session-Id` header / body `chatSessionId` is missing,
 *      mirroring the existing guard on `apps/api/src/routes/voice.ts`.
 *   2. `packages/agent-runtime/src/server.ts` — 400 inside the runtime
 *      for both `/agent/chat` and `/agent/stop`. The literal `'chat'`
 *      fallback is removed.
 *   3. `packages/agent-runtime/src/gateway.ts` — throw inside
 *      `processChatMessageStream` if `options.chatSessionId` is
 *      missing/empty. Guards in-process callers (tests, evals, future
 *      internal channels) that bypass the HTTP edge.
 *
 * This test asserts (a) that proper unique ids remain isolated (the
 * baseline invariant), and (b) that the resolution rule which used to
 * leak no longer produces a sharable key — i.e. an empty / missing
 * chatSessionId is rejected rather than collapsed to a shared literal.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { SessionManager } from '../session-manager'
import type { UserMessage, AssistantMessage } from '@mariozechner/pi-ai'

function user(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: Date.now() }
}

function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'mock',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

/**
 * Mirror of the runtime's chat-session resolution rule from
 * `packages/agent-runtime/src/server.ts` (the `/agent/chat` handler).
 *
 * Returns the validated key for a present-and-non-empty id, or throws
 * with the exact error the runtime emits to the client (as a 400) when
 * the id is missing. Update this helper in lockstep with the runtime so
 * the test continues to mirror real behavior.
 */
function resolveChatSessionKey(body: { chatSessionId?: string | null }): string {
  const raw = body.chatSessionId
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(
      'chatSessionId is required — send the X-Chat-Session-Id header or `chatSessionId` in the JSON body',
    )
  }
  return raw
}

describe('chat session id fallback — cross-chat leak regression', () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager({
      sessionTtlSeconds: 3600,
      maxMessages: 100,
      maxEstimatedTokens: 200_000,
      keepRecentMessages: 10,
      pruneIntervalSeconds: 999,
      contextWindowTokens: 200_000,
      maxOutputTokens: 4_000,
      bufferTokens: 1_000,
    })
  })

  test('rejects a null chatSessionId instead of collapsing to a shared bucket', () => {
    expect(() => resolveChatSessionKey({ chatSessionId: null })).toThrow(
      /chatSessionId is required/,
    )
  })

  test('rejects undefined chatSessionId', () => {
    expect(() => resolveChatSessionKey({})).toThrow(/chatSessionId is required/)
  })

  test('rejects an empty-string chatSessionId', () => {
    expect(() => resolveChatSessionKey({ chatSessionId: '' })).toThrow(
      /chatSessionId is required/,
    )
  })

  test('rejects a whitespace-only chatSessionId', () => {
    expect(() => resolveChatSessionKey({ chatSessionId: '   ' })).toThrow(
      /chatSessionId is required/,
    )
  })

  test('unique chatSessionId values are isolated (baseline invariant)', () => {
    const keyA = resolveChatSessionKey({ chatSessionId: 'session-a' })
    sm.addMessages(
      keyA,
      user('secret from chat A'),
      assistant('only A should see this'),
    )

    const keyB = resolveChatSessionKey({ chatSessionId: 'session-b' })
    const historyB = sm.buildHistory(keyB)
    expect(historyB).toHaveLength(0)

    const historyA = sm.buildHistory(keyA)
    expect(historyA).toHaveLength(2)
    expect((historyA[0] as UserMessage).content).toBe('secret from chat A')
  })

  test('the literal "chat" bucket is not implicitly reachable', () => {
    expect(() => resolveChatSessionKey({ chatSessionId: undefined })).toThrow()

    sm.getOrCreate('chat').messages.push(user('leftover'))
    const accidentalLeakAttempt = sm.buildHistory(
      resolveChatSessionKey({ chatSessionId: 'session-c' }),
    )
    expect(accidentalLeakAttempt).toHaveLength(0)
  })
})
