// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-78 (agent memory is uncapped and uncached).
 *
 * These are the card's acceptance criteria, exercised through the real insert
 * point rather than the helper alone:
 *   AC1  19 KB MEMORY.md → ≤ 1,500 tokens, `lastPromptBreakdown` zone 'stable'
 *   AC2  under-budget file → byte-identical section to pre-SHO-78 `main`
 *   AC3  content dropped from the prompt is still reachable by `memory_search`
 *   AC4  `memory_search` keeps its signature/description; no new agent tool
 *   AC5  a core block that alone exceeds the budget still never exceeds it
 *   AC6  Reflection's daily step consolidates and reports before → after tokens
 * plus a property sweep: whatever the file shape, `usedTokens <= budget` and
 * nothing is cut mid-word.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { AgentGateway } from '../gateway'
import { createTools, ALL_TOOL_NAMES, type ToolContext } from '../gateway-tools'
import {
  buildMemorySection,
  resolveMemoryBudgetTokens,
  MEMORY_BUDGET_TOKENS_DEFAULT,
  MEMORY_BUDGET_TOKENS_MAX,
  MEMORY_BUDGET_TOKENS_MIN,
  MEMORY_CORE_END,
  MEMORY_CORE_START,
  MEMORY_SECTION_HEADING,
} from '../memory-section'
import { getPackTemplate, renderPackYaml } from '../pack-templates'
import { createMockStreamFn, buildTextResponse } from './helpers/mock-anthropic'

const TEST_DIR = '/tmp/qa-sho78-acceptance'
const BOUNDARY = '<|CACHE_BOUNDARY|>'

// ── fixtures ───────────────────────────────────────────────────────────────

/**
 * ~19 KB in 9 `##` sections — the measured shape of a long-lived MEMORY.md:
 * nested `###` headings, fenced code, long prose lines and a unicode arrow.
 * The last section carries a sentinel so "newest wins" is observable.
 */
function largeMemory(): string {
  const out: string[] = ['# Memory', '', 'Durable facts about this agent.', '']
  for (let s = 1; s <= 9; s++) {
    out.push(`## Section ${s} — ${s === 9 ? 'newest lesson' : `archive ${s}`}`, '')
    out.push(`### Detail ${s}`)
    for (let l = 1; l <= 19; l++) {
      out.push(
        `- ${s}.${l} when a tool fails twice in a row, stop and report the blocker instead of retrying — measured ${s * l} ms ≈ budgeted`,
      )
      if (l === 4) out.push('  ```ts', `  const x${s} = ${s}`, '  ```')
    }
    if (s === 9) out.push('', 'NEWEST-SENTINEL-7c41: the freshest lesson must survive the budget.')
    out.push('')
  }
  return out.join('\n')
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

function toolCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: { channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' } },
    projectId: 'qa-sho78',
    ...overrides,
  } as ToolContext
}

/** The string `main` produced: `pushDynamic('memory', '## Memory\n' + file.trim())`. */
function mainSection(fileContents: string): string {
  return `${MEMORY_SECTION_HEADING}\n${fileContents.trim()}`
}

/** Split the injected block into body lines and the trailing overflow notice. */
function splitBodyAndNotice(content: string): { body: string[]; notice: string[] } {
  const lines = content.split('\n')
  const noticeStart = lines.findIndex((l) => l.startsWith('(MEMORY.md is '))
  if (noticeStart === -1) return { body: lines, notice: [] }
  return { body: lines.slice(0, noticeStart), notice: lines.slice(noticeStart) }
}

describe('QA acceptance — SHO-78 budgeted memory section', () => {
  let gateway: AgentGateway | undefined

  afterEach(async () => {
    if (gateway) await gateway.stop()
    gateway = undefined
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  async function boot(): Promise<AgentGateway> {
    gateway = new AgentGateway(TEST_DIR, 'qa-sho78')
    gateway.setStreamFn(createMockStreamFn([buildTextResponse('ok')]))
    await gateway.start()
    return gateway
  }

  function prompt(g: AgentGateway): string {
    return (g as unknown as { loadBootstrapContext: (s?: string) => string }).loadBootstrapContext()
  }

  // ── AC1 ──────────────────────────────────────────────────────────────────
  test('AC1: a ~19 KB MEMORY.md injects ≤ 1,500 tokens and is reported as stable', async () => {
    const memory = largeMemory()
    expect(Buffer.byteLength(memory)).toBeGreaterThan(15_000)
    setupWorkspace(memory)
    const g = await boot()

    const built = prompt(g)
    const memoryIndex = (g.lastPromptBreakdown ?? []).find((s) => s.label === 'memory')

    expect(memoryIndex).toBeDefined()
    expect(memoryIndex!.zone).toBe('stable')
    expect(memoryIndex!.estTokens).toBeLessThanOrEqual(MEMORY_BUDGET_TOKENS_DEFAULT)

    // The whole point of the change: it now sits in the cached prefix…
    const boundaryAt = built.indexOf(BOUNDARY)
    expect(boundaryAt).toBeGreaterThan(-1)
    expect(built.slice(0, boundaryAt)).toContain('NEWEST-SENTINEL-7c41')
    // …and the oldest section's body is out of the prompt, named in the notice.
    expect(built.slice(0, boundaryAt)).toContain('Not loaded:')
    expect(built.slice(0, boundaryAt)).not.toContain('1.1 when a tool fails twice')
    expect(memoryIndex!.chars).toBeLessThanOrEqual(MEMORY_BUDGET_TOKENS_DEFAULT * 4)
  })

  // ── AC2 ──────────────────────────────────────────────────────────────────
  test('AC2: a file under budget is byte-identical to what main emitted', async () => {
    const cases = [
      '# Memory\n\n## User\n- Prefers window seats\n- Lives in Honolulu\n\n## Stack\n- Bun, Hono, Prisma\n',
      '# Memory\n\n## One\nsingle section, no trailing newline',
      '# Memory\r\n\r\n## CRLF\r\n- a\r\n- b\r\n',
      '# Memory\n\n## Only\n- x\n\n\n',
    ]
    const budget = resolveMemoryBudgetTokens({ MEMORY_BUDGET_TOKENS: undefined } as NodeJS.ProcessEnv)

    for (const markdown of cases) {
      const section = buildMemorySection({ markdown, budgetTokens: budget })
      expect(section.content).toBe(mainSection(markdown))
      expect(section.truncated).toBe(false)
      expect(section.usedTokens).toBeLessThanOrEqual(budget)
    }

    // …and through the gateway, byte-for-byte against the old construction.
    const markdown = cases[0]
    setupWorkspace(markdown)
    const g = await boot()
    expect(prompt(g)).toContain(mainSection(markdown))
    expect(prompt(g)).not.toContain('Not loaded:')
  })

  // ── AC3 ──────────────────────────────────────────────────────────────────
  test('AC3: a section dropped from the prompt is still reachable through memory_search', async () => {
    const memory = largeMemory().replace('- 1.19 when a tool fails twice', '- 1.19 quebrith-sentinel when a tool fails twice')
    setupWorkspace(memory)

    const section = buildMemorySection({ markdown: readFileSync(join(TEST_DIR, 'MEMORY.md'), 'utf-8') })
    // The oldest section really is out of the block…
    expect(section.droppedSections.map((d) => d.heading)).toContain('## Section 1 — archive 1')
    expect(section.content).not.toContain('quebrith-sentinel')

    // …and the shipped `memory_search` tool still finds it on disk.
    const tool = createTools(toolCtx()).find((t) => t.name === 'memory_search')
    expect(tool).toBeDefined()
    const result = await tool!.execute('qa-ac3', { query: 'quebrith sentinel', limit: 20 })
    const details = result.details as { results?: Array<{ file: string; content: string }>; totalMatches?: number }

    expect(details.totalMatches).toBeGreaterThan(0)
    expect((details.results ?? []).some((r) => r.file === 'MEMORY.md' && r.content.includes('quebrith'))).toBe(true)
  })

  // ── AC4 ──────────────────────────────────────────────────────────────────
  test('AC4: memory_search keeps its signature and no new agent tool was added', () => {
    const tool = createTools(toolCtx()).find((t) => t.name === 'memory_search')
    expect(tool).toBeDefined()
    expect(tool!.description).toBe(
      'Search across all agent memory (MEMORY.md and daily logs) using hybrid keyword + semantic matching. ' +
        'Returns the most relevant memory chunks ranked by relevance.',
    )
    const params = tool!.parameters as unknown as { properties?: Record<string, unknown> }
    expect(Object.keys(params.properties ?? {}).sort()).toEqual(['limit', 'query'])

    const memoryish = ALL_TOOL_NAMES.filter((n) => /memory/i.test(n)).sort()
    expect(memoryish).toEqual(['memory_read', 'memory_search'])
  })

  // ── AC5 ──────────────────────────────────────────────────────────────────
  test('AC5: a core block that alone exceeds the budget is cut to the budget', () => {
    const body = Array.from({ length: 400 }, (_, i) => `core line ${i} ${'x'.repeat(80)}`).join('\n')
    const markdown = [
      '# Memory',
      '',
      'archive before',
      '',
      MEMORY_CORE_START,
      body,
      MEMORY_CORE_END,
      '',
      '## Archive',
      '- not injected',
    ].join('\n')

    for (const budget of [MEMORY_BUDGET_TOKENS_MIN, 600, MEMORY_BUDGET_TOKENS_DEFAULT, MEMORY_BUDGET_TOKENS_MAX]) {
      const section = buildMemorySection({ markdown, budgetTokens: budget })
      expect(section.truncated).toBe(true)
      expect(section.usedTokens).toBeLessThanOrEqual(budget)
      expect(section.content.length).toBeLessThanOrEqual(budget * 4)
      expect(section.content).toContain(MEMORY_SECTION_HEADING)
      expect(section.content).not.toContain('not injected')
      // cut at a line boundary, never mid-line
      const { body: lines } = splitBodyAndNotice(section.content)
      const source = new Set(markdown.split('\n'))
      for (const line of lines.slice(1, -1)) {
        if (line.trim().length > 20) expect(source.has(line)).toBe(true)
      }
    }
  })

  // ── AC6 ──────────────────────────────────────────────────────────────────
  test('AC6: the Reflection pack consolidates and reports before → after tokens, and pack.yaml is in sync', () => {
    const pack = getPackTemplate('self-evolving')
    expect(pack).not.toBeNull()
    const prompt = JSON.stringify(pack)

    // The daily step is a consolidation pass, not an append of six bullets.
    expect(prompt).toContain('Consolidate')
    expect(prompt).toContain('do not append to it')
    expect(prompt).not.toContain('write at most six bullets')
    // …it must not tell the coach to append forever, and must name the flat layout.
    expect(prompt).toContain('memory/<slug>.md')
    expect(prompt).toContain('memory/topics/')
    expect(prompt).toContain(MEMORY_CORE_START)
    // …and it must ask for the per-agent before → after line in the review.
    expect(prompt).toContain('tokens')

    // The committed pack.yaml is the regenerated output, not a stale copy.
    const onDisk = readFileSync(
      join(import.meta.dir, '..', '..', 'templates', 'packs', 'self-evolving', 'pack.yaml'),
      'utf-8',
    )
    expect(onDisk).toBe(renderPackYaml('self-evolving'))
  })

  // ── property sweep ───────────────────────────────────────────────────────
  test('property: any file shape stays within budget and is never cut mid-word', () => {
    // Deterministic LCG so a failure reproduces.
    let seed = 20261020
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const word = () => 'abcdefghij'.slice(0, 2 + Math.floor(rnd() * 8))
    const sentence = () => Array.from({ length: 3 + Math.floor(rnd() * 14) }, word).join(' ')

    const shapes: string[] = [
      '',
      '   \n\n  ',
      'one long paragraph with no headings at all, '.repeat(400),
      '## only a heading\n',
      `## A\n${'no newline in this section at all '.repeat(300)}`,
      `${MEMORY_CORE_START}\ncore only\n${MEMORY_CORE_END}`,
      `${MEMORY_CORE_START}\n${'core line with words inside it\n'.repeat(900)}${MEMORY_CORE_END}`,
    ]
    for (let i = 0; i < 200; i++) {
      const parts: string[] = [rnd() > 0.5 ? `# Memory\n\n${sentence()}` : '']
      const sections = Math.floor(rnd() * 8)
      for (let s = 0; s < sections; s++) {
        parts.push(`## ${sentence()}`, '')
        const lines = 1 + Math.floor(rnd() * 25)
        for (let l = 0; l < lines; l++) parts.push(rnd() > 0.85 ? `- ${sentence()} ${'y'.repeat(Math.floor(rnd() * 200))}` : `- ${sentence()}`)
      }
      shapes.push(parts.join('\n'))
    }

    for (const markdown of shapes) {
      for (const budget of [MEMORY_BUDGET_TOKENS_MIN, 700, MEMORY_BUDGET_TOKENS_DEFAULT, MEMORY_BUDGET_TOKENS_MAX]) {
        const section = buildMemorySection({ markdown, budgetTokens: budget })
        expect(section.usedTokens).toBeLessThanOrEqual(budget)
        expect(section.content.length).toBeLessThanOrEqual(budget * 4)

        const { body } = splitBodyAndNotice(section.content)
        const sourceLines = markdown.split(/\r?\n/)
        // The last non-empty body line is the only one that may be a cut (a
        // headingless file is one paragraph, so it is cut at a word boundary);
        // every other line must be a whole line of the source.
        const lastKept = body.reduce((acc, l, i) => (l.trim().length > 0 ? i : acc), 0)
        for (let i = 1; i < body.length; i++) {
          const line = body[i]
          if (line.trim().length <= 40) continue
          if (sourceLines.includes(line)) continue
          expect(i).toBe(lastKept)
          expect(markdown.includes(`${line} `) || markdown.includes(`${line},`)).toBe(true)
        }
      }
    }
  })

  test('budget env var: default 1500, clamped, and the section honours it', () => {
    expect(resolveMemoryBudgetTokens({} as NodeJS.ProcessEnv)).toBe(MEMORY_BUDGET_TOKENS_DEFAULT)
    expect(resolveMemoryBudgetTokens({ MEMORY_BUDGET_TOKENS: '10' } as NodeJS.ProcessEnv)).toBe(MEMORY_BUDGET_TOKENS_MIN)
    expect(resolveMemoryBudgetTokens({ MEMORY_BUDGET_TOKENS: '99999' } as NodeJS.ProcessEnv)).toBe(MEMORY_BUDGET_TOKENS_MAX)
    expect(resolveMemoryBudgetTokens({ MEMORY_BUDGET_TOKENS: 'nope' } as NodeJS.ProcessEnv)).toBe(MEMORY_BUDGET_TOKENS_DEFAULT)
    expect(resolveMemoryBudgetTokens({ MEMORY_BUDGET_TOKENS: '900' } as NodeJS.ProcessEnv)).toBe(900)

    const section = buildMemorySection({ markdown: largeMemory(), budgetTokens: 400 })
    expect(section.usedTokens).toBeLessThanOrEqual(400)
    expect(section.truncated).toBe(true)
  })

  test('sanity: the fixture is the size the card measured, and the file on disk is untouched', () => {
    const memory = largeMemory()
    setupWorkspace(memory)
    const before = statSync(join(TEST_DIR, 'MEMORY.md')).size

    buildMemorySection({ markdown: readFileSync(join(TEST_DIR, 'MEMORY.md'), 'utf-8') })

    expect(statSync(join(TEST_DIR, 'MEMORY.md')).size).toBe(before)
    expect(Buffer.byteLength(memory)).toBeGreaterThan(15_000)
  })
})
