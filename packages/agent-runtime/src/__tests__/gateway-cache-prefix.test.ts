// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Prompt-cache prefix plumbing (SHO-82).
 *
 * The cache-efficiency eval suite measures ratios, which only mean something
 * while the cached zone holds still. These tests pin the plumbing underneath
 * it: `data-usage.prefix` is built from the same bytes the model is sent, the
 * stable zone survives a per-turn (viewer) change while the dynamic zone moves,
 * and the no-LLM probe used by the suite's structural tests agrees.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { AgentGateway } from '../gateway'
import { fingerprintSystem } from '../prefix-fingerprint'
import { createMockStreamFn, buildTextResponse, buildToolUseResponse } from './helpers/mock-anthropic'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const ROOT = '/tmp/test-gw-cache-prefix'

function makeWs(name: string): string {
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
    model: { provider: 'custom', name: 'hoshi-2-0' },
  }))
  writeFileSync(join(ws, 'AGENTS.md'), '# Identity\ncache prefix test\n')
  writeFileSync(join(ws, 'MEMORY.md'), '# Memory\n- nothing yet\n')
  return ws
}

beforeAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})
afterAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
})

describe('prompt-cache prefix probe', () => {
  test('two builds inside one session are byte-identical in the cached zone', async () => {
    const gw = new AgentGateway(makeWs('stable'), 'p-cache-1')
    const probe = await gw.sampleCachePrefix('chat')
    expect(probe.sessionId).toBe('chat')
    expect(probe.builds).toHaveLength(2)
    expect(probe.drift).toBeNull()
    expect(probe.identical).toBe(true)
    expect(probe.builds[0].stableHash).toBe(probe.builds[1].stableHash)
    // The cached zone must actually be the bulk of the prompt, otherwise there
    // is nothing to cache and every ratio test would be measuring noise.
    expect(probe.builds[0].stableChars).toBeGreaterThan(2_000)
  })

  test('the tool block is hashed and non-empty', async () => {
    const gw = new AgentGateway(makeWs('tools'), 'p-cache-2')
    const probe = await gw.sampleCachePrefix('chat')
    expect(probe.builds[0].toolsHash).not.toBe('------')
    expect(probe.builds[0].toolCount).toBeGreaterThan(0)
    // Rebuilt from scratch on every probe, so two probes must agree.
    const again = await gw.sampleCachePrefix('chat')
    expect(again.builds[0].toolsHash).toBe(probe.builds[0].toolsHash)
  })

  test('a per-turn change moves the dynamic zone and leaves the stable zone alone', async () => {
    const gw = new AgentGateway(makeWs('dynamic'), 'p-cache-3')
    gw.setViewerContext({ formFactor: 'desktop', platform: 'mac', width: 1440 })
    const before = await gw.sampleCachePrefix('chat')
    gw.setViewerContext({ formFactor: 'phone', platform: 'ios', width: 390 })
    const after = await gw.sampleCachePrefix('chat')

    expect(after.builds[0].stableHash).toBe(before.builds[0].stableHash)
    expect(after.builds[0].stableChars).toBe(before.builds[0].stableChars)
    expect(after.builds[0].dynamicHash).not.toBe(before.builds[0].dynamicHash)
  })

  test('the boundary marker lives in the built prompt, not in the cached zone', async () => {
    const gw = new AgentGateway(makeWs('marker'), 'p-cache-4')
    const system = (gw as any).loadBootstrapContext('chat') as string
    const marker = '\n\n<|CACHE_BOUNDARY|>\n\n'
    const idx = system.indexOf(marker)
    expect(idx).toBeGreaterThan(0)
    expect(system.slice(idx + marker.length).trim().length).toBeGreaterThan(0)
    // Prefix hashing splits on exactly this marker, so the two views agree.
    const print = fingerprintSystem(system)
    expect(print.stableChars + print.dynamicChars + marker.length).toBe(system.length)
  })
})

describe('data-usage carries the prefix and the per-call breakdown', () => {
  test('two turns report a stable cached zone, a moving dynamic zone, and per-call usage that sums to the turn', async () => {
    const ws = makeWs('turns')
    trustWorkspaceForTests(ws)
    const gw = new AgentGateway(ws, 'p-cache-turns')
    // Mocked so the turn exercises the loop, not the permission engine's path
    // resolution (a real read_file here logs a refusal it does not assert on).
    gw.setToolMocks({ read_file: () => 'mocked memory contents' })
    gw.setStreamFn(createMockStreamFn([
      // Turn 1, call 1: writes the whole prefix.
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'MEMORY.md' }, id: 't1' }], {
        input: 150, output: 20, cacheRead: 0, cacheWrite: 9_000,
      }),
      // Turn 1, call 2: reads everything back.
      buildTextResponse('first turn done', { input: 50, output: 30, cacheRead: 9_040, cacheWrite: 0 }),
    ]))
    await gw.start()
    try {
      gw.setViewerContext({ formFactor: 'desktop', platform: 'mac', width: 1440 })
      await (gw as any).agentTurn('read the memory file', 'sess-cache', false)
      const turn1 = gw.consumeLastTurnUsage()
      expect(turn1).toBeTruthy()
      expect(turn1!.prefix.turn).toBe(1)
      expect(turn1!.prefix.stableHash).not.toBe('------')
      expect(turn1!.prefix.stableChars).toBeGreaterThan(2_000)
      expect(turn1!.prefix.toolCount).toBeGreaterThan(0)
      // One entry per model call, in order, and they add up to the turn.
      expect(turn1!.perCallUsage).toHaveLength(2)
      expect(turn1!.perCallUsage.map(c => c.iteration)).toEqual([1, 2])
      const summed = turn1!.perCallUsage.reduce(
        (acc, c) => ({
          input: acc.input + c.input,
          output: acc.output + c.output,
          cacheRead: acc.cacheRead + c.cacheRead,
          cacheWrite: acc.cacheWrite + c.cacheWrite,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      )
      expect(summed).toEqual({
        input: turn1!.inputTokens,
        output: turn1!.outputTokens,
        cacheRead: turn1!.cacheReadTokens,
        cacheWrite: turn1!.cacheWriteTokens,
      })
      expect(turn1!.cacheReadTokens).toBe(9_040)
      expect(turn1!.cacheWriteTokens).toBe(9_000)

      // Turn 2: only the viewer hint changes — a per-turn section. The cached
      // zone must not move, or every turn after it pays for a rewrite.
      gw.setStreamFn(createMockStreamFn([
        buildTextResponse('second turn done', { input: 10, output: 5, cacheRead: 9_100, cacheWrite: 0 }),
      ]))
      gw.setViewerContext({ formFactor: 'phone', platform: 'ios', width: 390 })
      await (gw as any).agentTurn('anything else?', 'sess-cache', false)
      const turn2 = gw.consumeLastTurnUsage()
      expect(turn2!.prefix.turn).toBe(2)
      expect(turn2!.prefix.stableHash).toBe(turn1!.prefix.stableHash)
      expect(turn2!.prefix.dynamicHash).not.toBe(turn1!.prefix.dynamicHash)
      expect(turn2!.prefix.toolsHash).toBe(turn1!.prefix.toolsHash)
      expect(turn2!.perCallUsage).toHaveLength(1)

      // The server spreads this object onto the `data-usage` frame verbatim, so
      // JSON round-tripping it is what the eval runner parses.
      const wire = JSON.parse(JSON.stringify(turn2))
      expect(wire.prefix.stableHash).toBe(turn1!.prefix.stableHash)
      expect(wire.perCallUsage[0].cacheRead).toBe(9_100)
    } finally {
      clearTrustForTests()
      try { await gw.stop() } catch {}
    }
  }, 60_000)
})
