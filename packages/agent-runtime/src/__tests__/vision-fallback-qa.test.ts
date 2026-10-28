// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA gate for SHO-58 — the acceptance criteria the unit specs do not reach:
 * the describe call is made once across *repeated* transformContext passes
 * (prompt-cache stability), the per-run cap and size budget hold at the loop,
 * the kill switch restores SHO-41's note end to end, and a failed describe
 * call degrades instead of failing the turn.
 *
 * The LLM is mocked and the describe call is injected, so no network and
 * nothing is billed.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImageContent, Message, ToolResultMessage, Usage } from '@mariozechner/pi-ai'
import { runAgentLoop } from '../agent-loop'
import { createMockStreamFn, buildTextResponse, buildToolUseResponse } from './helpers/mock-anthropic'
import { MockToolTracker } from './helpers/mock-tools'

const FIXTURE = readFileSync(join(import.meta.dir, 'fixtures/screenshot-fixture.png'))
const SCREENSHOT_PATH = '.shogo/screenshots/run-1/step-01.png'
const DESCRIPTION = 'A white page with the heading SHOGO-VISION-FIXTURE and a green rectangle.'
const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const image = (suffix = ''): ImageContent => ({
  type: 'image',
  data: `${FIXTURE.toString('base64')}${suffix}`,
  mimeType: 'image/png',
})

/** A `browser` screenshot tool result, optionally N images in one message. */
function screenshotMessage(count = 1): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call_shot',
    toolName: 'browser',
    content: [
      { type: 'text', text: JSON.stringify({ path: SCREENSHOT_PATH }) },
      ...Array.from({ length: count }, (_, i) => image('A'.repeat(i * 4))),
    ],
    isError: false,
    timestamp: Date.now(),
  }
}

function history(...messages: Message[]): Message[] {
  return [
    { role: 'user', content: 'Take a screenshot of the page.', timestamp: Date.now() },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call_shot', name: 'browser', arguments: { action: 'screenshot' } }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'mock-model',
      usage: EMPTY_USAGE,
      stopReason: 'toolUse',
      timestamp: Date.now(),
    },
    ...messages,
  ]
}

function browserText(messages: Message[]): string {
  const result = [...messages]
    .reverse()
    .find((m): m is ToolResultMessage => m.role === 'toolResult' && m.toolName === 'browser')
  return ((result?.content ?? []) as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('\n')
}

function imageBlocks(messages: Message[]): number {
  return messages.reduce(
    (n, m) =>
      n +
      (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'image').length : 0),
    0,
  )
}

afterEach(() => {
  delete process.env.SHOGO_VISION_FALLBACK
})

describe('SHO-58 QA gate: vision fallback on a text-only model', () => {
  test('one describe call across repeated transformContext passes, byte-identical text', async () => {
    const tracker = new MockToolTracker()
    const readTool = tracker.createTool('read_file', 'Read', { content: 'abc' })
    const captured: Message[][] = []
    let describeCalls = 0

    const streamFn = createMockStreamFn(
      [
        buildToolUseResponse([{ name: 'read_file', arguments: { path: 'a.txt' }, id: 'toolu_1' }]),
        buildTextResponse('Done.'),
      ],
      (_idx, messages) => {
        captured.push(messages)
      },
    )

    await runAgentLoop({
      provider: 'openai',
      model: 'gpt-4',
      system: 'You are a test agent.',
      history: history(screenshotMessage()),
      prompt: 'What does the screenshot show?',
      tools: [readTool],
      streamFn,
      maxIterations: 4,
      visionFallback: {
        describeFn: async () => {
          describeCalls += 1
          return DESCRIPTION
        },
      },
    })

    // Two API calls means at least two transformContext passes over the same
    // screenshot. The fallback must not bill a second describe call, and the
    // second pass must emit the same bytes or the prompt-cache prefix shifts.
    expect(captured).toHaveLength(2)
    expect(describeCalls).toBe(1)
    expect(browserText(captured[0])).toContain(DESCRIPTION)
    expect(browserText(captured[1])).toBe(browserText(captured[0]))
    expect(imageBlocks(captured[1])).toBe(0)
    expect(browserText(captured[1])).not.toContain('Do not describe or guess')
  })

  test('a failed describe call degrades to the SHO-41 note and the turn still completes', async () => {
    const captured: Message[][] = []
    const streamFn = createMockStreamFn([buildTextResponse('I could not view it.')], (_i, messages) => {
      captured.push(messages)
    })

    const result = await runAgentLoop({
      provider: 'openai',
      model: 'gpt-4',
      system: 'You are a test agent.',
      history: history(screenshotMessage()),
      prompt: 'What does the screenshot show?',
      tools: [],
      streamFn,
      maxIterations: 2,
      visionFallback: {
        describeFn: async () => {
          throw new Error('vision provider 500')
        },
      },
    })

    const text = browserText(captured[0])
    expect(result.text).toBe('I could not view it.')
    expect(text).toContain('[Image omitted — from browser]')
    expect(text).toContain('another model could not describe it')
    expect(text).toContain(SCREENSHOT_PATH)
    expect(imageBlocks(captured[0])).toBe(0)
  })

  test('SHOGO_VISION_FALLBACK=0 restores the note-only path end to end', async () => {
    process.env.SHOGO_VISION_FALLBACK = '0'
    const captured: Message[][] = []
    let describeCalls = 0
    const streamFn = createMockStreamFn([buildTextResponse('Cannot view images.')], (_i, messages) => {
      captured.push(messages)
    })

    await runAgentLoop({
      provider: 'openai',
      model: 'gpt-4',
      system: 'You are a test agent.',
      history: history(screenshotMessage()),
      prompt: 'What does the screenshot show?',
      tools: [],
      streamFn,
      maxIterations: 2,
      visionFallback: {
        describeFn: async () => {
          describeCalls += 1
          return DESCRIPTION
        },
      },
    })

    const text = browserText(captured[0])
    expect(describeCalls).toBe(0)
    expect(text).toContain('Do not describe or guess')
    expect(text).not.toContain(DESCRIPTION)
  })

  test('an image over the size budget is never sent to the vision model', async () => {
    const captured: Message[][] = []
    let describeCalls = 0
    const streamFn = createMockStreamFn([buildTextResponse('Too large.')], (_i, messages) => {
      captured.push(messages)
    })

    await runAgentLoop({
      provider: 'openai',
      model: 'gpt-4',
      system: 'You are a test agent.',
      history: history(screenshotMessage()),
      prompt: 'What does the screenshot show?',
      tools: [],
      streamFn,
      maxIterations: 2,
      visionFallback: {
        maxImageBytes: 8,
        describeFn: async () => {
          describeCalls += 1
          return DESCRIPTION
        },
      },
    })

    const text = browserText(captured[0])
    expect(describeCalls).toBe(0)
    expect(text).toContain('the image is too large to send to another model')
    expect(text).toContain(SCREENSHOT_PATH)
  })

  test('the per-run cap bounds describe calls; later images still get a note', async () => {
    const captured: Message[][] = []
    let describeCalls = 0
    const streamFn = createMockStreamFn([buildTextResponse('Four shots.')], (_i, messages) => {
      captured.push(messages)
    })

    await runAgentLoop({
      provider: 'openai',
      model: 'gpt-4',
      system: 'You are a test agent.',
      history: history(screenshotMessage(4)),
      prompt: 'What do the screenshots show?',
      tools: [],
      streamFn,
      maxIterations: 2,
      visionFallback: {
        describeFn: async () => {
          describeCalls += 1
          return `${DESCRIPTION} (#${describeCalls})`
        },
      },
    })

    const text = browserText(captured[0])
    expect(describeCalls).toBe(3)
    expect(text.match(/described by /g) ?? []).toHaveLength(3)
    expect(text).toContain('this run already used its image-description budget')
    expect(imageBlocks(captured[0])).toBe(0)
  })
})
