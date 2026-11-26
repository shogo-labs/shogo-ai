// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A cancelled stream inside an open billing session accumulates exactly once
 * (SHO-599).
 *
 * `recordUsage` accumulates into the session instead of debiting per call, and
 * the session closer charges the turn. A cancel used to skip `flush()`, so the
 * turn's input + cache tokens never reached the accumulator and the close
 * recorded a turn that was cheaper than what the provider had already billed.
 *
 * Run: bun test apps/api/src/routes/__tests__/ai-proxy-cancelled-session.test.ts
 */

import { describe, test, expect, afterEach, mock } from 'bun:test'

process.env.SHOGO_LOCAL_MODE = 'false'

type Accumulated = {
  projectId: string
  model: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  chatSessionId?: string | null
}

const accumulated: Accumulated[] = []

mock.module('../../lib/proxy-billing-session', () => ({
  hasActiveSession: async () => true,
  hasSession: async () => true,
  accumulateUsage: async (
    projectId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens = 0,
    cacheWriteTokens = 0,
    chatSessionId?: string | null,
  ) => {
    accumulated.push({
      projectId, model, inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, chatSessionId,
    })
    return true
  },
  openSession: async () => {},
  closeSession: async () => ({ billedUsd: 0, rawUsd: 0, totalTokens: 0 }),
  accumulateImageUsage: async () => false,
  accumulateVideoUsage: async () => false,
  accumulate3dUsage: async () => false,
  accumulateMusicUsage: async () => false,
  setQualitySignals: async () => true,
}))

const { proxyAnthropicStream, recordUsage } = await import('../ai-proxy')

const TE = new TextEncoder()

/** `message_start` (real input + cache tokens) then a slow second frame, so a cancel lands between them. */
function slowAnthropicStream() {
  const first =
    'event: message_start\n' +
    'data: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":30,"cache_creation_input_tokens":20}}}\n\n'
  const rest =
    'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello world"}}\n\n' +
    'event: message_delta\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n'
  let sent = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent === 0) {
        sent = 1
        controller.enqueue(TE.encode(first))
        return
      }
      await new Promise((r) => setTimeout(r, 60))
      sent = 2
      controller.enqueue(TE.encode(rest))
      controller.close()
    },
  })
}

const origFetch = globalThis.fetch
afterEach(() => {
  accumulated.length = 0
  globalThis.fetch = origFetch
})

describe('a cancelled stream inside an open billing session', () => {
  test('accumulates the input and cache tokens it already saw, exactly once', async () => {
    ;(globalThis as any).fetch = mock(async () =>
      new Response(slowAnthropicStream(), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    )

    const tokenPayload: any = {
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      authKind: 'proxy-jwt',
    }

    const res = await proxyAnthropicStream(
      { model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }], stream: true } as any,
      'k',
      { provider: 'anthropic', apiModel: 'claude-opus-4-8', displayName: 'Claude Opus 4.8' } as any,
      (inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, options) =>
        recordUsage(
          tokenPayload, 'claude-opus-4-8', inputTokens, outputTokens,
          cachedInputTokens, cacheWriteTokens, 'chat-1', null, 0, options,
        ),
    )

    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()
    await new Promise((r) => setTimeout(r, 20))

    expect(accumulated).toHaveLength(1)
    expect(accumulated[0]!.projectId).toBe('proj-1')
    expect(accumulated[0]!.inputTokens).toBe(120)
    expect(accumulated[0]!.cachedInputTokens).toBe(30)
    expect(accumulated[0]!.cacheWriteTokens).toBe(20)
    expect(accumulated[0]!.chatSessionId).toBe('chat-1')
  })
})
