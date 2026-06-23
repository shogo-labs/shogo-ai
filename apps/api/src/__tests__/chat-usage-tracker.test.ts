// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat Usage Tracker Tests
 *
 * Verifies that the shared SSE billing tracker (used by the agent-proxy
 * and instance-tunnel chat passthroughs) closes the per-project billing
 * session exactly once per turn — emitting one `chat_message` row that
 * aggregates LLM tokens and image-generation USD instead of one row per
 * AI proxy completion.
 *
 * Run: bun test apps/api/src/__tests__/chat-usage-tracker.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

let consumeUsageCalls: any[] = []

mock.module('../services/billing.service', () => ({
  consumeUsage: async (args: any) => {
    consumeUsageCalls.push(args)
    return { success: true, remainingIncludedUsd: 99 }
  },
}))

import {
  openSession,
  hasSession,
  accumulateUsage,
  accumulateImageUsage,
} from '../lib/proxy-billing-session'
import { teeChatStreamForBilling, trackChatStreamForBilling } from '../lib/chat-usage-tracker'

function makeSseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f))
      controller.close()
    },
  })
}

describe('trackChatStreamForBilling', () => {
  beforeEach(() => {
    consumeUsageCalls = []
  })

  test('agentic loop with N AI proxy calls and 1 image emits exactly ONE chat_message row', async () => {
    const projectId = 'proj-agent-loop'
    openSession(projectId, 'ws-loop', 'user-loop')

    // Simulate 3 AI proxy completions and 1 image generation that the
    // runtime would have triggered during the agent loop. These run in
    // the proxy and accumulate against the open session — they should
    // NOT each become their own usage_events row.
    accumulateUsage(projectId, 'claude-sonnet-4-5', 1000, 200)
    accumulateUsage(projectId, 'claude-sonnet-4-5', 500, 100)
    accumulateUsage(projectId, 'claude-sonnet-4-5', 800, 150)
    accumulateImageUsage(projectId, 'gpt-image-1', 0.04, 0.06)

    // The runtime's terminal `data-turn-complete` frame is what tells the
    // tracker the turn finished cleanly (vs an upstream cut).
    const stream = makeSseStream([
      `data: ${JSON.stringify({ type: 'data-turn-complete', data: { status: 'completed' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'finish', usage: { inputTokens: 2300, outputTokens: 450, totalTokens: 2750, success: true } })}\n\n`,
    ])

    await trackChatStreamForBilling(stream, projectId)

    expect(hasSession(projectId)).toBe(false)
    expect(consumeUsageCalls.length).toBe(1)
    const args = consumeUsageCalls[0]
    expect(args.actionType).toBe('chat_message')
    expect(args.actionMetadata.requestCount).toBe(3)
    expect(args.actionMetadata.imageGenerationCount).toBe(1)
    expect(args.actionMetadata.totalTokens).toBe(2750)
  })

  test('stream EOF without data-turn-complete discards the session (no charge)', async () => {
    const projectId = 'proj-eof'
    openSession(projectId, 'ws-eof', 'user-eof')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 1000, 500)

    // No data-turn-complete frame — simulates upstream activator timeout.
    const stream = makeSseStream([
      `data: ${JSON.stringify({ type: 'text-delta', delta: 'partial...' })}\n\n`,
    ])

    await trackChatStreamForBilling(stream, projectId)

    // Session is dropped without charging (auto-resuming-fetch will
    // reconnect; we don't bill twice for the same turn).
    expect(hasSession(projectId)).toBe(false)
    expect(consumeUsageCalls.length).toBe(0)
  })

  test('quality signals are forwarded to the closeSession-emitted analytics', async () => {
    const projectId = 'proj-quality'
    openSession(projectId, 'ws-q', 'user-q')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 100, 50)

    const stream = makeSseStream([
      `data: ${JSON.stringify({ type: 'data-turn-complete', data: { status: 'completed' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'data-usage', data: { inputTokens: 100, outputTokens: 50, success: true, hitMaxTurns: false } })}\n\n`,
    ])

    await trackChatStreamForBilling(stream, projectId)

    expect(consumeUsageCalls.length).toBe(1)
    expect(consumeUsageCalls[0].actionType).toBe('chat_message')
  })

  test('with no session open the tracker is a no-op', async () => {
    const stream = makeSseStream([
      `data: ${JSON.stringify({ type: 'data-turn-complete', data: { status: 'completed' } })}\n\n`,
    ])
    await trackChatStreamForBilling(stream, 'proj-no-session')
    expect(consumeUsageCalls.length).toBe(0)
  })

  test('parses event/id/retry metadata and AI SDK e:/d: compact frames', async () => {
    const projectId = 'proj-compact-frames'
    openSession(projectId, 'ws-compact', 'user-compact')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 100, 25)

    const stream = makeSseStream([
      'event: message\n',
      'id: 123\n',
      'retry: 1000\n',
      'data: [DONE]\n',
      `data:${JSON.stringify({ type: 'data-turn-complete' })}\n`,
      `e:${JSON.stringify({ usage: { success: false, loopDetected: true, responseEmpty: true } })}\n\n`,
    ])

    await trackChatStreamForBilling(stream, projectId)

    expect(consumeUsageCalls).toHaveLength(1)
    expect(consumeUsageCalls[0].actionType).toBe('chat_message')
  })

  test('direct finish fields override usage object quality signals', async () => {
    const projectId = 'proj-direct-finish'
    openSession(projectId, 'ws-direct', 'user-direct')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 80, 20)

    const stream = makeSseStream([
      `data: ${JSON.stringify({ type: 'data-turn-complete' })}\n`,
      `data: ${JSON.stringify({
        type: 'finish-step',
        usage: { success: true },
        success: false,
        hitMaxTurns: true,
        escalated: true,
      })}\n\n`,
    ])

    await trackChatStreamForBilling(stream, projectId)

    expect(consumeUsageCalls).toHaveLength(1)
    expect(consumeUsageCalls[0].actionType).toBe('chat_message')
  })

  test('stream read interruption closes session without discardPartial', async () => {
    const projectId = 'proj-interrupt'
    openSession(projectId, 'ws-interrupt', 'user-interrupt')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 60, 20)

    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('reader exploded')
      },
    })

    await trackChatStreamForBilling(stream, projectId)

    expect(hasSession(projectId)).toBe(false)
    expect(consumeUsageCalls).toHaveLength(1)
  })

  test('chatSessionId is threaded through tee → tracker → closeSession', async () => {
    const projectId = 'proj-thread-chat'
    openSession(projectId, 'ws-thread', 'user-thread', 'chat-thread-1')
    openSession(projectId, 'ws-thread', 'user-thread-other', 'chat-thread-2')

    accumulateUsage(projectId, 'claude-sonnet-4-5', 200, 100, 0, 0, 'chat-thread-1')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 9999, 9999, 0, 0, 'chat-thread-2')

    const upstream = makeSseStream([
      `data: ${JSON.stringify({ type: 'data-turn-complete' })}\n\n`,
      `data: ${JSON.stringify({ type: 'finish', success: true })}\n\n`,
    ])

    const clientStream = teeChatStreamForBilling(upstream, projectId, 'chat-thread-1')
    const reader = clientStream.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(consumeUsageCalls).toHaveLength(1)
    expect(consumeUsageCalls[0].actionMetadata.inputTokens).toBe(200)
    expect(consumeUsageCalls[0].actionMetadata.outputTokens).toBe(100)
    expect(consumeUsageCalls[0].actionMetadata.chatSessionId).toBe('chat-thread-1')

    expect(hasSession(projectId, 'chat-thread-1')).toBe(false)
    expect(hasSession(projectId, 'chat-thread-2')).toBe(true)

    // Clean up sibling session so it doesn't leak into other tests.
    const { closeSession } = await import('../lib/proxy-billing-session')
    await closeSession(projectId, { chatSessionId: 'chat-thread-2' })
  })

  test('teeChatStreamForBilling forwards client chunks while tracking billing in the background', async () => {
    const projectId = 'proj-tee'
    openSession(projectId, 'ws-tee', 'user-tee')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 100, 40)

    const upstream = makeSseStream([
      `data: ${JSON.stringify({ type: 'data-turn-complete' })}\n\n`,
      `data: ${JSON.stringify({ type: 'finish', success: true })}\n\n`,
    ])

    const clientStream = teeChatStreamForBilling(upstream, projectId)
    const reader = clientStream.getReader()
    const decoder = new TextDecoder()
    let body = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      body += decoder.decode(value)
    }

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(body).toContain('data-turn-complete')
    expect(body).toContain('finish')
    expect(consumeUsageCalls).toHaveLength(1)
    expect(hasSession(projectId)).toBe(false)
  })

  test('teeChatStreamForBilling can hand the mirrored stream to a persistence tracker', async () => {
    const projectId = 'proj-persist-tee'
    const seen: string[] = []
    const upstream = makeSseStream([
      `data: ${JSON.stringify({ type: 'text-delta', delta: 'persisted ' })}\n\n`,
      `data: ${JSON.stringify({ type: 'text-delta', delta: 'reply' })}\n\n`,
      `data: ${JSON.stringify({ type: 'data-turn-complete' })}\n\n`,
    ])

    const clientStream = teeChatStreamForBilling(
      upstream,
      projectId,
      'chat-persist-1',
      async (stream, trackerProjectId, chatSessionId) => {
        expect(trackerProjectId).toBe(projectId)
        expect(chatSessionId).toBe('chat-persist-1')
        const reader = stream.getReader()
        const decoder = new TextDecoder()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          seen.push(decoder.decode(value))
        }
      },
    )

    const reader = clientStream.getReader()
    const decoder = new TextDecoder()
    let body = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      body += decoder.decode(value)
    }

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(body).toContain('persisted ')
    expect(body).toContain('reply')
    expect(seen.join('')).toContain('persisted ')
    expect(seen.join('')).toContain('reply')
  })

})
