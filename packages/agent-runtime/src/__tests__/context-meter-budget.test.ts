// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-168 — the context meter measures a session against the budget it is
 * summarized at, not the model's max window.
 *
 * On a 1M-window model (haiku-5-5) the ring used to read "18% · 180k / 1M"
 * while the session was ~90% of the way to summarization, because
 * `autocompactThreshold` caps at AGENT_AUTOCOMPACT_TOKENS (now 235k). These tests
 * drive a real `AgentGateway.agentTurn` and read the frames the client
 * actually renders, so the denominator is proven where it is produced.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Message } from '@mariozechner/pi-ai'
import { AgentGateway } from '../gateway'
import { DEFAULT_AUTOCOMPACT_TOKENS } from '../session-manager'
import { createMockStreamFn, buildTextResponse } from './helpers/mock-anthropic'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const ROOT = join(tmpdir(), 'qa-sho168')

/** The reserve `resolveAutoCompactTokens` subtracts from a model's window. */
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
  writeFileSync(join(ws, 'AGENTS.md'), '# Identity\ncontext meter budget\n')
  writeFileSync(join(ws, 'MEMORY.md'), '# Memory\n- nothing yet\n')
  return ws
}

interface MeterTurn {
  frames: any[]
  usage: any
  /** `sessionManager.autocompactThreshold` after the turn. */
  threshold: number
  /** `sessionManager.contextWindowTokens` after the turn (the model window). */
  modelWindow: number
}

/**
 * One real turn through `agentTurn`. `seedChars` pre-fills the session with
 * plain user messages so the turn starts with a known context size.
 */
async function runMeterTurn(opts: {
  name: string
  model?: string
  seedMessages?: number
  seedChars?: number
}): Promise<MeterTurn> {
  const ws = makeWs(opts.name, opts.model ?? 'claude-haiku-5-5')
  trustWorkspaceForTests(ws)
  const gw = new AgentGateway(ws, `p-${opts.name}`)
  gw.setStreamFn(createMockStreamFn([buildTextResponse('ok')]))
  await gw.start()
  const sm = gw.getSessionManager()
  try {
    if (opts.seedChars) {
      sm.getOrCreate('sess-meter')
      const seeds: Message[] = []
      for (let i = 0; i < (opts.seedMessages ?? 1); i++) {
        seeds.push({ role: 'user', content: 'x'.repeat(opts.seedChars), timestamp: 1 } as any)
      }
      sm.addMessages('sess-meter', ...seeds)
    }
    const frames: any[] = []
    await (gw as any).agentTurn('hello', 'sess-meter', false, undefined, {
      write: (chunk: any) => frames.push(chunk),
    })
    return {
      frames,
      usage: gw.consumeLastTurnUsage(),
      threshold: sm.autocompactThreshold,
      modelWindow: sm.contextWindowTokens,
    }
  } finally {
    clearTrustForTests()
    try { await gw.stop() } catch {}
  }
}

const framesOf = (frames: any[], type: string) => frames.filter((f) => f.type === type)

beforeAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})
beforeEach(() => { delete process.env.AGENT_AUTOCOMPACT_TOKENS })
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

describe('SHO-168 context meter denominator', () => {
  test('AC1: a 1M-window model reports the 235k summarize budget everywhere', async () => {
    const r = await runMeterTurn({ name: 'ac1' })
    expect(r.modelWindow).toBe(1_000_000)
    expect(r.threshold).toBe(DEFAULT_AUTOCOMPACT_TOKENS)

    const usageFrames = framesOf(r.frames, 'data-context-usage')
    expect(usageFrames.length).toBeGreaterThan(0)
    for (const f of usageFrames) expect(f.data.contextWindowTokens).toBe(DEFAULT_AUTOCOMPACT_TOKENS)

    // The final `data-usage` frame is what the chat panel persists, and what a
    // reload repaints from.
    expect(r.usage.contextWindowTokens).toBe(DEFAULT_AUTOCOMPACT_TOKENS)
    expect(r.usage.modelContextWindowTokens).toBe(1_000_000)
  }, 60_000)

  test('AC2: AGENT_AUTOCOMPACT_TOKENS moves the meter with the summarize point', async () => {
    process.env.AGENT_AUTOCOMPACT_TOKENS = '120000'
    const r = await runMeterTurn({ name: 'ac2' })
    expect(r.threshold).toBe(120_000)

    const usageFrames = framesOf(r.frames, 'data-context-usage')
    expect(usageFrames.length).toBeGreaterThan(0)
    for (const f of usageFrames) expect(f.data.contextWindowTokens).toBe(120_000)
    expect(r.usage.contextWindowTokens).toBe(120_000)
    expect(r.usage.modelContextWindowTokens).toBe(1_000_000)

    // ...and 120k is not a copy of the model window, it came from the env.
    delete process.env.AGENT_AUTOCOMPACT_TOKENS
    const back = await runMeterTurn({ name: 'ac2-default' })
    expect(back.usage.contextWindowTokens).toBe(DEFAULT_AUTOCOMPACT_TOKENS)
  }, 90_000)

  test('AC3: a window below the cap meters window − reserve', async () => {
    // claude-sonnet-5 carries no catalog window, so the runtime assumes 200k,
    // which minus the output/buffer reserve is under the 200k cap.
    const r = await runMeterTurn({ name: 'ac3', model: 'claude-sonnet-5' })
    expect(r.modelWindow).toBe(200_000)
    expect(r.threshold).toBe(200_000 - RESERVE)

    const usageFrames = framesOf(r.frames, 'data-context-usage')
    expect(usageFrames.length).toBeGreaterThan(0)
    for (const f of usageFrames) expect(f.data.contextWindowTokens).toBe(200_000 - RESERVE)
    expect(r.usage.contextWindowTokens).toBe(200_000 - RESERVE)
    expect(r.usage.modelContextWindowTokens).toBe(200_000)
  }, 60_000)

  test('AC4: a session at the summarize threshold renders ~100% in the ring', async () => {
    // ~215k of the 235k budget: the pre-fix ring read 19% against the 1M
    // window while a compaction was one tool call away.
    const r = await runMeterTurn({ name: 'ac4', seedMessages: 2, seedChars: 430_000 })
    const first = framesOf(r.frames, 'data-context-usage')[0]
    expect(first.data.contextWindowTokens).toBe(DEFAULT_AUTOCOMPACT_TOKENS)

    // The same arithmetic ContextTracker does.
    const ringPct = Math.min((first.data.inputTokens / first.data.contextWindowTokens) * 100, 100)
    expect(ringPct).toBeGreaterThan(90)
    expect(ringPct).toBeLessThanOrEqual(100)

    // Against the model's window the very same frame would have read ~19%.
    const windowsPct = (first.data.inputTokens / r.modelWindow) * 100
    expect(windowsPct).toBeLessThan(30)
  }, 60_000)
})
