// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Gateway-level tests for the budgeted `## Memory` block (SHO-78):
 *   - it lands in the STABLE zone, before `<|CACHE_BOUNDARY|>`, so it joins the
 *     cached prefix instead of being re-billed on every request;
 *   - `lastPromptBreakdown` reports it with `zone: 'stable'` and
 *     `estTokens <= budget` (the production before/after metric);
 *   - the built section is snapshotted per `mtimeMs:size`, so a turn reuses it;
 *   - a file under budget still produces the byte-identical section.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { AgentGateway } from '../gateway'
import { createMockStreamFn, buildTextResponse } from './helpers/mock-anthropic'

const TEST_DIR = '/tmp/test-memory-prompt-budget'
const BOUNDARY = '<|CACHE_BOUNDARY|>'
const MARKER = 'MARKER-NEWEST-LESSON-9c3f'

/** ~19 KB / ~4.7k tokens in 10 `##` sections, the measured QA-workspace shape. */
function largeMemory(): string {
  const lines = ['# Memory', '', 'Durable facts about this agent.']
  for (let s = 1; s <= 10; s++) {
    lines.push('', `## Topic ${s} — section ${s} of the archive`)
    for (let l = 1; l <= 14; l++) {
      const suffix = s === 10 && l === 14 ? ` ${MARKER}` : ''
      lines.push(
        `${s}.${l} - when a tool fails twice, stop and report the blocker instead of retrying the same call with a third variation${suffix}`,
      )
    }
  }
  return lines.join('\n')
}

function setupWorkspace(memory: string | null): void {
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
  writeFileSync(
    join(TEST_DIR, 'AGENTS.md'),
    '# Identity\nTest Agent\n\n# Personality\nBe helpful.\n\n# User\nTest User\n\n# Operating Instructions\nYou are a test agent.',
  )
  if (memory !== null) writeFileSync(join(TEST_DIR, 'MEMORY.md'), memory, 'utf-8')
}

describe('budgeted memory prompt section', () => {
  let gateway: AgentGateway | undefined

  afterEach(async () => {
    if (gateway) await gateway.stop()
    gateway = undefined
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  async function boot(): Promise<AgentGateway> {
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(createMockStreamFn([buildTextResponse('ok')]))
    await gateway.start()
    return gateway
  }

  function buildPrompt(g: AgentGateway): string {
    return (g as unknown as { loadBootstrapContext: (s?: string) => string }).loadBootstrapContext()
  }

  test('a 19 KB MEMORY.md is budgeted into the stable zone', async () => {
    setupWorkspace(largeMemory())
    const g = await boot()

    const prompt = buildPrompt(g)

    // (i) before the cache boundary — the whole point of moving it out of the dynamic zone
    const markerAt = prompt.indexOf(MARKER)
    const boundaryAt = prompt.indexOf(BOUNDARY)
    expect(markerAt).toBeGreaterThan(-1)
    expect(boundaryAt).toBeGreaterThan(-1)
    expect(markerAt).toBeLessThan(boundaryAt)

    // (ii) reported as stable, inside the budget
    const memory = (g.lastPromptBreakdown ?? []).find((s) => s.label === 'memory')
    expect(memory).toBeDefined()
    expect(memory!.zone).toBe('stable')
    expect(memory!.estTokens).toBeLessThanOrEqual(1500)

    // The oldest section's body is out of the prompt. Its heading may still be
    // named in the overflow notice — that is the pointer to memory_search.
    expect(prompt.slice(0, boundaryAt)).not.toContain('1.1 - when a tool fails twice')
    expect(prompt.slice(0, boundaryAt)).toContain('Not loaded:')
  })

  test('an unchanged file reuses the cached section instead of rebuilding it', async () => {
    setupWorkspace(largeMemory())
    const g = await boot()

    buildPrompt(g)
    const cached = (g as unknown as { memorySectionCache: { key: string; content: string } | null }).memorySectionCache
    expect(cached).not.toBeNull()

    buildPrompt(g)
    const again = (g as unknown as { memorySectionCache: { key: string; content: string } | null }).memorySectionCache

    // Same object reference = the section was not rebuilt for the second turn.
    expect(again).toBe(cached!)
    expect(again!.content).toBe(cached!.content)
  })

  test('a changed file is rebuilt once, on the change', async () => {
    setupWorkspace(largeMemory())
    const g = await boot()

    buildPrompt(g)
    const before = (g as unknown as { memorySectionCache: { key: string; content: string } | null }).memorySectionCache

    const changed = largeMemory().replace(MARKER, 'MARKER-REWRITTEN-4a1b')
    writeFileSync(join(TEST_DIR, 'MEMORY.md'), changed, 'utf-8')
    const future = new Date(statSync(join(TEST_DIR, 'MEMORY.md')).mtimeMs + 5_000)
    utimesSync(join(TEST_DIR, 'MEMORY.md'), future, future)

    const prompt = buildPrompt(g)
    const after = (g as unknown as { memorySectionCache: { key: string; content: string } | null }).memorySectionCache

    expect(after).not.toBe(before!)
    expect(after!.key).not.toBe(before!.key)
    expect(prompt).toContain('MARKER-REWRITTEN-4a1b')
  })

  test('a file under budget produces the byte-identical section', async () => {
    const markdown = [
      '# Memory',
      '',
      '## User',
      '- Prefers window seats',
      '- Lives in Honolulu',
      '',
      '## Stack',
      '- Bun, Hono, Prisma',
    ].join('\n')
    setupWorkspace(markdown)
    const g = await boot()

    const prompt = buildPrompt(g)

    // Exactly what `pushDynamic('memory', `## Memory\n${memory}`)` emitted before this change.
    expect(prompt).toContain(`## Memory\n${markdown.trim()}`)
    expect(prompt).not.toContain('Not loaded:')
    expect((g.lastPromptBreakdown ?? []).find((s) => s.label === 'memory')!.zone).toBe('stable')
  })

  test('no MEMORY.md means no memory section, as before', async () => {
    setupWorkspace(null)
    const g = await boot()

    buildPrompt(g)

    expect((g.lastPromptBreakdown ?? []).find((s) => s.label === 'memory')).toBeUndefined()
  })
})
