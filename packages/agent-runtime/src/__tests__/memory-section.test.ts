// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `memory-section` (SHO-78): the always-on `## Memory` block is
 * budgeted at the insert point, so `MEMORY.md` stays whole on disk while the
 * prompt gets a bounded, newest-first slice plus an overflow notice naming what
 * was left out.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MemorySearchEngine } from '@shogo-ai/sdk/memory'
import {
  MEMORY_BUDGET_TOKENS_DEFAULT,
  MEMORY_BUDGET_TOKENS_MAX,
  MEMORY_BUDGET_TOKENS_MIN,
  MEMORY_SECTION_HEADING,
  buildMemorySection,
  resolveMemoryBudgetTokens,
} from '../memory-section'

const LESSON =
  '- when a tool fails twice, stop and report the blocker instead of retrying the same call with a third variation'

/** ~19 KB / ~4.7k tokens, 10 `##` sections — the measured QA workspace shape. */
function largeMemory(): string {
  const lines = ['# Memory', '', 'Durable facts about this agent, appended over months.']
  for (let s = 1; s <= 10; s++) {
    lines.push('', `## Topic ${s} — section ${s} of the archive`)
    for (let l = 1; l <= 14; l++) lines.push(`${s}.${l} ${LESSON}`)
  }
  return lines.join('\n')
}

function tokens(chars: number): number {
  return Math.ceil(chars / 4)
}

/** The injected body, without the overflow notice (which names dropped headings). */
function injectedBody(content: string): string {
  const at = content.indexOf('\n\n(MEMORY.md is')
  return at === -1 ? content : content.slice(0, at)
}

function overflowNotice(content: string): string {
  const at = content.indexOf('\n\n(MEMORY.md is')
  return at === -1 ? '' : content.slice(at + 2)
}

describe('buildMemorySection', () => {
  test('a file under budget is injected byte-identically to the pre-change prompt', () => {
    const markdown = ['# Memory', '', '## User', '- Prefers window seats', '- Lives in Honolulu'].join('\n')
    const section = buildMemorySection({ markdown, budgetTokens: 1500 })

    // This is exactly what `pushDynamic('memory', `## Memory\n${memory}`)` produced.
    expect(section.content).toBe(`${MEMORY_SECTION_HEADING}\n${markdown}`)
    expect(section.truncated).toBe(false)
    expect(section.droppedSections).toEqual([])
    expect(section.includedSections).toEqual(['## User'])
    expect(section.usedTokens).toBeLessThanOrEqual(1500)
  })

  test('a 19 KB file injects at most the budget and reports what it dropped', () => {
    const markdown = largeMemory()
    const size = Buffer.byteLength(markdown, 'utf8')
    expect(size).toBeGreaterThan(16_000)

    const section = buildMemorySection({ markdown, budgetTokens: 1500 })

    expect(section.truncated).toBe(true)
    expect(tokens(section.content.length)).toBeLessThanOrEqual(1500)
    expect(section.usedTokens).toBeLessThanOrEqual(1500)
    expect(section.totalTokens).toBeGreaterThan(4000)

    // Newest-first decay: the last section is in, the first one is out. The
    // notice may still name the dropped headings, so check the injected body.
    const body = injectedBody(section.content)
    expect(body).toContain('## Topic 10')
    expect(body).not.toContain('## Topic 1 —')
    expect(section.includedSections).toContain('## Topic 10 — section 10 of the archive')
    expect(section.droppedSections.map((d) => d.heading)).toContain('## Topic 1 — section 1 of the archive')

    // Kept sections stay in document order, not newest-first order.
    const firstKept = section.includedSections[0]!
    const lastKept = section.includedSections[section.includedSections.length - 1]!
    expect(body.indexOf(firstKept)).toBeLessThan(body.indexOf(lastKept))

    // The overflow notice names the file, the shortfall, and the retrieval path.
    const notice = overflowNotice(section.content)
    expect(notice).toContain(`MEMORY.md is ${size.toLocaleString('en-US')} B`)
    expect(notice).toContain(`across ${section.includedSections.length} of 10 sections`)
    expect(notice).toContain('Not loaded:')
    expect(notice).toContain('memory_search')
  })

  test('drops whole sections only — a kept heading always has its body', () => {
    const section = buildMemorySection({ markdown: largeMemory(), budgetTokens: 1500 })
    for (const heading of section.includedSections) {
      expect(section.content).toContain(heading)
    }
    // No line is cut mid-way: every body line in the output appears whole in the source.
    const source = new Set(largeMemory().split('\n'))
    const body = section.content.split('\n\n(MEMORY.md is')[0]!
    for (const line of body.split('\n')) {
      if (line.startsWith('## ') || line.startsWith('# Memory') || line === '' || line.startsWith('Durable facts')) continue
      expect(source.has(line)).toBe(true)
    }
  })

  test('the preamble is always kept', () => {
    const markdown = largeMemory()
    const section = buildMemorySection({ markdown, budgetTokens: 1500 })
    expect(section.content.startsWith(`${MEMORY_SECTION_HEADING}\n# Memory`)).toBe(true)
    expect(section.content).toContain('Durable facts about this agent, appended over months.')
  })

  test('a core marker wins over recency', () => {
    const markdown = [
      '# Memory',
      '',
      '<!-- memory:core:start -->',
      '## Standing rules',
      '- Never push to main.',
      '- Cards move to QA & Review, never to Done.',
      '<!-- memory:core:end -->',
      '',
      ...Array.from({ length: 8 }, (_, i) => `## Archive ${i + 1}\n\n${LESSON}\n${LESSON}\n${LESSON}`),
    ].join('\n')

    const section = buildMemorySection({ markdown, budgetTokens: 400 })

    expect(section.truncated).toBe(true)
    const body = injectedBody(section.content)
    expect(body).toContain('Never push to main.')
    expect(body).toContain('Cards move to QA & Review, never to Done.')
    // Archive sections after the core block are not injected, even though they are newer.
    expect(body).not.toContain('## Archive 8')
    expect(body).not.toContain('## Archive 1')
    expect(section.content).not.toContain('memory:core:start -->\n## Archive')
    expect(tokens(section.content.length)).toBeLessThanOrEqual(400)
  })

  test('a core block that fits still excludes the archive', () => {
    const markdown = [
      '<!-- memory:core:start -->',
      '- Short and durable.',
      '<!-- memory:core:end -->',
      '',
      ...Array.from({ length: 10 }, (_, i) => `## Archive ${i + 1}\n${LESSON}\n${LESSON}`),
    ].join('\n')

    const section = buildMemorySection({ markdown, budgetTokens: 400 })
    const body = injectedBody(section.content)
    expect(body).toContain('- Short and durable.')
    expect(body).not.toContain('## Archive 10')
    expect(overflowNotice(section.content)).toContain('memory_search')
    expect(section.usedTokens).toBeLessThanOrEqual(400)
  })

  test('a core block over budget is cut at a line boundary, never mid-line', () => {
    const coreLines = Array.from(
      { length: 200 },
      (_, i) => `- core rule ${i + 1}: ${LESSON.replace('- ', '')}`,
    )
    const markdown = [
      '<!-- memory:core:start -->',
      ...coreLines,
      '<!-- memory:core:end -->',
      '',
      '## Archive',
      LESSON,
    ].join('\n')

    const section = buildMemorySection({ markdown, budgetTokens: 400 })

    expect(section.truncated).toBe(true)
    expect(tokens(section.content.length)).toBeLessThanOrEqual(400)
    expect(section.content).toContain('cut at a line boundary')
    const body = section.content.split('\n\n(MEMORY.md is')[0]!
    const injected = body.split('\n').slice(1)
    expect(injected.length).toBeGreaterThan(0)
    for (const line of injected) {
      expect(coreLines).toContain(line)
    }
  })

  test('a file with no ## headings at all is cut at a line boundary', () => {
    const markdown = Array.from({ length: 300 }, (_, i) => `note ${i + 1}: ${LESSON.replace('- ', '')}`).join('\n')
    const section = buildMemorySection({ markdown, budgetTokens: 400 })

    expect(section.truncated).toBe(true)
    expect(tokens(section.content.length)).toBeLessThanOrEqual(400)
    expect(section.content).toContain('cut at a line boundary')
    expect(section.content).toContain('Split it into ## sections')
    expect(section.droppedSections).toEqual([])
  })

  test('CRLF files are cut cleanly and keep the working newline out of the output', () => {
    const markdown = largeMemory().replace(/\n/g, '\r\n')
    const section = buildMemorySection({ markdown, budgetTokens: 1500 })

    expect(section.truncated).toBe(true)
    expect(section.content).not.toContain('\r')
    const body = injectedBody(section.content)
    expect(body).toContain('## Topic 10')
    expect(body).not.toContain('## Topic 1 —')
    expect(tokens(section.content.length)).toBeLessThanOrEqual(1500)
  })

  test('a preamble bigger than the whole budget is cut, and the notice says so', () => {
    const preamble = Array.from(
      { length: 200 },
      (_, i) => `preamble line ${i + 1}: ${LESSON.replace('- ', '')}`,
    ).join('\n')
    const markdown = [preamble, '## Topic A', LESSON].join('\n')

    const section = buildMemorySection({ markdown, budgetTokens: 400 })

    expect(section.truncated).toBe(true)
    expect(tokens(section.content.length)).toBeLessThanOrEqual(400)
    const notice = overflowNotice(section.content)
    expect(notice).toContain('the rest of the opening section')
    expect(notice).toContain('## Topic A')
  })

  test('the budget holds for every shape of file and every clamped budget', () => {
    const coreOver = [
      '<!-- memory:core:start -->',
      ...Array.from({ length: 120 }, (_, i) => `- core rule ${i + 1}: ${LESSON.replace('- ', '')}`),
      '<!-- memory:core:end -->',
      '## Archive',
      LESSON,
    ].join('\n')
    const coreFits = [
      '<!-- memory:core:start -->',
      '- Short and durable.',
      '<!-- memory:core:end -->',
      ...Array.from({ length: 30 }, (_, i) => `## Archive ${i + 1}\n${LESSON}`),
    ].join('\n')
    const headingless = Array.from({ length: 400 }, (_, i) => `note ${i + 1}: ${LESSON.replace('- ', '')}`).join('\n')

    const fixtures: Array<[string, string]> = [
      ['large', largeMemory()],
      ['core over budget', coreOver],
      ['core fits', coreFits],
      ['headingless', headingless],
      ['under budget', '# Memory\n\n- one durable fact'],
    ]

    for (const [name, markdown] of fixtures) {
      for (const budgetTokens of [400, 800, 1500, 3000, 8000]) {
        const section = buildMemorySection({ markdown, budgetTokens })
        const used = tokens(section.content.length)
        if (used > budgetTokens) throw new Error(`${name} @ ${budgetTokens}: ${used} tokens injected`)
        expect(section.usedTokens).toBeLessThanOrEqual(budgetTokens)
        expect(section.content.startsWith(MEMORY_SECTION_HEADING)).toBe(true)
      }
    }
  })

  test('an empty or whitespace-only file produces no section', () => {
    for (const markdown of ['', '   \n\n\t\n']) {
      const section = buildMemorySection({ markdown, budgetTokens: 1500 })
      expect(section.content).toBe('')
      expect(section.truncated).toBe(false)
      expect(section.usedTokens).toBe(0)
      expect(section.includedSections).toEqual([])
      expect(section.droppedSections).toEqual([])
    }
  })

  test('the budget is clamped, so a typo cannot empty the block or blow it up', () => {
    const markdown = largeMemory()
    const tiny = buildMemorySection({ markdown, budgetTokens: 1 })
    expect(tiny.usedTokens).toBeLessThanOrEqual(MEMORY_BUDGET_TOKENS_MIN)
    expect(tiny.content.length).toBeGreaterThan(0)

    const huge = buildMemorySection({ markdown, budgetTokens: 1_000_000 })
    expect(tokens(huge.content.length)).toBeLessThanOrEqual(MEMORY_BUDGET_TOKENS_MAX)
    expect(huge.usedTokens).toBeLessThanOrEqual(MEMORY_BUDGET_TOKENS_MAX)
  })

  test('resolveMemoryBudgetTokens reads MEMORY_BUDGET_TOKENS with a clamp and a default', () => {
    expect(resolveMemoryBudgetTokens({} as NodeJS.ProcessEnv)).toBe(MEMORY_BUDGET_TOKENS_DEFAULT)
    expect(resolveMemoryBudgetTokens({ MEMORY_BUDGET_TOKENS: '1200' } as NodeJS.ProcessEnv)).toBe(1200)
    expect(resolveMemoryBudgetTokens({ MEMORY_BUDGET_TOKENS: '50' } as NodeJS.ProcessEnv)).toBe(MEMORY_BUDGET_TOKENS_MIN)
    expect(resolveMemoryBudgetTokens({ MEMORY_BUDGET_TOKENS: '99999' } as NodeJS.ProcessEnv)).toBe(MEMORY_BUDGET_TOKENS_MAX)
    expect(resolveMemoryBudgetTokens({ MEMORY_BUDGET_TOKENS: 'not-a-number' } as NodeJS.ProcessEnv)).toBe(
      MEMORY_BUDGET_TOKENS_DEFAULT,
    )
    expect(resolveMemoryBudgetTokens({ MEMORY_BUDGET_TOKENS: '' } as NodeJS.ProcessEnv)).toBe(MEMORY_BUDGET_TOKENS_DEFAULT)
  })
})

describe('memory_search still reaches what the budget left out', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shogo-memory-budget-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('a dropped section is searchable from the untouched file on disk', () => {
    const markdown = largeMemory().replace(
      '1.1 - when a tool fails twice',
      '1.1 - walrus migration: the oldest lesson carries a distinctive keyword',
    )
    writeFileSync(join(dir, 'MEMORY.md'), markdown, 'utf-8')

    const section = buildMemorySection({ markdown, budgetTokens: 1500 })
    expect(section.content).not.toContain('walrus migration')

    const engine = new MemorySearchEngine(dir)
    const hits = engine.search('walrus migration', 5)
    engine.close()

    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.file).toBe('MEMORY.md')
    expect(hits[0]!.chunk.toLowerCase()).toContain('walrus')
  })
})
