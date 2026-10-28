// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-201 layer 2: once a provider has told this session its per-image pixel
 * cap, every later request has its over-cap images replaced *before* they go on
 * the wire — so a long screenshot-heavy turn pays for the discovery once, not
 * once per screenshot, and the transcript the next turn sends can never trip
 * the same 400 again.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import type { AssistantMessage, ImageContent, Message, ToolResultMessage } from '@mariozechner/pi-ai'
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai'
import { AgentGateway } from '../gateway'
import { pngBase64 } from './helpers/synthetic-png'

const TEST_DIR = '/tmp/test-gateway-image-dimension-cap'

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const ANTHROPIC_DIMENSION_400 =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":' +
  '"messages.1.content.22.image.source.base64.data: At least one of the image dimensions exceed ' +
  'max allowed size for many-image requests: 3000 pixels"}}'

const BIG = pngBase64(3200, 1800)
const BIGGER = pngBase64(4000, 1000)
const SMALL = pngBase64(1280, 720)

function setupWorkspace() {
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
}

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

function screenshotResult(imageBase64: string, run: string): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: `call_${run}`,
    toolName: 'browser',
    content: [
      { type: 'image', data: imageBase64, mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify({ ok: true, path: `.shogo/screenshots/${run}/step-01.png` }) },
    ],
    isError: false,
    timestamp: 0,
  } as ToolResultMessage
}

function seedingMessages(imageBase64: string, run: string): Message[] {
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
    screenshotResult(imageBase64, run),
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

async function send(gateway: AgentGateway, sessionId: string, text: string) {
  const chunks: any[] = []
  await gateway.processChatMessageStream(text, { write: (c: any) => { chunks.push(c) } } as any, {
    chatSessionId: sessionId,
  })
  return chunks
}

describe('gateway: the pixel cap is remembered for the session', () => {
  let gateway: AgentGateway | undefined
  const prevRetryBase = process.env.SHOGO_INFERENCE_RETRY_BASE_MS
  const prevProviderRetry = process.env.SHOGO_PROVIDER_RETRY

  beforeEach(() => {
    setupWorkspace()
    process.env.SHOGO_INFERENCE_RETRY_BASE_MS = '1'
    process.env.SHOGO_PROVIDER_RETRY = 'off'
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

  test('a screenshot taken after the cap is learned is replaced before it is sent', async () => {
    const sessionId = 'img-cap'
    const requests: Message[][] = []

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(((_model: any, context: any) => {
      requests.push(context.messages)
      // Turn 1: the 3200×1800 image crosses Anthropic's many-image cap and is
      // rejected with the exact production wording. Every later call answers.
      const overCap = imagesIn(context.messages).some((b) => b.data === BIG || b.data === BIGGER)
      return overCap && requests.length === 1
        ? providerError(ANTHROPIC_DIMENSION_400)
        : answer('Here is what I saw.')
    }) as any)
    await gateway.start()

    // History already carries an over-cap screenshot from earlier work, plus a
    // screenshot the provider is happy with.
    gateway.getSessionManager().addMessages(
      sessionId,
      ...seedingMessages(BIG, 'first'),
      ...seedingMessages(SMALL, 'fine'),
    )

    await send(gateway, sessionId, 'What is on the page?')
    expect(requests.length).toBe(2) // rejected once, then repaired
    // The discovery call really did carry the oversized image.
    expect(imagesIn(requests[0]).some((b) => b.data === BIG)).toBe(true)

    // A later screenshot arrives *after* the cap was learned. Nothing rejects
    // it: the wire scrub replaces it, along with the stale one in history.
    gateway.getSessionManager().addMessages(sessionId, ...seedingMessages(BIGGER, 'second'))
    const before = requests.length
    await send(gateway, sessionId, 'And now?')

    const secondTurn = requests.slice(before)
    expect(secondTurn.length).toBe(1) // no failed call to discover the cap again
    for (const request of secondTurn) {
      // Neither the stale nor the fresh over-cap image reaches the provider.
      expect(imagesIn(request).some((b) => b.data === BIG || b.data === BIGGER)).toBe(false)
      const text = textIn(request)
      expect(text).toContain('3200×1800')
      expect(text).toContain('4000×1000')
      expect(text).toContain('3000')
    }
    // The image the provider accepted still goes out, untouched.
    expect(imagesIn(secondTurn[0]).map((b) => b.data)).toEqual([SMALL])
  })

  test('a session that never hit the cap keeps every image (no behaviour change)', async () => {
    const sessionId = 'no-cap'
    const requests: Message[][] = []

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(((_model: any, context: any) => {
      requests.push(context.messages)
      return answer('All good.')
    }) as any)
    await gateway.start()

    gateway.getSessionManager().addMessages(sessionId, ...seedingMessages(BIG, 'only'))

    await send(gateway, sessionId, 'What is on the page?')

    const images = imagesIn(requests[requests.length - 1])
    expect(images.map((b) => b.data)).toContain(BIG)
  })
})
