// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-97 QA — the deferred tool set must not cost cache hits.
 *
 * Criterion 4 pins the tools block to one turn. The expensive failure is one
 * level up: the tools block and the Deferred Tools catalog are the head of the
 * provider cache prefix (`plans/2026-10-20-cache-efficiency-evals.md`), so if
 * either is re-derived per *turn* every cache read after the first turn misses
 * and the change costs more than the schemas it removed. These pin the prefix
 * across a whole session, not just across the two API calls of one turn.
 *
 * Measured at the provider boundary, like the developer's acceptance test.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import type { AgentTool, StreamFn } from '@mariozechner/pi-agent-core'
import { AgentGateway } from '../gateway'
import { createMockStreamFn, buildTextResponse, buildToolUseResponse } from './helpers/mock-anthropic'
import { resetToolRankingCache } from '../tool-profile'

const TEST_DIR = '/tmp/test-sho-97-deferred-tools-stability'

interface ApiCall {
  /** Serialized tool definitions — exactly the bytes the provider caches. */
  toolBlock: string
  tools: string[]
  systemPrompt: string
}

function setupWorkspace(): void {
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
    }),
  )
  writeFileSync(join(TEST_DIR, 'AGENTS.md'), '# Identity\nTest Agent\n\n# Personality\nBe helpful.')
}

function capturingStream(responses: ReturnType<typeof buildTextResponse>[]): {
  streamFn: StreamFn
  calls: ApiCall[]
} {
  const calls: ApiCall[] = []
  const inner = createMockStreamFn(responses)
  const streamFn: StreamFn = (model, context, options) => {
    const tools = (context.tools ?? []) as AgentTool[]
    calls.push({
      tools: tools.map(t => t.name),
      toolBlock: JSON.stringify(
        tools.map(t => ({ name: t.name, description: t.description, input_schema: (t as any).parameters })),
      ),
      systemPrompt: (context.systemPrompt as string) || (context as any).system || '',
    })
    return inner(model, context, options)
  }
  return { streamFn, calls }
}

/** Just the deferred catalog section of a system prompt. */
function catalogOf(prompt: string): string {
  const start = prompt.indexOf('## Deferred Tools')
  if (start === -1) return ''
  const rest = prompt.slice(start)
  const end = rest.search(/\n\n---\n\n|<\|CACHE_BOUNDARY\|>/)
  return end === -1 ? rest : rest.slice(0, end)
}

let gateway: AgentGateway | undefined

beforeEach(() => {
  resetToolRankingCache()
  setupWorkspace()
})

afterEach(async () => {
  if (gateway) await gateway.stop()
  gateway = undefined
  rmSync(TEST_DIR, { recursive: true, force: true })
})

/** The gateway prints a prompt breakdown per turn; keep the test output readable. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log
  console.log = () => {}
  try {
    return await fn()
  } finally {
    console.log = originalLog
  }
}

async function startGateway(responses: ReturnType<typeof buildTextResponse>[]): Promise<ApiCall[]> {
  const capture = capturingStream(responses)
  gateway = new AgentGateway(TEST_DIR, 'test-project')
  gateway.setStreamFn(capture.streamFn)
  // `publish` is registered in every environment; the workspace-only tools
  // (`goal_list`, `board_list`) are absent from CI's isolated runner.
  gateway.setToolMocks({ publish: () => ({ ok: true, url: 'https://sho-97-stability.shogo.one' }) })
  await quietly(() => gateway!.start())
  return capture.calls
}

describe('SHO-97 QA: the advertised set is stable for the whole session', () => {
  test('two turns in one session send a byte-identical tools block and catalog', async () => {
    const calls = await startGateway([buildTextResponse('first answer'), buildTextResponse('second answer')])
    await quietly(async () => {
      await gateway!.processChatMessage('first question')
      await gateway!.processChatMessage('second question')
    })

    expect(calls.length).toBeGreaterThanOrEqual(2)
    const [first, second] = calls
    // Nothing was activated, so the cached prefix must not move at all.
    expect(second.toolBlock).toBe(first.toolBlock)
    expect(second.tools).toEqual(first.tools)
    expect(catalogOf(second.systemPrompt)).toBe(catalogOf(first.systemPrompt))
    expect(catalogOf(first.systemPrompt)).toContain('## Deferred Tools')
  })

  test('a tool activated in one turn stays advertised, and only grows the set', async () => {
    const calls = await startGateway([
      buildToolUseResponse([{ name: 'read_guide', arguments: { tool: 'publish' } }]),
      buildTextResponse('first answer'),
      buildTextResponse('second answer'),
    ])
    await quietly(async () => {
      await gateway!.processChatMessage('publish the app')
      await gateway!.processChatMessage('and now something else')
    })

    expect(calls.length).toBe(3)
    // Turn 1: deferred → read_guide → advertised.
    expect(calls[0].tools).not.toContain('publish')
    expect(calls[1].tools).toContain('publish')
    // Turn 2 keeps it: an activation is not undone at a turn boundary.
    expect(calls[2].tools).toContain('publish')
    // …and it is exactly the turn-1 post-activation set, with nothing dropped.
    expect(calls[2].tools).toEqual(calls[1].tools)
    for (const name of calls[0].tools) expect(calls[2].tools).toContain(name)
  })
})
