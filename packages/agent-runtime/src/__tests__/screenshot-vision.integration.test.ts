// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration test: a screenshot taken by the `browser` tool (and a PNG read
 * back with `read_file`) must be visible to the model — i.e. it must reach
 * the *model request* as an image part.
 *
 * The tool-return half of this is already covered by
 * `gateway-tools.browser-mocked.test.ts`; this test walks the rest of the
 * pipeline with real Chromium and real tool execution, and asserts on the
 * messages the next `streamFn` call actually receives. The LLM is mocked, so
 * nothing is billed and the only "network" is a `data:` URL.
 *
 * Two models, because they fail differently:
 *  - a vision model (anthropic) must receive the pixels;
 *  - a model whose pi-ai catalog entry has no `image` input must not lose the
 *    screenshot silently — the request carries a text note naming the file
 *    instead (pi-ai's openai/google converters drop tool-result images when
 *    `model.input` lacks `image`, which is what made screenshots invisible).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { Message, ToolResultMessage } from '@mariozechner/pi-ai'
import { createTools } from '../gateway-tools'
import { resetSharedBrowserPool } from '../browser-pool'
import { runAgentLoop } from '../agent-loop'
import { resolveModel } from '../pi-adapter'
import { createMockStreamFn, buildTextResponse, buildToolUseResponse } from './helpers/mock-anthropic'

/**
 * These specs launch real Chromium. The CI `test` matrix job runs `bun test`
 * without installing browsers (only `e2e-local` installs them), so skip with a
 * loud reason instead of failing every shard — run
 * `npx playwright install chromium` locally to exercise them.
 */
function chromiumInstalled(): boolean {
  const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  if (override) return existsSync(override)
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
}

const HAS_CHROMIUM = chromiumInstalled()

if (!HAS_CHROMIUM) {
  console.warn(
    '[screenshot-vision] skipped: no Playwright Chromium in this environment — ' +
      'run `npx playwright install chromium` to run the real-browser specs.',
  )
}

const FIXTURE_URL =
  'data:text/html,' +
  encodeURIComponent(
    '<html><body style="margin:0;background:#fff">' +
      '<h1 style="font:48px sans-serif;color:#111">SHOGO-VISION-FIXTURE</h1>' +
      '<div style="width:200px;height:120px;background:#1a7f37"></div>' +
      '</body></html>',
  )

const VIEWPORT = { width: 500, height: 400 }

/** IHDR dimensions — proves the block is the real screenshot, not a stub. */
function pngSize(base64: string): { width: number; height: number } {
  const buf = Buffer.from(base64, 'base64')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

let workspaceDir: string
let tools: AgentTool[]
let browserTool: AgentTool
let readFileTool: AgentTool

function toolByName(name: string): AgentTool {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`tool ${name} not registered`)
  return tool
}

/** The last tool result the model saw for `toolName`, plus its image parts. */
function toolResult(messages: Message[], toolName: string) {
  const result = [...messages]
    .reverse()
    .find((m): m is ToolResultMessage => m.role === 'toolResult' && m.toolName === toolName)
  const blocks = (result?.content ?? []) as Array<{ type: string; data?: string; mimeType?: string; text?: string }>
  return {
    result,
    images: blocks.filter((c) => c.type === 'image') as Array<{ type: 'image'; data: string; mimeType: string }>,
    texts: blocks.filter((c) => c.type === 'text').map((c) => c.text ?? ''),
  }
}

beforeAll(async () => {
  // realpath: assertWithinWorkspace compares real paths, and macOS symlinks
  // /var -> /private/var — a raw mkdtemp path is rejected as "outside".
  workspaceDir = mkdtempSync(join(realpathSync(tmpdir()), 'shogo-vision-'))
  tools = createTools({
    workspaceDir,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'vision-test',
  } as any)
  browserTool = toolByName('browser')
  readFileTool = toolByName('read_file')
}, 120_000)

afterAll(async () => {
  await resetSharedBrowserPool()
  rmSync(workspaceDir, { recursive: true, force: true })
})

describe.skipIf(!HAS_CHROMIUM)('browser screenshot → model request', () => {
  test('a vision model receives the PNG as an image part', async () => {
    const captured: Message[][] = []
    const streamFn = createMockStreamFn(
      [
        buildToolUseResponse([
          { name: 'browser', arguments: { action: 'navigate', url: FIXTURE_URL }, id: 'call_navigate' },
        ]),
        buildToolUseResponse([
          {
            name: 'browser',
            arguments: { action: 'viewport', width: VIEWPORT.width, height: VIEWPORT.height },
            id: 'call_viewport',
          },
        ]),
        buildToolUseResponse([{ name: 'browser', arguments: { action: 'screenshot' }, id: 'call_screenshot' }]),
        buildTextResponse('The page shows SHOGO-VISION-FIXTURE.'),
      ],
      (_idx, messages) => {
        captured.push(messages)
      },
    )

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'You are a test agent.',
      history: [],
      prompt: 'Screenshot the page.',
      tools: [browserTool],
      streamFn,
      maxIterations: 6,
    })

    expect(result.text).toContain('SHOGO-VISION-FIXTURE')
    // The call issued *after* the screenshot tool result is the one that must
    // let the model see the pixels — not just the JSON with the saved path.
    expect(captured).toHaveLength(4)
    const { result: toolResultMsg, images } = toolResult(captured[3], 'browser')
    expect(toolResultMsg).toBeDefined()
    expect(images).toHaveLength(1)
    expect(images[0].mimeType).toBe('image/png')
    expect(pngSize(images[0].data)).toEqual({ width: VIEWPORT.width, height: VIEWPORT.height })
  }, 180_000)

  test('read_file on the saved screenshot also reaches a vision model as an image', async () => {
    await browserTool.execute('t-navigate', { action: 'navigate', url: FIXTURE_URL })
    await browserTool.execute('t-viewport', { action: 'viewport', ...VIEWPORT })
    const shot = await browserTool.execute('t-shot', { action: 'screenshot' })
    const savedPath = (shot.details as { path?: string })?.path
    expect(savedPath).toMatch(/^\.shogo\/screenshots\//)
    // read_file resolves relative paths against the process cwd; the tool
    // reports workspace-relative, so anchor it on the workspace root.
    const absolutePath = join(workspaceDir, savedPath!)

    const captured: Message[][] = []
    const streamFn = createMockStreamFn(
      [
        buildToolUseResponse([{ name: 'read_file', arguments: { path: absolutePath }, id: 'call_read' }]),
        buildTextResponse('I can see the fixture.'),
      ],
      (_idx, messages) => {
        captured.push(messages)
      },
    )

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'You are a test agent.',
      history: [],
      prompt: `Read ${absolutePath}`,
      tools: [readFileTool],
      streamFn,
      maxIterations: 4,
    })

    expect(result.text).toContain('fixture')
    const { images } = toolResult(captured[1], 'read_file')
    expect(images).toHaveLength(1)
    expect(images[0].mimeType).toBe('image/png')
    expect(pngSize(images[0].data)).toEqual({ width: VIEWPORT.width, height: VIEWPORT.height })
  }, 180_000)

  test('a model without image input gets an explicit note instead of a silent drop', async () => {
    // `gpt-4`'s pi-ai catalog entry advertises only text input, so pi-ai's
    // converter throws tool-result images away without a word. Assert the
    // assumption first, so a catalog change reads as a clear failure here
    // rather than as a mystery in the loop.
    expect(resolveModel('openai', 'gpt-4').input).not.toContain('image')

    await browserTool.execute('t-navigate', { action: 'navigate', url: FIXTURE_URL })

    const captured: Message[][] = []
    const streamFn = createMockStreamFn(
      [
        buildToolUseResponse([{ name: 'browser', arguments: { action: 'screenshot' }, id: 'call_screenshot' }]),
        buildTextResponse('I cannot view images with this model.'),
      ],
      (_idx, messages) => {
        captured.push(messages)
      },
    )

    const result = await runAgentLoop({
      provider: 'openai',
      model: 'gpt-4',
      system: 'You are a test agent.',
      history: [],
      prompt: 'Screenshot the page.',
      tools: [browserTool],
      streamFn,
      maxIterations: 4,
    })

    expect(result.text).toContain('cannot view images')
    const { images, texts } = toolResult(captured[1], 'browser')
    expect(images).toHaveLength(0)
    const note = texts.join('\n')
    expect(note).toContain('Image omitted')
    expect(note).toContain('gpt-4')
    expect(note).toContain('.shogo/screenshots/')
  }, 180_000)
})
