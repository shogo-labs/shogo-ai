// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { DefaultChatTransport } from 'ai'
import { getStreamFinishReason } from '../stream-finish'

type ChatTransportParser = {
  processResponseStream: (
    stream: ReadableStream<Uint8Array>,
  ) => ReadableStream<{ type: string; finishReason?: string }>
}

const ChatTransport = DefaultChatTransport as unknown as new () => ChatTransportParser

function finishChunkStream(finishReason: string): ReadableStream<Uint8Array> {
  const body = `data: ${JSON.stringify({ type: 'finish', finishReason })}\n\n`
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
}

describe('runtime stream finish reason', () => {
  test('AI SDK rejects abort as a finish reason', async () => {
    const transport = new ChatTransport()
    const reader = transport.processResponseStream(finishChunkStream('abort')).getReader()

    await expect(reader.read()).rejects.toThrow('Type validation failed')
  })

  test('maps an aborted turn to an AI SDK-compatible finish reason', async () => {
    expect(getStreamFinishReason(true)).toBe('other')

    const transport = new ChatTransport()
    const reader = transport
      .processResponseStream(finishChunkStream(getStreamFinishReason(true)))
      .getReader()

    await expect(reader.read()).resolves.toEqual({
      value: { type: 'finish', finishReason: 'other' },
      done: false,
    })
  })

  test('keeps stop for a normally completed turn', () => {
    expect(getStreamFinishReason(false)).toBe('stop')
  })
})
