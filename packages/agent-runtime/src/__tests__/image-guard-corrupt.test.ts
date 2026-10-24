// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A corrupt image must never reach a provider request, and a session that
 * already carries one must recover instead of dying on every later turn.
 *
 * Production shape (SigNoz session 1691b02a):
 *   `400 messages[113].image[0]: You have uploaded an unsupported image`
 * — one PNG with a valid signature and a corrupt IDAT, persisted into the
 * transcript, so every subsequent model call failed the same way.
 *
 * Layer 1 (this file): the guard rejects it at emission and the history scrub
 * catches it on replay. Layer 2: if a provider rejects an image anyway, the
 * loop repairs the transcript and retries before surfacing an error.
 */
import { describe, test, expect, beforeAll, spyOn } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { AssistantMessage, Message, ToolResultMessage } from '@mariozechner/pi-ai'
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai'
import { runAgentLoop } from '../agent-loop'
import { enforceImageSizeLimit, scrubInvalidImages } from '../image-size-guard'

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const ANTHROPIC_IMAGE_400 =
  '400 {"type":"error","error":{"type":"invalid_request_error",' +
  '"message":"messages[3].image[0]: You have uploaded an unsupported image"}}'

const PNG = readFileSync(new URL('./fixtures/screenshot-fixture.png', import.meta.url)).toString('base64')

/** Flip one byte inside IDAT — the file still sniffs as PNG. */
function corruptPng(): string {
  const bytes = readFileSync(new URL('./fixtures/screenshot-fixture.png', import.meta.url))
  const corrupt = Buffer.from(bytes)
  corrupt[corrupt.length - 40] ^= 0xff
  return corrupt.toString('base64')
}

function providerErrorStream(errorMessage: string) {
  const output: AssistantMessage = {
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
    stream.push({ type: 'start', partial: output } as any)
    stream.push({ type: 'error', reason: 'error', error: output } as any)
    stream.end()
  })
  return stream as any
}

function okStream(text: string) {
  const msg: AssistantMessage = {
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

function screenshotTurn(imageBase64: string, run = 'run'): Message[] {
  return [
    { role: 'user', content: 'Screenshot the page.', timestamp: 0 } as Message,
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
        { type: 'image', data: imageBase64, mimeType: 'image/png' },
        { type: 'text', text: JSON.stringify({ ok: true, path: `.shogo/screenshots/${run}/step-01.png` }) },
      ],
      isError: false,
      timestamp: 0,
    } as ToolResultMessage,
  ]
}

const hasImage = (messages: Message[]) =>
  messages.some(
    (m) =>
      (m.role === 'user' || m.role === 'toolResult') &&
      Array.isArray(m.content) &&
      m.content.some((c) => c.type === 'image'),
  )

/** Rejects any request that still carries an image, like the real provider. */
function anthropicRejectingImages(seen: Message[][]) {
  return (_model: any, context: any) => {
    seen.push(context.messages)
    return hasImage(context.messages) ? providerErrorStream(ANTHROPIC_IMAGE_400) : okStream('Recovered without the image.')
  }
}

beforeAll(() => {
  process.env.SHOGO_INFERENCE_RETRY_BASE_MS = '1'
})

describe('corrupt image at the tool-result boundary', () => {
  test('enforceImageSizeLimit drops it and names the file', () => {
    const out = enforceImageSizeLimit(
      [
        { type: 'image', data: corruptPng(), mimeType: 'image/png' },
        { type: 'text', text: JSON.stringify({ path: '.shogo/screenshots/run/step-01.png' }) },
      ],
      { label: 'browser:screenshot', pathHint: '.shogo/screenshots/run/step-01.png' },
    )
    expect(out.filter((b) => b.type === 'image')).toHaveLength(0)
    const text = (out[0] as { text: string }).text
    expect(text).toContain('Image omitted')
    expect(text).toContain('.shogo/screenshots/run/step-01.png')
  })
})

describe('image 400 recovery', () => {
  test('scrubs the undecodable image, retries once, and keeps the valid one', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const history = [...screenshotTurn(PNG, 'good'), ...screenshotTurn(corruptPng(), 'bad')]
    const seen: Message[][] = []

    const result = await runAgentLoop({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      system: 'test',
      history,
      prompt: 'What is on the page?',
      tools: [],
      streamFn: anthropicRejectingImages(seen) as any,
      maxIterations: 3,
      scrubInvalidImages,
    })

    expect(result.error).toBeUndefined()
    expect(result.text).toContain('Recovered without the image')
    // First request carried images and was rejected; the retry scrubbed only
    // the corrupt one, so the good screenshot still reaches the model.
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(hasImage(seen[0])).toBe(true)
    expect(hasImage(seen[1])).toBe(true)
    const retriedImages = seen[1].flatMap((m) =>
      m.role === 'toolResult' && Array.isArray(m.content)
        ? m.content.filter((c) => c.type === 'image')
        : [],
    ) as Array<{ data: string }>
    expect(retriedImages).toHaveLength(1)
    expect(retriedImages[0].data).toBe(PNG)
    expect(warn.mock.calls.some((call) => String(call[0]).includes('IMAGE_RECOVERY stage=1'))).toBe(true)
    warn.mockRestore()
  })

  test('without an injected scrubber it still recovers by dropping stale images', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const history = screenshotTurn(corruptPng(), 'bad')
    const seen: Message[][] = []

    const result = await runAgentLoop({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      system: 'test',
      history,
      prompt: 'What is on the page?',
      tools: [],
      streamFn: anthropicRejectingImages(seen) as any,
      maxIterations: 3,
    })

    expect(result.error).toBeUndefined()
    expect(result.text).toContain('Recovered without the image')
    expect(hasImage(seen[seen.length - 1])).toBe(false)
    warn.mockRestore()
  })

  test('gives up with an image-specific error, not the generic fallback', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const history = screenshotTurn(corruptPng(), 'bad')

    const result = await runAgentLoop({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      system: 'test',
      history,
      prompt: 'What is on the page?',
      tools: [],
      // Keeps rejecting no matter what we scrub.
      streamFn: (() => providerErrorStream(ANTHROPIC_IMAGE_400)) as any,
      maxIterations: 3,
      scrubInvalidImages,
    })

    expect(result.error?.message).toMatch(/rejected the images/i)
    // The surfaced cause names images — the gateway maps this to a specific
    // message instead of "I encountered an issue processing your message."
    expect(result.error?.message).toContain('unsupported image')
    expect(result.text).not.toContain('I encountered an issue')
    warn.mockRestore()
  })
})
