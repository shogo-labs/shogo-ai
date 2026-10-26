// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for SHO-201, driven end-to-end through `AgentGateway` rather
 * than the loop's internals: a real session, a real persisted transcript, the
 * same `scrubInvalidImages` wiring production uses.
 *
 * The dev's `image-dimension-recovery.test.ts` covers the ladder and the wire
 * scrub with PNG fixtures. Two things are only provable here:
 *
 *   - a **JPEG** over the cap is caught (acceptance criterion 2 says
 *     "PNG/JPEG", and JPEG dimensions come from a completely different decoder
 *     path in `image-size-guard`), and
 *   - the session's *next* turn pays no failed request once the cap is known,
 *     which is the whole point of remembering it (criterion 3).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import type { AssistantMessage, ImageContent, Message, ToolResultMessage } from '@mariozechner/pi-ai'
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai'
import { AgentGateway } from '../gateway'
import { pngBase64 } from './helpers/synthetic-png'

const TEST_DIR = '/tmp/qa-sho201-acceptance'

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** Verbatim production text from Russell's report (thread 93d2ff50). */
const ANTHROPIC_DIMENSION_400 =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":' +
  '"messages.1.content.22.image.source.base64.data: At least one of the image dimensions exceed ' +
  'max allowed size for many-image requests: 3000 pixels. Each image must be less than 3000 pixels ' +
  'on its longest side."}}'

/**
 * A decode-valid baseline JPEG at an exact pixel size, without an image codec.
 * `decodeJpeg` walks the marker chain, reads the SOF frame size and requires an
 * EOI after the scan header, so SOI + SOF0 + SOS + EOI is the whole image it
 * needs to see — and it stays tiny, which is the point: over the *pixel* cap
 * while far under the byte cap.
 */
function jpegBase64(width: number, height: number): string {
  const frame = Buffer.from([
    0xff, 0xc0, // SOF0
    0x00, 0x0b, // segment length 11 = 8 + 3 components
    0x08, // 8-bit precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, // one component
    0x01, 0x11, 0x00, // id 1, no subsampling, quant table 0
  ])
  const sos = Buffer.from([
    0xff, 0xda, // SOS
    0x00, 0x08, // length 8 = 6 + 2 components
    0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x00, 0x00, // (dummy entropy bytes)
  ])
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    frame,
    sos,
    Buffer.from([0xff, 0xd9]), // EOI
  ]).toString('base64')
}

const BIG_JPEG = jpegBase64(3200, 1800)
const SMALL_PNG = pngBase64(1280, 720)

function answer(text: string) {
  const msg = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    usage: { ...ZERO_USAGE, output: 5, totalTokens: 5 },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as AssistantMessage
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: msg } as any)
    stream.push({ type: 'done', reason: 'stop', message: msg } as any)
    stream.end(msg)
  })
  return stream as any
}

function providerError(errorMessage: string) {
  const msg = {
    role: 'assistant',
    content: [],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    usage: ZERO_USAGE,
    stopReason: 'error',
    errorMessage,
    timestamp: Date.now(),
  } as AssistantMessage
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: msg } as any)
    stream.push({ type: 'error', reason: 'error', error: msg } as any)
    stream.end()
  })
  return stream as any
}

/** One screenshot round: user ask, tool call, image result. */
function screenshotRound(imageBase64: string, mimeType: string, run: string): Message[] {
  return [
    { role: 'user', content: `Screenshot step ${run}.`, timestamp: 0 } as Message,
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: `call_${run}`, name: 'browser', arguments: { action: 'screenshot' } }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      usage: ZERO_USAGE,
      stopReason: 'toolUse',
      timestamp: 0,
    } as AssistantMessage,
    {
      role: 'toolResult',
      toolCallId: `call_${run}`,
      toolName: 'browser',
      content: [
        { type: 'image', data: imageBase64, mimeType },
        { type: 'text', text: JSON.stringify({ ok: true, path: `.shogo/screenshots/${run}/step-01.png` }) },
      ],
      isError: false,
      timestamp: 0,
    } as ToolResultMessage,
  ]
}

function imagesIn(messages: Message[]): ImageContent[] {
  const out: ImageContent[] = []
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'toolResult') continue
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content) if (block.type === 'image') out.push(block)
  }
  return out
}

function textIn(messages: Message[]): string {
  const out: string[] = []
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content as Array<{ type: string; text?: string }>) {
      if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    }
  }
  return out.join('\n')
}

describe('SHO-201 acceptance: a dimension 400 no longer ends the turn', () => {
  let gateway: AgentGateway | undefined
  const prevRetryBase = process.env.SHOGO_INFERENCE_RETRY_BASE_MS
  const prevProviderRetry = process.env.SHOGO_PROVIDER_RETRY
  const requests: Message[][] = []

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(join(TEST_DIR, 'memory'), { recursive: true })
    mkdirSync(join(TEST_DIR, 'skills'), { recursive: true })
    writeFileSync(
      join(TEST_DIR, 'config.json'),
      JSON.stringify({
        heartbeatInterval: 1800,
        heartbeatEnabled: false,
        quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
        channels: [],
        model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      }),
    )
    writeFileSync(join(TEST_DIR, 'AGENTS.md'), '# Agent\nYou are a test agent.')
    process.env.SHOGO_INFERENCE_RETRY_BASE_MS = '1'
    process.env.SHOGO_PROVIDER_RETRY = 'off'
    requests.length = 0
  })

  afterEach(async () => {
    if (prevRetryBase === undefined) delete process.env.SHOGO_INFERENCE_RETRY_BASE_MS
    else process.env.SHOGO_INFERENCE_RETRY_BASE_MS = prevRetryBase
    if (prevProviderRetry === undefined) delete process.env.SHOGO_PROVIDER_RETRY
    else process.env.SHOGO_PROVIDER_RETRY = prevProviderRetry
    if (gateway) await gateway.stop()
    gateway = undefined
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  /** Production-shaped provider: any request still carrying the 3200×1800 JPEG is rejected. */
  function startGateway() {
    gateway = new AgentGateway(TEST_DIR, 'qa-acceptance')
    gateway.setStreamFn(((_model: any, context: any) => {
      requests.push(context.messages)
      const overCap = imagesIn(context.messages).some((block) => block.data === BIG_JPEG)
      return overCap ? providerError(ANTHROPIC_DIMENSION_400) : answer('Recovered: the page is a two-column grid.')
    }) as any)
    return gateway
  }

  test('a JPEG over the pixel cap is replaced, the accepted PNG is not, and the answer is real', async () => {
    const sessionId = 'mixed-formats'
    const g = startGateway()
    await g.start()
    g.getSessionManager().addMessages(
      sessionId,
      ...screenshotRound(BIG_JPEG, 'image/jpeg', 'big'),
      ...screenshotRound(SMALL_PNG, 'image/png', 'fine'),
    )

    await g.processChatMessageStream('What changed on the page?', { write: () => {} } as any, {
      chatSessionId: sessionId,
    } as any)

    // The turn ends with the model's answer in the saved transcript, not the
    // "did not produce a final answer" fallback.
    const saved = g.getSessionManager().buildHistory(sessionId)
    const assistantText = saved
      .filter((msg) => msg.role === 'assistant')
      .map((msg) => textIn([msg]))
      .join('\n')
    expect(assistantText).toContain('Recovered: the page is a two-column grid.')
    expect(assistantText).not.toContain('did not produce a final answer')
    expect(requests.length).toBe(2)

    // First call really did carry both screenshots; the retry carries the one
    // the provider accepted, by reference, and a placeholder for the other.
    expect(imagesIn(requests[0]).map((block) => block.data)).toEqual([BIG_JPEG, SMALL_PNG])
    const retried = imagesIn(requests[1])
    expect(retried.map((block) => block.data)).toEqual([SMALL_PNG])

    const retriedText = textIn(requests[1])
    expect(retriedText).toContain('3200×1800')
    expect(retriedText).toContain('3000')
    // Actionable advice, keyed to the limit the provider named.
    expect(retriedText).toContain('sips -Z 3000')
  })

  test('a later turn in the same session pays no failed request', async () => {
    const sessionId = 'remembered-cap'
    const g = startGateway()
    await g.start()
    g.getSessionManager().addMessages(
      sessionId,
      ...screenshotRound(BIG_JPEG, 'image/jpeg', 'big'),
      ...screenshotRound(SMALL_PNG, 'image/png', 'fine'),
    )

    await g.processChatMessageStream('What changed?', { write: () => {} } as any, { chatSessionId: sessionId } as any)
    expect(requests.length).toBe(2) // one rejection, then repaired

    const before = requests.length
    await g.processChatMessageStream('And now?', { write: () => {} } as any, { chatSessionId: sessionId } as any)

    const secondTurn = requests.slice(before)
    expect(secondTurn.length).toBe(1) // the cap is known — nothing to discover
    for (const request of secondTurn) {
      expect(imagesIn(request).some((block) => block.data === BIG_JPEG)).toBe(false)
      expect(textIn(request)).toContain('3200×1800')
    }
    // The image the provider accepted is still sent, untouched.
    expect(imagesIn(secondTurn[0]).map((block) => block.data)).toEqual([SMALL_PNG])
  })

  test('a session whose images are all under the cap keeps every one of them', async () => {
    const sessionId = 'all-fine'
    const g = startGateway()
    await g.start()
    const second = pngBase64(1600, 900)
    g.getSessionManager().addMessages(
      sessionId,
      ...screenshotRound(SMALL_PNG, 'image/png', 'a'),
      ...screenshotRound(second, 'image/png', 'b'),
    )

    await g.processChatMessageStream('What is on the page?', { write: () => {} } as any, { chatSessionId: sessionId } as any)

    expect(requests.length).toBe(1) // nothing was rejected
    expect(imagesIn(requests[0]).map((block) => block.data)).toEqual([SMALL_PNG, second])
  })
})
