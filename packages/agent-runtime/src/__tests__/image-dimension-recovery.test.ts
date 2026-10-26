// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Anthropic caps each image's *pixel* size on a request that carries many
 * images, and reports the violation in a completely different shape from the
 * "You have uploaded an unsupported image" 400 the repair ladder was built for:
 *
 *   `400 messages.1.content.22.image.source.base64.data: At least one of the
 *    image dimensions exceed max allowed size for many-image requests: 3000 pixels`
 *
 * Production (Russell, 2026-10-25, thread 93d2ff50): a turn ended after 53 tool
 * calls with the "the model did not produce a final answer" fallback, because
 * that message matched no image-rejection pattern, was classified
 * non-retryable, and stopped the loop.
 *
 * Layer 1 (this file): the ladder recognises the wording, learns the cap, and
 * replaces only the images over it. Layer 2 (image-dimension-session-cap): the
 * gateway keeps the cap for the session so later screenshots never cost a
 * failed request.
 */
import { describe, test, expect, beforeAll, spyOn } from 'bun:test'
import type { AssistantMessage, ImageContent, Message, ToolResultMessage } from '@mariozechner/pi-ai'
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai'
import { runAgentLoop, classifyRetryability } from '../agent-loop'
import { enforceImageSizeLimit, scrubInvalidImages } from '../image-size-guard'
import { pngBase64 } from './helpers/synthetic-png'

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** Verbatim production error text. */
const ANTHROPIC_DIMENSION_400 =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":' +
  '"messages.1.content.22.image.source.base64.data: At least one of the image dimensions exceed ' +
  'max allowed size for many-image requests: 3000 pixels. Each image must be less than 3000 pixels ' +
  'on its longest side."}}'

const SMALL_A = pngBase64(1280, 720)
const SMALL_B = pngBase64(1600, 900)
const BIG = pngBase64(3200, 1800)

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

function screenshotTurn(imageBase64: string, run: string): Message[] {
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
        { type: 'image', data: imageBase64, mimeType: 'image/png' },
        { type: 'text', text: JSON.stringify({ ok: true, path: `.shogo/screenshots/${run}/step-01.png` }) },
      ],
      isError: false,
      timestamp: 0,
    } as ToolResultMessage,
  ]
}

/** Every image block in a request, in transcript order. */
function imageBlocks(messages: Message[]): ImageContent[] {
  const out: ImageContent[] = []
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'toolResult') continue
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content) if (block.type === 'image') out.push(block)
  }
  return out
}

/** All text blocks of a request, joined. */
function requestText(messages: Message[]): string {
  const out: string[] = []
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content as Array<{ type: string; text?: string }>) {
      if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    }
  }
  return out.join('\n')
}

/**
 * Behaves like Anthropic here: any request still carrying the 3200×1800 image
 * is rejected with the dimension 400 above, everything else is answered.
 */
function rejectingOverCap(seen: Message[][]) {
  return (_model: any, context: any) => {
    seen.push(context.messages)
    const oversized = imageBlocks(context.messages).some((block) => block.data === BIG)
    return oversized ? providerErrorStream(ANTHROPIC_DIMENSION_400) : okStream('Recovered without the oversized image.')
  }
}

beforeAll(() => {
  process.env.SHOGO_INFERENCE_RETRY_BASE_MS = '1'
})

describe('image pixel-dimension 400 recovery', () => {
  test('the turn continues instead of ending on "did not produce a final answer"', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const history = [
      ...screenshotTurn(SMALL_A, 'a'),
      ...screenshotTurn(SMALL_B, 'b'),
      ...screenshotTurn(BIG, 'big'),
    ]
    const seen: Message[][] = []
    const limits: number[] = []

    const result = await runAgentLoop({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      system: 'test',
      history,
      prompt: 'What changed on the page?',
      tools: [],
      streamFn: rejectingOverCap(seen) as any,
      maxIterations: 3,
      scrubInvalidImages,
      onImageDimensionLimit: (limit) => limits.push(limit),
    })

    expect(result.error).toBeUndefined()
    expect(result.text).toContain('Recovered without the oversized image.')
    expect(result.text).not.toContain('did not produce a final answer')

    // The cap was read out of the message and reported to the runtime.
    expect(limits).toEqual([3000])

    // First request carried all three screenshots and was rejected; the retry
    // carried the two the provider accepted, by reference, unchanged.
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(imageBlocks(seen[0]).map((b) => b.data)).toEqual([SMALL_A, SMALL_B, BIG])
    expect(imageBlocks(seen[1]).map((b) => b.data)).toEqual([SMALL_A, SMALL_B])

    // Only the oversized one became a placeholder, and it is actionable.
    const retried = requestText(seen[1])
    expect(retried).toContain('3200×1800')
    expect(retried).toContain('3000')
    expect(retried).toContain('.shogo/screenshots/big/step-01.png')
    // The two images the provider accepted were not turned into placeholders.
    expect(retried).not.toContain('1280×720')
    expect(retried).not.toContain('1600×900')
    expect(warn.mock.calls.some((call) => String(call[0]).includes('IMAGE_RECOVERY stage=1'))).toBe(true)
    warn.mockRestore()
  })

  test('an oversized image in this turn is repaired in the transcript that gets saved', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const seen: Message[][] = []

    const result = await runAgentLoop({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      system: 'test',
      history: [],
      prompt: 'What does this screenshot show?',
      images: [{ type: 'image', data: BIG, mimeType: 'image/png' }],
      tools: [],
      streamFn: rejectingOverCap(seen) as any,
      maxIterations: 3,
      scrubInvalidImages,
    })

    expect(result.error).toBeUndefined()
    expect(result.text).toContain('Recovered without the oversized image.')
    // `newMessages` is what the runtime persists: the repaired copy, never the
    // original, so the next turn cannot re-send the image that was rejected.
    expect(imageBlocks(result.newMessages)).toHaveLength(0)
    expect(requestText(result.newMessages)).toContain('3200×1800')
    warn.mockRestore()
  })

  test('without a dimension cap the ladder behaves exactly as before', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    // Same 400, but scrubbing only knows about decode/byte problems, so the
    // dimension stage cannot fix anything and the blanket stages take over.
    const history = screenshotTurn(BIG, 'big')
    const seen: Message[][] = []

    const result = await runAgentLoop({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      system: 'test',
      history,
      prompt: 'What changed?',
      tools: [],
      streamFn: rejectingOverCap(seen) as any,
      maxIterations: 3,
      // No maxDimension is ever passed here — mimics an older caller.
      scrubInvalidImages: (messages) => scrubInvalidImages(messages),
    })

    expect(result.error).toBeUndefined()
    expect(result.text).toContain('Recovered without the oversized image.')
    expect(imageBlocks(seen[seen.length - 1])).toHaveLength(0)
    warn.mockRestore()
  })
})

describe('the widened image pattern stays inside the loop', () => {
  const classify = (message: string) =>
    classifyRetryability({ message, aborted: false })

  test('the classifier still reads image 400s as non-retryable, as before', () => {
    // The loop intercepts image rejections before classification; the
    // classifier's verdict is unchanged, so no other 400 path moved.
    expect(classify(ANTHROPIC_DIMENSION_400).retryable).toBe(false)
    expect(classify(ANTHROPIC_DIMENSION_400).reason).toBe('invalid_request')
  })

  test('an unrelated 400 is still non-retryable and a 429 still is', () => {
    expect(classify('400 {"type":"error","error":{"type":"invalid_request_error","message":"roles must alternate"}}').retryable).toBe(false)
    expect(classify('429 rate limit exceeded').retryable).toBe(true)
    expect(classify('529 overloaded_error').retryable).toBe(true)
  })
})

describe('scrubInvalidImages with a dimension cap', () => {
  const toolResultWith = (imageBase64: string, path: string): Message =>
    ({
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'browser',
      content: [
        { type: 'image', data: imageBase64, mimeType: 'image/png' },
        { type: 'text', text: JSON.stringify({ path }) },
      ],
      isError: false,
      timestamp: 0,
    }) as ToolResultMessage

  test('replaces an over-limit image with a placeholder naming its size and the limit', () => {
    const messages = [toolResultWith(BIG, '.shogo/screenshots/big/step-01.png')]
    const out = scrubInvalidImages(messages, { maxDimension: 3000 })

    expect(out).not.toBe(messages)
    expect(imageBlocks(out)).toHaveLength(0)
    const text = requestText(out)
    expect(text).toContain('3200×1800')
    expect(text).toContain('3000')
    expect(text).toContain('.shogo/screenshots/big/step-01.png')
    // The existing downscale-and-re-read advice, keyed to the real path.
    expect(text).toContain('sips -Z 3000')
  })

  test('under-limit images pass through by reference', () => {
    const messages = [
      { role: 'user', content: [{ type: 'image', data: SMALL_A, mimeType: 'image/png' }], timestamp: 0 } as Message,
      toolResultWith(SMALL_B, '.shogo/screenshots/b/step-01.png'),
    ]
    const out = scrubInvalidImages(messages, { maxDimension: 3000 })

    expect(out).toBe(messages)
    expect(imageBlocks(out).map((b) => b.data)).toEqual([SMALL_A, SMALL_B])
  })

  test('with no maxDimension nothing changes, so the prompt-cache prefix stays stable', () => {
    const messages = [toolResultWith(BIG, '.shogo/screenshots/big/step-01.png')]
    expect(scrubInvalidImages(messages)).toBe(messages)
    expect(scrubInvalidImages(messages, {})).toBe(messages)
  })

  test('a cap wide enough for every image changes nothing either', () => {
    const messages = [toolResultWith(BIG, '.shogo/screenshots/big/step-01.png')]
    expect(scrubInvalidImages(messages, { maxDimension: 4000 })).toBe(messages)
  })

  test('enforceImageSizeLimit applies the cap per block and keeps the rest', () => {
    const content = [
      { type: 'image', data: BIG, mimeType: 'image/png' },
      { type: 'image', data: SMALL_A, mimeType: 'image/png' },
    ] as Array<ImageContent>
    const out = enforceImageSizeLimit(content, {
      label: 'browser:screenshot',
      pathHint: '.shogo/screenshots/big/step-01.png',
      maxDimension: 3000,
    })

    expect(out).not.toBe(content)
    expect(out[0].type).toBe('text')
    expect((out[0] as { text: string }).text).toContain('3200×1800')
    expect(out[1]).toBe(content[1])
  })
})
