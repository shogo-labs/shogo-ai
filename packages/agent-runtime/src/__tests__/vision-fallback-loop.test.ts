// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Loop-level acceptance test for SHO-58: on a model whose catalog entry has no
 * `image` input, a screenshot must reach the model as a *description* produced
 * by a vision fallback, not as SHO-41's "Image omitted … Do not describe or
 * guess" note.
 *
 * The loop's LLM is mocked and the describe call is injected through
 * `visionFallback.describeFn`, so there is no network and nothing is billed.
 * The image itself is the encoder-produced PNG fixture SHO-41 committed.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImageContent, Message, ToolResultMessage, Usage } from '@mariozechner/pi-ai'
import { runAgentLoop } from '../agent-loop'
import { resolveModel } from '../pi-adapter'
import { createMockStreamFn, buildTextResponse } from './helpers/mock-anthropic'

const FIXTURE = readFileSync(join(import.meta.dir, 'fixtures/screenshot-fixture.png'))
const IMAGE: ImageContent = { type: 'image', data: FIXTURE.toString('base64'), mimeType: 'image/png' }
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

/** A turn where the `browser` tool already took a screenshot; its result carries the PNG. */
function screenshotHistory(): Message[] {
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
    {
      role: 'toolResult',
      toolCallId: 'call_shot',
      toolName: 'browser',
      content: [{ type: 'text', text: JSON.stringify({ path: SCREENSHOT_PATH }) }, IMAGE],
      isError: false,
      timestamp: Date.now(),
    },
  ]
}

/** The tool result the model saw for `toolName`, split into image and text parts. */
function toolResultParts(messages: Message[], toolName: string) {
  const result = [...messages]
    .reverse()
    .find((m): m is ToolResultMessage => m.role === 'toolResult' && m.toolName === toolName)
  const blocks = (result?.content ?? []) as Array<{ type: string } & Record<string, any>>
  return {
    result,
    images: blocks.filter((c) => c.type === 'image') as ImageContent[],
    texts: blocks.filter((c) => c.type === 'text').map((c) => String(c.text ?? '')),
  }
}

describe('vision fallback on a text-only model', () => {
  test('a text-only model receives a screenshot as a description, not as "do not describe"', async () => {
    // The premise: gpt-4's catalog entry takes text only, so pi-ai's converter
    // would drop the image. A catalog change should fail here loudly.
    expect(resolveModel('openai', 'gpt-4').input).not.toContain('image')

    const captured: Message[][] = []
    let describeCalls = 0
    const streamFn = createMockStreamFn(
      [buildTextResponse('The page shows SHOGO-VISION-FIXTURE.')],
      (_idx, messages) => {
        captured.push(messages)
      },
    )

    const result = await runAgentLoop({
      provider: 'openai',
      model: 'gpt-4',
      system: 'You are a test agent.',
      history: screenshotHistory(),
      prompt: 'What does the screenshot show?',
      tools: [],
      streamFn,
      maxIterations: 2,
      visionFallback: {
        describeFn: async () => {
          describeCalls++
          return DESCRIPTION
        },
      },
    })

    expect(result.text).toContain('SHOGO-VISION-FIXTURE')
    expect(captured).toHaveLength(1)

    const { result: toolResult, images, texts } = toolResultParts(captured[0], 'browser')
    expect(toolResult).toBeDefined()
    expect(images).toHaveLength(0)
    const text = texts.join('\n')
    expect(text).toContain(DESCRIPTION)
    expect(text).not.toContain('Do not describe or guess')
    expect(text).toContain(SCREENSHOT_PATH)
    expect(describeCalls).toBe(1)
  })

  test('a vision model keeps the image inline and never calls the fallback', async () => {
    expect(resolveModel('anthropic', 'claude-sonnet-5').input).toContain('image')

    const captured: Message[][] = []
    let describeCalls = 0
    const streamFn = createMockStreamFn(
      [buildTextResponse('I can see the fixture.')],
      (_idx, messages) => {
        captured.push(messages)
      },
    )

    const result = await runAgentLoop({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      system: 'You are a test agent.',
      history: screenshotHistory(),
      prompt: 'What does the screenshot show?',
      tools: [],
      streamFn,
      maxIterations: 2,
      visionFallback: {
        describeFn: async () => {
          describeCalls++
          return DESCRIPTION
        },
      },
    })

    expect(result.text).toContain('fixture')
    const { images, texts } = toolResultParts(captured[0], 'browser')
    expect(images).toHaveLength(1)
    expect(images[0].mimeType).toBe('image/png')
    expect(texts.join('\n')).not.toContain(DESCRIPTION)
    expect(describeCalls).toBe(0)
  })

  test('a screenshot attached to the prompt is described too, not just noted', async () => {
    const captured: Message[][] = []
    let describeCalls = 0
    const streamFn = createMockStreamFn(
      [buildTextResponse('The attachment shows SHOGO-VISION-FIXTURE.')],
      (_idx, messages) => {
        captured.push(messages)
      },
    )

    await runAgentLoop({
      provider: 'openai',
      model: 'gpt-4',
      system: 'You are a test agent.',
      history: [],
      prompt: 'What is in the attachment?',
      images: [IMAGE],
      tools: [],
      streamFn,
      maxIterations: 2,
      visionFallback: {
        describeFn: async () => {
          describeCalls++
          return DESCRIPTION
        },
      },
    })

    const promptParts = captured[0].filter((m) => m.role === 'user')
    const promptBlocks = promptParts.flatMap((m) =>
      (Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }]) as Array<{
        type: string
        text?: string
      }>,
    )
    expect(promptBlocks.some((b) => b.type === 'image')).toBe(false)
    const promptText = promptBlocks
      .filter((b) => b.type === 'text')
      .map((b) => String((b as { text: string }).text))
      .join('\n')
    expect(promptText).toContain(DESCRIPTION)
    expect(promptText).not.toContain('Do not describe or guess')
    expect(describeCalls).toBe(1)
  })
})
