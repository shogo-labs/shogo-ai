// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it, mock, beforeEach } from 'bun:test'

let closeImpl: (projectId: string, opts: any) => Promise<any> = async () => ({ billedUsd: 0 })
const closeCalls: any[] = []
const setQualityCalls: any[] = []

mock.module('../../lib/proxy-billing-session', () => ({
  closeSession: (projectId: string, opts: any) => {
    closeCalls.push({ projectId, opts })
    return closeImpl(projectId, opts)
  },
  setQualitySignals: (projectId: string, signals: any, chatSessionId?: any) => {
    setQualityCalls.push({ projectId, signals, chatSessionId })
  },
}))

const { trackChatStreamForBilling, teeChatStreamForBilling } = await import('../chat-usage-tracker')

function makeStream(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p))
      controller.close()
    },
  })
}

beforeEach(() => {
  closeCalls.length = 0
  setQualityCalls.length = 0
  closeImpl = async () => ({ billedUsd: 0 })
})

describe('trackChatStreamForBilling', () => {
  it('closes the session with discardPartial=true on EOF without data-turn-complete', async () => {
    const stream = makeStream(['data: {"type":"text-delta","text":"hi"}\n\n'])
    await trackChatStreamForBilling(stream, 'p1')
    expect(closeCalls).toHaveLength(1)
    expect(closeCalls[0].opts.discardPartial).toBe(true)
    expect(closeCalls[0].projectId).toBe('p1')
  })

  it('closes with discardPartial=false when data-turn-complete is observed', async () => {
    const stream = makeStream([
      'data: {"type":"text-delta","text":"hi"}\n',
      '\n',
      'data: {"type":"data-turn-complete"}\n\n',
    ])
    await trackChatStreamForBilling(stream, 'p2')
    expect(closeCalls[0].opts.discardPartial).toBe(false)
  })

  it('passes through chatSessionId to closeSession + setQualitySignals', async () => {
    const stream = makeStream(['data: {"type":"data-turn-complete"}\n\n'])
    await trackChatStreamForBilling(stream, 'p3', 'sess-abc')
    expect(closeCalls[0].opts.chatSessionId).toBe('sess-abc')
    expect(setQualityCalls[0].chatSessionId).toBe('sess-abc')
  })

  it('extracts qualitySignals from a finish event with usage object', async () => {
    const stream = makeStream([
      `data: ${JSON.stringify({ type: 'finish', usage: { success: false, hitMaxTurns: true } })}\n\n`,
      'data: {"type":"data-turn-complete"}\n\n',
    ])
    await trackChatStreamForBilling(stream, 'p4')
    expect(setQualityCalls[0].signals).toMatchObject({ success: false, hitMaxTurns: true })
  })

  it('extracts qualitySignals from top-level fields when usage is absent', async () => {
    const stream = makeStream([
      `data: ${JSON.stringify({ type: 'usage', loopDetected: true })}\n\n`,
      'data: {"type":"data-turn-complete"}\n\n',
    ])
    await trackChatStreamForBilling(stream, 'p5')
    expect(setQualityCalls[0].signals.loopDetected).toBe(true)
  })

  it('ignores [DONE] sentinel and SSE meta lines (event:/id:/retry:)', async () => {
    const stream = makeStream([
      'event: ping\n',
      'id: 1\n',
      'retry: 100\n',
      'data: [DONE]\n',
      '\n',
    ])
    await trackChatStreamForBilling(stream, 'p6')
    expect(closeCalls).toHaveLength(1)
  })

  it('handles compact e:/d: prefixes by defaulting type to "finish"', async () => {
    const stream = makeStream([`d:{"usage":{"success":true}}\n\n`])
    await trackChatStreamForBilling(stream, 'p7')
    expect(setQualityCalls[0].signals.success).toBe(true)
  })

  it('skips unparseable e:/d: lines (continue)', async () => {
    const stream = makeStream([`d:not-json\n\n`, 'data: {"type":"data-turn-complete"}\n\n'])
    await trackChatStreamForBilling(stream, 'p8')
    expect(closeCalls).toHaveLength(1)
  })

  it('ignores plain non-data lines', async () => {
    const stream = makeStream(['just text\n\n', 'data: {"type":"data-turn-complete"}\n\n'])
    await trackChatStreamForBilling(stream, 'p9')
    expect(closeCalls[0].opts.discardPartial).toBe(false)
  })

  it('treats data: payloads that are not objects as no-op', async () => {
    const stream = makeStream(['data: "not-an-object"\n\n'])
    await trackChatStreamForBilling(stream, 'p10')
    expect(closeCalls).toHaveLength(1)
  })

  it('marks streamInterrupted when reader throws (so discardPartial is false)', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: '))
        controller.error(new Error('upstream cut'))
      },
    })
    await trackChatStreamForBilling(stream, 'p11')
    expect(closeCalls).toHaveLength(1)
    expect(closeCalls[0].opts.discardPartial).toBe(false)
  })

  it('logs and continues when closeSession itself throws', async () => {
    closeImpl = async () => {
      throw new Error('boom')
    }
    const stream = makeStream(['data: {"type":"data-turn-complete"}\n\n'])
    await expect(trackChatStreamForBilling(stream, 'p12')).resolves.toBeUndefined()
  })

  it('logs the dollar amount when billedUsd > 0', async () => {
    closeImpl = async () => ({ billedUsd: 1.23 })
    const orig = console.log
    let captured = ''
    console.log = (...a: any[]) => {
      captured += a.join(' ')
    }
    try {
      const stream = makeStream(['data: {"type":"data-turn-complete"}\n\n'])
      await trackChatStreamForBilling(stream, 'p13')
      expect(captured).toContain('1.2300')
    } finally {
      console.log = orig
    }
  })
})

describe('teeChatStreamForBilling', () => {
  it('forwards upstream chunks to client AND triggers a close at EOF', async () => {
    const enc = new TextEncoder()
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {"type":"text-delta","text":"a"}\n\n'))
        controller.enqueue(enc.encode('data: {"type":"data-turn-complete"}\n\n'))
        controller.close()
      },
    })
    const client = teeChatStreamForBilling(upstream, 'pt1', 'sess')
    // Drain the client side.
    const reader = client.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    // Wait a tick so the background trackChatStreamForBilling resolves.
    await new Promise((r) => setTimeout(r, 30))
    expect(chunks.length).toBeGreaterThan(0)
    expect(closeCalls.length).toBeGreaterThanOrEqual(1)
    expect(closeCalls[0].projectId).toBe('pt1')
    expect(closeCalls[0].opts.chatSessionId).toBe('sess')
  })

  it('cancels tracking stream cleanly when client cancels', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"x"}\n\n'))
        await new Promise((r) => setTimeout(r, 5))
        controller.close()
      },
    })
    const client = teeChatStreamForBilling(upstream, 'pt2')
    const reader = client.getReader()
    await reader.cancel()
    await new Promise((r) => setTimeout(r, 40))
    expect(closeCalls.length).toBeGreaterThanOrEqual(1)
  })
})
