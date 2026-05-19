// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * P1 perf regression tests for edit_file.
 *
 * Pins the perf wins from the P0/P1 audit so they don't regress:
 *   - O(n) substring counting (no full-file split into an array of strings)
 *   - Single-pass splice using known indices (no second content scan)
 *   - Lazy curly-quote normalization (skipped when no curly chars present)
 *   - Local diff window (no Myers diff over the entire file for tiny edits)
 *
 * Thresholds are intentionally loose — the goal is to catch O(n²)-style
 * regressions, not to micro-optimize. Tests run a known-fast operation
 * (the optimized exact-match path) on a 5 MB file and assert it completes
 * in under a generous wall-clock budget on CI hardware.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'
import { FileStateCache } from '../file-state-cache'
import {
  countOccurrences,
  findAllOccurrences,
  applyExactEdit,
  getLocalStructuredPatch,
} from '../edit-file-utils'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TEST_DIR = '/tmp/test-edit-file-perf'

function createCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'test',
    fileStateCache: new FileStateCache(),
    ...overrides,
  }
}

async function exec(ctx: ToolContext, name: string, params: Record<string, any>) {
  const tools = createTools(ctx)
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  const result = await tool.execute('test-call', params)
  return result.details
}

beforeAll(() => trustWorkspaceForTests(TEST_DIR))
afterAll(() => clearTrustForTests())

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
})
afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Unit tests for the new perf helpers
// ---------------------------------------------------------------------------

describe('countOccurrences', () => {
  test('returns 0 for an empty needle', () => {
    expect(countOccurrences('hello', '')).toBe(0)
  })

  test('counts non-overlapping occurrences', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2)
    expect(countOccurrences('foo bar foo baz foo', 'foo')).toBe(3)
  })

  test('respects maxCount and stops early', () => {
    // 1 million "x"s — without maxCount this would scan the whole string.
    const big = 'x'.repeat(1_000_000)
    const start = performance.now()
    const count = countOccurrences(big, 'x', 2)
    const elapsed = performance.now() - start
    expect(count).toBe(2)
    // Should exit after finding 2 matches, well under 5ms.
    expect(elapsed).toBeLessThan(20)
  })
})

describe('findAllOccurrences', () => {
  test('returns empty array when needle absent', () => {
    expect(findAllOccurrences('hello', 'world')).toEqual([])
  })

  test('returns positions in order', () => {
    expect(findAllOccurrences('abcabc', 'abc')).toEqual([0, 3])
  })

  test('respects maxCount', () => {
    expect(findAllOccurrences('aaaa', 'a', 2)).toEqual([0, 1])
  })
})

describe('applyExactEdit', () => {
  test('basic single-position splice', () => {
    expect(applyExactEdit('hello world', [6], 5, 'WORLD')).toBe('hello WORLD')
  })

  test('multi-position splice in single pass', () => {
    expect(applyExactEdit('a b a b a', [0, 4, 8], 1, 'X')).toBe('X b X b X')
  })

  test('consumeTrailingNewline strips \\n on deletion', () => {
    expect(applyExactEdit('line1\nline2\nline3\n', [6], 5, '', true)).toBe('line1\nline3\n')
  })

  test('consumeTrailingNewline does nothing when newString is non-empty', () => {
    expect(applyExactEdit('line1\nline2\nline3\n', [6], 5, 'LINE2', true)).toBe('line1\nLINE2\nline3\n')
  })

  test('returns content unchanged when positions array is empty', () => {
    expect(applyExactEdit('hello', [], 1, 'x')).toBe('hello')
  })
})

describe('getLocalStructuredPatch', () => {
  test('returns hunks for a simple edit (small file falls through to full diff)', () => {
    const before = 'line1\nline2\nline3\n'
    const after = 'line1\nLINE2\nline3\n'
    const hunks = getLocalStructuredPatch('test.ts', before, after, before.indexOf('line2'))
    expect(hunks.length).toBeGreaterThan(0)
    expect(hunks[0]!.lines.some((l) => l.startsWith('-line2'))).toBe(true)
    expect(hunks[0]!.lines.some((l) => l.startsWith('+LINE2'))).toBe(true)
  })

  test('windows around the splice point on a large file', () => {
    // 200 KB file (clears the small-file threshold). Splice at line 1000.
    const lines: string[] = []
    for (let i = 0; i < 5000; i++) lines.push(`line ${i.toString().padStart(8, '0')} content`)
    const before = lines.join('\n')
    const target = 'line 00001000 content'
    const after = before.replace(target, 'EDITED')
    const spliceIdx = before.indexOf(target)

    const hunks = getLocalStructuredPatch('big.ts', before, after, spliceIdx, 32)
    expect(hunks.length).toBeGreaterThan(0)
    // Hunk line numbers must be translated back to file-relative coords:
    // the splice is on line 1001 (1-based), so the hunk should start near
    // there, NOT near line 1 (which would mean window-relative numbering
    // leaked through).
    const hunkStarts = hunks.map((h) => h.oldStart)
    expect(Math.min(...hunkStarts)).toBeGreaterThan(900)
    expect(Math.max(...hunkStarts)).toBeLessThan(1100)
  })
})

// ---------------------------------------------------------------------------
// End-to-end perf gate: edit a 5 MB file with a small needle
// ---------------------------------------------------------------------------

describe('end-to-end edit_file performance', () => {
  test('5 MB file with a unique 32-byte needle completes under 250ms', async () => {
    const ctx = createCtx()
    const filePath = join(TEST_DIR, 'big.ts')

    // ~5 MB of repeated text with one unique landmark.
    const block = 'export const filler = "x".repeat(80) + "\\n"\n'
    const needle = 'export const ANCHOR_FOR_PERF_TEST = 1' // exactly 37 bytes
    const reps = Math.ceil((5 * 1024 * 1024) / block.length / 2)
    const halves: string[] = []
    for (let i = 0; i < reps; i++) halves.push(block)
    const content = halves.join('') + needle + '\n' + halves.join('')
    writeFileSync(filePath, content)
    await exec(ctx, 'read_file', { path: 'big.ts' })

    const start = performance.now()
    const result = await exec(ctx, 'edit_file', {
      path: 'big.ts',
      old_string: needle,
      new_string: 'export const ANCHOR_FOR_PERF_TEST = 2',
    })
    const elapsed = performance.now() - start

    expect(result.ok).toBe(true)
    expect(result.replacements).toBe(1)
    // Threshold is loose to absorb CI noise. Pre-fix code's split-based
    // counting + full-file Myers diff would push this well past 500ms on
    // a file this size; we leave a 2× margin.
    expect(elapsed).toBeLessThan(250)

    // Quick sanity check on the actual splice
    const updated = readFileSync(filePath, 'utf-8')
    expect(updated).toContain('export const ANCHOR_FOR_PERF_TEST = 2')
    expect(updated).not.toContain(needle)
  })

  test('not-unique check on a 5 MB file with many matches still completes quickly', async () => {
    const ctx = createCtx()
    const filePath = join(TEST_DIR, 'many.ts')

    // 5 MB of "foo\n" — millions of matches. Pre-fix: split allocates a
    // multi-million-element array. Post-fix: countOccurrences caps at 2.
    const content = 'foo\n'.repeat(Math.ceil((5 * 1024 * 1024) / 4))
    writeFileSync(filePath, content)
    await exec(ctx, 'read_file', { path: 'many.ts' })

    const start = performance.now()
    const result = await exec(ctx, 'edit_file', {
      path: 'many.ts',
      old_string: 'foo',
      new_string: 'bar',
      // replace_all NOT set — we want the "not unique" path
    })
    const elapsed = performance.now() - start

    expect(result.error).toBeTruthy()
    expect(String(result.error)).toContain('found')
    // The cap-at-2 indexOf walk plus the secondary count for the message
    // should keep this under 500ms even with millions of matches.
    expect(elapsed).toBeLessThan(500)
  })
})
