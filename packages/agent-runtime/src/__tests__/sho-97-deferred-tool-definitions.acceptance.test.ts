// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Acceptance tests for SHO-97 — tool definitions cost ~29k tokens on every API
 * call. The gateway now advertises a core set plus each agent's learned top
 * tools and defers the rest behind a catalog.
 *
 * Everything here is measured at the provider boundary: the `context.tools`
 * each mocked API call actually receives, which is exactly what would be billed.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import type { AgentTool, StreamFn } from '@mariozechner/pi-agent-core'
import { AgentGateway } from '../gateway'
import { createMockStreamFn, buildTextResponse, buildToolUseResponse } from './helpers/mock-anthropic'
import { DEFAULT_TOKEN_BUDGET, DEFERRED_TOOLS_ENV, resetToolRankingCache } from '../tool-profile'

const TEST_DIR = '/tmp/test-sho-97-deferred-tool-definitions'

interface ApiCall {
  tools: string[]
  /** Estimated tokens of the tool block, on the prompt breakdown's chars/4 basis. */
  toolTokens: number
  systemPrompt: string
  messages: unknown[]
}

function setupWorkspace(extraConfig: Record<string, unknown> = {}): void {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  writeFileSync(
    join(TEST_DIR, 'config.json'),
    JSON.stringify({
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      ...extraConfig,
    }),
  )
  writeFileSync(join(TEST_DIR, 'AGENTS.md'), '# Identity\nTest Agent\n\n# Personality\nBe helpful.')
}

/** Mock the API while recording the tool block the provider would have received. */
function capturingStream(responses: ReturnType<typeof buildTextResponse>[]): {
  streamFn: StreamFn
  calls: ApiCall[]
} {
  const calls: ApiCall[] = []
  const inner = createMockStreamFn(responses)
  const streamFn: StreamFn = (model, context, options) => {
    const tools = (context.tools ?? []) as AgentTool[]
    const chars = tools.reduce(
      (sum, t) =>
        sum +
        JSON.stringify({ name: t.name, description: t.description, input_schema: (t as any).parameters }).length,
      0,
    )
    calls.push({
      tools: tools.map(t => t.name),
      toolTokens: Math.ceil(chars / 4),
      systemPrompt: (context.systemPrompt as string) || (context as any).system || '',
      messages: (context.messages ?? []) as unknown[],
    })
    return inner(model, context, options)
  }
  return { streamFn, calls }
}

/** Just the deferred catalog section of a system prompt (prose elsewhere names tools too). */
function catalogOf(prompt: string): string {
  const start = prompt.indexOf('## Deferred Tools')
  if (start === -1) return ''
  const rest = prompt.slice(start)
  const end = rest.search(/\n\n---\n\n|<\|CACHE_BOUNDARY\|>/)
  return end === -1 ? rest : rest.slice(0, end)
}

function toolResultText(call: ApiCall): string {
  const last = call.messages[call.messages.length - 1] as any
  const content = last?.content
  if (Array.isArray(content)) return content.map((c: any) => c?.text ?? c?.content ?? '').join('\n')
  return typeof content === 'string' ? content : ''
}

let gateway: AgentGateway | undefined
let logSpy: string[] = []
const originalLog = console.log

beforeEach(() => {
  resetToolRankingCache()
  delete process.env[DEFERRED_TOOLS_ENV]
  logSpy = []
  console.log = (...args: unknown[]) => {
    logSpy.push(args.map(a => String(a)).join(' '))
  }
})

afterEach(async () => {
  console.log = originalLog
  if (gateway) await gateway.stop()
  gateway = undefined
  rmSync(TEST_DIR, { recursive: true, force: true })
})

async function runTurn(
  config: Record<string, unknown>,
  responses: ReturnType<typeof buildTextResponse>[],
): Promise<ApiCall[]> {
  setupWorkspace(config)
  const capture = capturingStream(responses)
  gateway = new AgentGateway(TEST_DIR, 'test-project')
  gateway.setStreamFn(capture.streamFn)
  await gateway.start()
  await gateway.processChatMessage('ping')
  return capture.calls
}

const readFileThenText = () => [
  buildToolUseResponse([{ name: 'read_file', arguments: { path: join(TEST_DIR, 'AGENTS.md') } }]),
  buildTextResponse('done'),
]

describe('SHO-97: deferred tool definitions', () => {
  test('a fully-enabled agent sends dramatically less than every schema, inside the budget', async () => {
    const off = await runTurn({ deferredToolsEnabled: false }, readFileThenText())
    const baselineTools = off[0].tools
    const baselineTokens = off[0].toolTokens
    await gateway!.stop()
    gateway = undefined

    const deferred = await runTurn({}, readFileThenText())

    // Absolute counts are environment-dependent: CI's isolated runner registers
    // ~60 tools where a developer machine that has integrations installed sees
    // ~110. The claim is relative, so assert the ratio rather than a count.
    expect(baselineTools.length).toBeGreaterThan(deferred[0].tools.length * 2)
    expect(deferred[0].toolTokens).toBeLessThanOrEqual(DEFAULT_TOKEN_BUDGET)
    // The measured win, per API call.
    expect(deferred[0].toolTokens).toBeLessThan(baselineTokens / 2)
  })

  test('every registered tool is either advertised or named in the catalog', async () => {
    const off = await runTurn({ deferredToolsEnabled: false }, readFileThenText())
    const registered = new Set(off[0].tools)
    await gateway!.stop()
    gateway = undefined

    const deferred = await runTurn({}, readFileThenText())
    const advertised = new Set(deferred[0].tools)
    const prompt = catalogOf(deferred[0].systemPrompt)

    expect(prompt).toContain('## Deferred Tools')
    for (const name of registered) {
      if (advertised.has(name)) continue
      const toolkit = name.includes('_') ? name.slice(0, name.indexOf('_')) : ''
      const groupLine = new RegExp(`^- ${toolkit.charAt(0)}${toolkit.slice(1).toLowerCase()} [(]`, 'm')
      expect(prompt.includes(name) || (toolkit ? groupLine.test(prompt) : false)).toBe(true)
    }
  })

  test('the tool block is byte-identical across the API calls of a turn', async () => {
    const calls = await runTurn({}, readFileThenText())
    expect(calls.length).toBe(2)
    expect(calls[1].tools).toEqual(calls[0].tools)
    expect(calls[1].toolTokens).toBe(calls[0].toolTokens)
  })

  test('read_guide({ tool }) returns the schema and advertises it on the next call', async () => {
    const calls = await runTurn({}, [
      buildToolUseResponse([{ name: 'read_guide', arguments: { tool: 'publish' } }]),
      buildTextResponse('done'),
    ])

    expect(calls[0].tools).not.toContain('publish')
    expect(toolResultText(calls[1])).toContain('Input schema')
    expect(calls[1].tools).toContain('publish')
  })

  test('a deferred tool called directly still runs', async () => {
    // `publish` is the one deferred tool that is registered in every
    // environment — `board_list`, `goal_list` and `heartbeat_status` only exist
    // when the runtime is wired to a workspace, which CI's runner is not.
    //
    // Only dispatch is asserted here: a mocked tool replaces `execute`, so the
    // `withActivationOnCall` wrapper never runs. Activation is pinned by the
    // `read_guide({ tool })` case above, which goes through `profile.advertise`
    // rather than through a tool call.
    setupWorkspace({})
    const publishCalls: Record<string, any>[] = []
    const capture = capturingStream([
      buildToolUseResponse([{ name: 'publish', arguments: { subdomain: 'sho-97-direct' } }]),
      buildTextResponse('done'),
    ])
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(capture.streamFn)
    gateway.setToolMocks({
      publish: params => {
        publishCalls.push(params)
        return { ok: true, url: 'https://sho-97-direct.shogo.one' }
      },
    })
    await gateway.start()
    await gateway.processChatMessage('publish it')

    expect(capture.calls[0].tools).not.toContain('publish')
    expect(toolResultText(capture.calls[1])).not.toContain('Tool not found')
    // The call reached the tool with the arguments the model sent.
    expect(publishCalls).toHaveLength(1)
    expect(publishCalls[0].subdomain).toBe('sho-97-direct')
  })

  test('the prompt breakdown shows advertised schemas plus a deferred count', async () => {
    const calls = await runTurn({}, readFileThenText())
    const breakdown = logSpy.join('\n')
    const toolLine = breakdown.split('\n').find(l => l.includes('Tool schemas ('))
    expect(toolLine).toBeDefined()
    const advertisedCount = Number(toolLine!.match(/Tool schemas \((\d+)\)/)![1])
    expect(advertisedCount).toBe(calls[0].tools.length)
    expect(breakdown).toContain('deferred (')
    expect(breakdown).toContain('tools, not sent)')

    const catalogSection = (gateway!.lastPromptBreakdown ?? []).find(s => s.label === 'deferred-tools-catalog')
    expect(catalogSection).toBeDefined()
    expect(catalogSection!.zone).toBe('stable')
  })

  test('turning the flag off restores every schema', async () => {
    const on = await runTurn({}, readFileThenText())
    await gateway!.stop()
    gateway = undefined
    const off = await runTurn({ deferredToolsEnabled: false }, readFileThenText())

    // Every tool the deferred run advertised is in the full set, and the full
    // set is strictly bigger — no absolute tool count, which varies by machine.
    for (const name of on[0].tools) expect(off[0].tools).toContain(name)
    expect(off[0].tools.length).toBeGreaterThan(on[0].tools.length)
    expect(off[0].systemPrompt).not.toContain('## Deferred Tools')
  })
})

/**
 * Criterion 9's scenario half, without a live model: a task whose only route to
 * done is a deferred tool. `publish` is not in CORE_TOOL_NAMES, so discovery via
 * `read_guide({ tool })` is what makes the second call able to reach it.
 */
describe('SHO-97: a task that needs a deferred tool still completes', () => {
  test('discovery → advertisement → execution → result', async () => {
    setupWorkspace({})
    const publishCalls: Record<string, any>[] = []
    const capture = capturingStream([
      buildToolUseResponse([{ name: 'read_guide', arguments: { tool: 'publish' } }]),
      buildToolUseResponse([{ name: 'publish', arguments: { subdomain: 'sho-eval-deferred' } }]),
      buildTextResponse('published'),
    ])
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(capture.streamFn)
    gateway.setToolMocks({
      publish: params => {
        publishCalls.push(params)
        return {
          ok: true,
          published: true,
          url: 'https://sho-eval-deferred.shogo.one',
          subdomain: 'sho-eval-deferred',
          verified: true,
        }
      },
    })
    await gateway.start()
    await gateway.processChatMessage('publish this app to sho-eval-deferred')

    expect(capture.calls.length).toBe(3)
    // Deferred at session start, advertised on the next call after discovery.
    expect(capture.calls[0].tools).not.toContain('publish')
    expect(toolResultText(capture.calls[1])).toContain('Input schema')
    expect(capture.calls[1].tools).toContain('publish')
    // The call actually ran, with the subdomain the task named...
    expect(publishCalls).toHaveLength(1)
    expect(publishCalls[0].subdomain).toBe('sho-eval-deferred')
    // ...and its result reached the model.
    expect(toolResultText(capture.calls[2])).toContain('sho-eval-deferred.shogo.one')
  })
})
