// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-168 acceptance (QA gate) — the context meter measures a session against
 * the summarize budget, not the model's catalog window.
 *
 * Complement to the dev's `context-meter-budget.test.ts`: that one reads the
 * turn-start frames of a short turn. This one drives turns that actually
 * compact mid-turn, so the `data-context-summarized` divisor is proven too —
 * a session whose ring just dropped has to be measured against the same
 * budget the compaction fired at.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AgentGateway } from '../gateway'
import { DEFAULT_AUTOCOMPACT_TOKENS } from '../session-manager'
import { createMockStreamFn, buildTextResponse, buildToolUseResponse } from './helpers/mock-anthropic'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const ROOT = join(tmpdir(), 'qa-sho168-acceptance')
const RESERVE = 16_384 + 15_000

function makeWs(name: string, model: string): string {
  const ws = join(ROOT, name)
  if (existsSync(ws)) rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  mkdirSync(join(ws, 'memory'), { recursive: true })
  mkdirSync(join(ws, 'skills'), { recursive: true })
  writeFileSync(join(ws, 'config.json'), JSON.stringify({
    heartbeatInterval: 1800,
    heartbeatEnabled: false,
    quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
    channels: [],
    model: { provider: 'anthropic', name: model },
  }))
  writeFileSync(join(ws, 'AGENTS.md'), '# Identity\ncontext meter acceptance\n')
  writeFileSync(join(ws, 'MEMORY.md'), '# Memory\n- nothing yet\n')
  return ws
}

interface MeteredTurn {
  frames: any[]
  compactionFrames: any[]
  usageFrames: any[]
  usage: any
  threshold: number
  modelWindow: number
}

/**
 * A turn long enough to compact mid-turn: every tool result is 30k chars, so
 * the compactor fires as soon as the session crosses the threshold.
 */
async function runCompactingTurn(opts: { name: string; model?: string; toolCalls?: number }): Promise<MeteredTurn> {
  const ws = makeWs(opts.name, opts.model ?? 'claude-haiku-5-5')
  trustWorkspaceForTests(ws)
  const gw = new AgentGateway(ws, `p-${opts.name}`)
  const body = 'x'.repeat(30_000)
  gw.setToolMocks({ read_file: () => body })
  const responses = Array.from({ length: opts.toolCalls ?? 40 }, (_, i) =>
    buildToolUseResponse([{ name: 'read_file', arguments: { path: `f-${i}.txt` }, id: `toolu_${i}` }]),
  )
  responses.push(buildTextResponse('all files read'))
  gw.setStreamFn(createMockStreamFn(responses))
  await gw.start()
  const sm = gw.getSessionManager()
  const frames: any[] = []
  try {
    await (gw as any).agentTurn('read every file', 'sess-qa168', false, undefined, {
      write: (chunk: any) => frames.push(chunk),
    })
    return {
      frames,
      compactionFrames: frames.filter((f) => f.type === 'data-context-summarized'),
      usageFrames: frames.filter((f) => f.type === 'data-context-usage'),
      usage: gw.consumeLastTurnUsage(),
      threshold: sm.autocompactThreshold,
      modelWindow: sm.contextWindowTokens,
    }
  } finally {
    clearTrustForTests()
    try { await gw.stop() } catch {}
  }
}

beforeAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})
beforeEach(() => { delete process.env.AGENT_AUTOCOMPACT_TOKENS })
afterAll(() => {
  delete process.env.AGENT_AUTOCOMPACT_TOKENS
  rmSync(ROOT, { recursive: true, force: true })
})

describe('SHO-168 acceptance: summarize budget is the meter denominator', () => {
  test('AC1: a 1M-window turn that compacts reports 200k in every frame', async () => {
    const r = await runCompactingTurn({ name: 'ac1' })
    expect(r.modelWindow).toBe(1_000_000)
    expect(r.threshold).toBe(DEFAULT_AUTOCOMPACT_TOKENS)
    expect(r.compactionFrames.length).toBeGreaterThanOrEqual(1)

    for (const f of r.compactionFrames) expect(f.data.contextWindowTokens).toBe(DEFAULT_AUTOCOMPACT_TOKENS)
    expect(r.usageFrames.length).toBeGreaterThan(1)
    for (const f of r.usageFrames) expect(f.data.contextWindowTokens).toBe(DEFAULT_AUTOCOMPACT_TOKENS)

    expect(r.usage.contextWindowTokens).toBe(DEFAULT_AUTOCOMPACT_TOKENS)
    expect(r.usage.modelContextWindowTokens).toBe(1_000_000)
  }, 120_000)

  test('AC2: AGENT_AUTOCOMPACT_TOKENS moves every denominator with the summarize point', async () => {
    process.env.AGENT_AUTOCOMPACT_TOKENS = '120000'
    const r = await runCompactingTurn({ name: 'ac2' })
    expect(r.threshold).toBe(120_000)
    expect(r.compactionFrames.length).toBeGreaterThanOrEqual(1)

    for (const f of r.compactionFrames) expect(f.data.contextWindowTokens).toBe(120_000)
    for (const f of r.usageFrames) expect(f.data.contextWindowTokens).toBe(120_000)
    expect(r.usage.contextWindowTokens).toBe(120_000)
    // The model window is still carried, and is not what the meter divides by.
    expect(r.usage.modelContextWindowTokens).toBe(1_000_000)
  }, 120_000)

  test('AC3: a window below the cap meters window − reserve', async () => {
    const r = await runCompactingTurn({ name: 'ac3', model: 'claude-sonnet-5' })
    expect(r.modelWindow).toBe(200_000)
    expect(r.threshold).toBe(200_000 - RESERVE)
    expect(r.compactionFrames.length).toBeGreaterThanOrEqual(1)

    for (const f of r.compactionFrames) expect(f.data.contextWindowTokens).toBe(200_000 - RESERVE)
    for (const f of r.usageFrames) expect(f.data.contextWindowTokens).toBe(200_000 - RESERVE)
    expect(r.usage.contextWindowTokens).toBe(200_000 - RESERVE)
  }, 120_000)
})
