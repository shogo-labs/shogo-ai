// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Extra tests for src/lib/chat-usage-tracker.ts — targets the
 * `teeChatStreamForBilling` plumbing the main suite only smoke-tested:
 *
 *  - Client-side `controller.enqueue` throwing (client disconnected
 *    mid-stream) does NOT stop the background tracking pump.
 *  - Cancelling the tracking ReadableStream early (via .cancel()) is a
 *    clean shutdown — no unhandled rejection.
 *  - Background reader errors are caught + close the client stream.
 *  - The "💰 Billing session closed — charged $..." log line is emitted
 *    when billedUsd > 0 (line 163).
 *  - `trackChatStreamForBilling` releases the reader lock in `finally`
 *    even when the upstream stream pushed no usage frames.
 *
 *   bun test apps/api/src/__tests__/chat-usage-tracker-extra.test.ts
 */

import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

let consumeUsageCalls: any[] = []
mock.module('../services/billing.service', () => ({
  consumeUsage: async (args: any) => {
    consumeUsageCalls.push(args)
    return { success: true, remainingIncludedUsd: 42 }
  },
}))

import {
  openSession,
  hasSession,
  accumulateUsage,
} from '../lib/proxy-billing-session'
import { teeChatStreamForBilling, trackChatStreamForBilling } from '../lib/chat-usage-tracker'

const enc = new TextEncoder()
const dec = new TextDecoder()

function turnCompleteFrames(): string[] {
  return [
    `data: ${JSON.stringify({ type: 'data-turn-complete' })}\n\n`,
    `data: ${JSON.stringify({ type: 'finish', usage: { inputTokens: 100, outputTokens: 50, success: true } })}\n\n`,
  ]
}

function makeStream(frames: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f))
      controller.close()
    },
  })
}

beforeEach(() => {
  consumeUsageCalls = []
})

describe('teeChatStreamForBilling — client disconnect resilience', () => {
  test('client cancelling its reader does not stop billing tracking', async () => {
    const projectId = 'proj-client-cancel'
    openSession(projectId, 'ws-cc', 'user-cc')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 100, 50)

    const upstream = makeStream(turnCompleteFrames())
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})

    const clientStream = teeChatStreamForBilling(upstream, projectId)
    const reader = clientStream.getReader()
    // Read ONE chunk then bail (simulates the user closing the browser tab).
    await reader.read()
    await reader.cancel('user closed tab')

    // Billing tracking continues in the background. Give the pump a tick.
    await new Promise((r) => setTimeout(r, 50))

    expect(hasSession(projectId)).toBe(false)
    expect(consumeUsageCalls).toHaveLength(1)
    logSpy.mockRestore()
  })

  test('background reader.read() throwing closes the client stream cleanly', async () => {
    const projectId = 'proj-bg-error'
    openSession(projectId, 'ws-bg', 'user-bg')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 100, 50)

    let firstRead = true
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (firstRead) {
          firstRead = false
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'data-turn-complete' })}\n\n`))
        } else {
          controller.error(new Error('upstream pod restart'))
        }
      },
    })

    const logSpy = spyOn(console, 'log').mockImplementation(() => {})

    const clientStream = teeChatStreamForBilling(upstream, projectId)
    const reader = clientStream.getReader()

    let received = ''
    let caught: unknown = null
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) received += dec.decode(value)
      }
    } catch (err) {
      caught = err
    }

    await new Promise((r) => setTimeout(r, 30))

    expect(received).toContain('data-turn-complete')
    expect(caught).not.toBeNull()
    expect((caught as Error).message).toBe('upstream pod restart')
    expect(hasSession(projectId)).toBe(false)
    logSpy.mockRestore()
  })
})

describe('trackChatStreamForBilling — billing log + reader-lock release', () => {
  test('emits the "💰 Billing session closed — charged $..." line when billedUsd > 0', async () => {
    const projectId = 'proj-log-charge'
    openSession(projectId, 'ws-l', 'user-l')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 1000, 500)

    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    await trackChatStreamForBilling(makeStream(turnCompleteFrames()), projectId)
    const sawBilledLine = logSpy.mock.calls.some((c) =>
      String(c[0]).includes('Billing session closed — charged $'),
    )
    logSpy.mockRestore()

    expect(consumeUsageCalls).toHaveLength(1)
    expect(sawBilledLine).toBe(true)
  })

  test('empty stream (no frames at all) — no charge, no crash, reader released', async () => {
    const projectId = 'proj-empty'
    openSession(projectId, 'ws-e', 'user-e')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 100, 50)

    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.close() },
    })

    await trackChatStreamForBilling(stream, projectId)

    // EOF without data-turn-complete -> discardPartial, no charge.
    expect(consumeUsageCalls).toHaveLength(0)
    expect(hasSession(projectId)).toBe(false)
  })

  test('unparseable frames are skipped without aborting the loop', async () => {
    const projectId = 'proj-garbage'
    openSession(projectId, 'ws-g', 'user-g')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 50, 25)

    const stream = makeStream([
      'data: this is not json at all\n',
      'random non-data line\n',
      'd: {not-real-json\n',
      `data: ${JSON.stringify({ type: 'data-turn-complete' })}\n\n`,
      `data: ${JSON.stringify({ type: 'finish', success: true })}\n\n`,
    ])

    await trackChatStreamForBilling(stream, projectId)
    expect(consumeUsageCalls).toHaveLength(1)
  })

  test('text payload that is not an object is ignored', async () => {
    const projectId = 'proj-non-object'
    openSession(projectId, 'ws-no', 'user-no')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 50, 25)

    const stream = makeStream([
      'data: 42\n', // valid JSON, not an object
      'data: "just a string"\n',
      'data: null\n',
      `data: ${JSON.stringify({ type: 'data-turn-complete' })}\n\n`,
    ])

    await trackChatStreamForBilling(stream, projectId)
    expect(consumeUsageCalls).toHaveLength(1)
  })

  test('finish without any usage object is fine (quality stays empty)', async () => {
    const projectId = 'proj-finish-noUsage'
    openSession(projectId, 'ws-fn', 'user-fn')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 100, 50)

    const stream = makeStream([
      `data: ${JSON.stringify({ type: 'data-turn-complete' })}\n`,
      `data: ${JSON.stringify({ type: 'finish' })}\n\n`,
    ])

    await trackChatStreamForBilling(stream, projectId)
    expect(consumeUsageCalls).toHaveLength(1)
  })
})

describe('teeChatStreamForBilling — output forwarding', () => {
  test('every chunk pushed by upstream reaches the client reader, in order', async () => {
    const projectId = 'proj-order'
    openSession(projectId, 'ws-ord', 'user-ord')
    accumulateUsage(projectId, 'claude-sonnet-4-5', 100, 50)

    const frames = [
      `data: ${JSON.stringify({ type: 'text-delta', delta: 'A' })}\n`,
      `data: ${JSON.stringify({ type: 'text-delta', delta: 'B' })}\n`,
      `data: ${JSON.stringify({ type: 'text-delta', delta: 'C' })}\n`,
      `data: ${JSON.stringify({ type: 'data-turn-complete' })}\n\n`,
      `data: ${JSON.stringify({ type: 'finish', success: true })}\n\n`,
    ]
    const upstream = makeStream(frames)
    const clientStream = teeChatStreamForBilling(upstream, projectId)
    const reader = clientStream.getReader()
    let body = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      body += dec.decode(value)
    }
    await new Promise((r) => setTimeout(r, 10))

    expect(body.indexOf('"delta":"A"')).toBeLessThan(body.indexOf('"delta":"B"'))
    expect(body.indexOf('"delta":"B"')).toBeLessThan(body.indexOf('"delta":"C"'))
    expect(body).toContain('data-turn-complete')
    expect(consumeUsageCalls).toHaveLength(1)
  })
})
