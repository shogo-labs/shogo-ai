// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-381 acceptance — the compaction event must carry what prod needs to
 * explain a row: the prompt overhead the estimate included, and whether
 * variant B actually dropped tool results.
 *
 * Driven through a real `AgentGateway.agentTurn` and a real `runAgentLoop`, so
 * the `apply` callback, the event and the emitted frame are the production
 * ones. On `b6108e6a9` both fields were `undefined` on the frame.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Message } from '@mariozechner/pi-ai'
import { AgentGateway } from '../gateway'
import { createMockStreamFn, buildTextResponse, buildToolUseResponse } from './helpers/mock-anthropic'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const ROOT = join(tmpdir(), 'qa-sho381-event')

function makeWs(name: string): string {
  const ws = join(ROOT, name)
  if (existsSync(ws)) rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  mkdirSync(join(ws, 'memory'), { recursive: true })
  mkdirSync(join(ws, 'skills'), { recursive: true })
  writeFileSync(join(ws, 'config.json'), JSON.stringify({
    heartbeatInterval: 1800, heartbeatEnabled: false,
    quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
    channels: [], model: { provider: 'anthropic', name: 'claude-haiku-5-5' },
  }))
  writeFileSync(join(ws, 'AGENTS.md'), '# Identity\nSHO-381 event fields\n')
  writeFileSync(join(ws, 'MEMORY.md'), '# Memory\n- nothing yet\n')
  return ws
}

async function runTurn(opts: { name: string; toolCalls: number; charsPerResult: number }) {
  const ws = makeWs(opts.name)
  trustWorkspaceForTests(ws)
  const gw = new AgentGateway(ws, `p-${opts.name}`)
  const body = 'x'.repeat(opts.charsPerResult)
  gw.setToolMocks({ read_file: () => body })
  const responses = Array.from({ length: opts.toolCalls }, (_, i) =>
    buildToolUseResponse([{ name: 'read_file', arguments: { path: `f-${i}.txt` }, id: `toolu_${i}` }]),
  )
  responses.push(buildTextResponse('all files read'))
  const inner = createMockStreamFn(responses, (_i, messages: Message[]) => { JSON.stringify(messages) })
  gw.setStreamFn(inner as any)
  await gw.start()
  const frames: any[] = []
  try {
    await (gw as any).agentTurn('read every file', 'sess-qa381', false, undefined, {
      write: (chunk: any) => { frames.push(chunk) },
    })
    return { compactionFrames: frames.filter((f) => f.type === 'data-context-summarized') }
  } finally {
    clearTrustForTests()
    try { await gw.stop() } catch {}
  }
}

beforeAll(() => { if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true }); mkdirSync(ROOT, { recursive: true }) })
beforeEach(() => { delete process.env.AGENT_AUTOCOMPACT_TOKENS })
afterEach(() => { delete process.env.COMPACTION_VARIANT })
afterAll(() => { try { clearTrustForTests() } catch {}; rmSync(ROOT, { recursive: true, force: true }) })

describe('SHO-381 acceptance: the compaction event carries what prod needs', () => {
  test('a B1 mid-turn compaction that drops tool results emits droppedToolResults > 0', async () => {
    process.env.COMPACTION_VARIANT = 'B1'
    const r = await runTurn({ name: 'b1', toolCalls: 40, charsPerResult: 30_000 })
    expect(r.compactionFrames.length).toBeGreaterThanOrEqual(1)
    const dropped = r.compactionFrames.map((f) => f.data.droppedToolResults)
    expect(dropped.some((n) => typeof n === 'number' && n > 0)).toBe(true)
  }, 180_000)

  test('every compaction frame reports the prompt overhead the compactor used', async () => {
    const r = await runTurn({ name: 'overhead', toolCalls: 40, charsPerResult: 30_000 })
    expect(r.compactionFrames.length).toBeGreaterThanOrEqual(1)
    for (const f of r.compactionFrames) {
      expect(typeof f.data.promptOverheadTokens).toBe('number')
      expect(f.data.promptOverheadTokens).toBeGreaterThan(0)
      expect(f.data.promptOverheadTokens).toBeLessThan(f.data.tokensAfter)
    }
  }, 180_000)
})
