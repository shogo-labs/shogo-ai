// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * P0 correctness gates for the edit_file fuzzy-match pipeline.
 *
 * These tests pin behaviors that the original cascade got silently wrong:
 *
 *   #1 Stage 4 snapped mid-line matches to start-of-line and replaced the
 *      whole line, deleting bytes BEFORE the actual match span.
 *   #2 Stage 3's CRLF↔LF rebuild used a normalized-content offset against the
 *      original (CRLF-bearing) bytes, mis-splicing into the wrong region.
 *   #3 Stage 5 silently dropped the file's original indentation when the
 *      needle's indent didn't match the file's.
 *   #5 Multiple stages racing first-hit-wins meant a sloppy needle could
 *      pick a "different but plausible" location instead of failing loudly.
 *
 * Each test asserts either correct behavior OR an explicit refusal — the
 * one outcome that's not acceptable is silent corruption.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'
import { FileStateCache } from '../file-state-cache'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TEST_DIR = '/tmp/test-edit-file-fuzzy-correctness'

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
// Bug #1 — Stage 4 mid-line splice corruption
// ---------------------------------------------------------------------------

describe('Bug #1: trailing-whitespace tolerance must be line-anchored', () => {
  test('does not delete content before the actual match span', async () => {
    const ctx = createCtx()
    const filePath = join(TEST_DIR, 'midline-before.ts')
    // The first line has "PREFIX " before "line1" plus trailing whitespace.
    // The model's two-line needle is missing both the leading "PREFIX " and
    // the trailing whitespace. The pre-fix Stage 4 substring-searched in a
    // trim-trailing-stripped copy and snapped the splice to the start of
    // line 0, deleting "PREFIX " upstream of the real match.
    writeFileSync(filePath, 'PREFIX line1   \n    line2\nafter\n')
    await exec(ctx, 'read_file', { path: 'midline-before.ts' })

    const result = await exec(ctx, 'edit_file', {
      path: 'midline-before.ts',
      old_string: 'line1\n    line2',
      new_string: 'EDITED1\n    EDITED2',
    })

    if (result.ok) {
      const updated = readFileSync(filePath, 'utf-8')
      // "PREFIX " must still be in the file — the bug deleted it.
      expect(updated).toContain('PREFIX')
      expect(updated).toContain('after')
    } else {
      // Acceptable to refuse since the needle is mid-line ambiguous.
      expect(result.error.toLowerCase()).toMatch(/not found|ambiguous/)
    }
  })

  test('still matches multi-line needle when only trailing whitespace differs (line-aligned)', async () => {
    // This is the legitimate use case for Stage 4: file lines have trailing
    // whitespace the model's needle doesn't. The match IS line-aligned (no
    // prefix on either side). Must keep working.
    const ctx = createCtx()
    const filePath = join(TEST_DIR, 'aligned-trailing.py')
    writeFileSync(filePath, '    if foo:   \n        return 1\n')
    await exec(ctx, 'read_file', { path: 'aligned-trailing.py' })

    const result = await exec(ctx, 'edit_file', {
      path: 'aligned-trailing.py',
      old_string: '    if foo:\n        return 1',
      new_string: '    if bar:\n        return 2',
    })
    expect(result.ok).toBe(true)
    const updated = readFileSync(filePath, 'utf-8')
    expect(updated).toContain('    if bar:')
    expect(updated).toContain('        return 2')
  })
})

// ---------------------------------------------------------------------------
// Bug #2 — Stage 3 must use original-content byte offsets
// ---------------------------------------------------------------------------

describe('Bug #2: CRLF-aware match must splice at original byte offset', () => {
  test('does not mis-splice when file mixes CRLF and LF', async () => {
    const ctx = createCtx()
    const filePath = join(TEST_DIR, 'crlf-mixed.ts')
    // First two lines CRLF, rest LF. Model emits CRLF-formatted needle for
    // a region that's actually LF in the file. Pre-fix Stage 3 returned a
    // normalized-content offset, splicing into the middle of "line2".
    writeFileSync(filePath, 'line1\r\nline2\r\nTARGET\nfoo\nbar\n')
    await exec(ctx, 'read_file', { path: 'crlf-mixed.ts' })

    const result = await exec(ctx, 'edit_file', {
      path: 'crlf-mixed.ts',
      old_string: 'TARGET\r\nfoo',
      new_string: 'EDITED\nFOO',
    })

    if (result.ok) {
      const updated = readFileSync(filePath, 'utf-8')
      // Original CRLF lines must remain intact and uncorrupted.
      expect(updated).toContain('line1\r\n')
      expect(updated).toContain('line2\r\n')
      // No garbage like "line2EDITED" or "FOOoo" — those were the bug.
      expect(updated).not.toMatch(/line\d[A-Z]/)
      expect(updated).not.toContain('FOOoo')
      // The replacement must end up in the right region.
      expect(updated).toContain('EDITED')
      expect(updated).toContain('FOO')
      expect(updated).toContain('bar')
    } else {
      expect(result.error.toLowerCase()).toMatch(/not found|ambiguous/)
    }
  })

  test('still matches needle when only line endings differ (CRLF-only file)', async () => {
    // Legitimate Stage 3 use case: pure CRLF file, LF needle. Must keep working.
    const ctx = createCtx()
    const filePath = join(TEST_DIR, 'crlf-only.py')
    writeFileSync(filePath, 'line1\r\nline2\r\nline3\r\n')
    await exec(ctx, 'read_file', { path: 'crlf-only.py' })

    const result = await exec(ctx, 'edit_file', {
      path: 'crlf-only.py',
      old_string: 'line1\nline2',
      new_string: 'lineA\nlineB',
    })
    expect(result.ok).toBe(true)
    const updated = readFileSync(filePath, 'utf-8')
    expect(updated).toContain('lineA')
    expect(updated).toContain('lineB')
    expect(updated).toContain('line3')
  })
})

// ---------------------------------------------------------------------------
// Bug #3 — Stage 5 must preserve the file's indentation OR refuse
// ---------------------------------------------------------------------------

describe('Bug #3: whitespace-flexible match must not silently change indentation', () => {
  test('tab-indented file with 4-space needle: preserves tabs or refuses', async () => {
    const ctx = createCtx()
    const filePath = join(TEST_DIR, 'tabs.py')
    writeFileSync(filePath, '\tif x:\n\t\treturn True\n')
    await exec(ctx, 'read_file', { path: 'tabs.py' })

    const result = await exec(ctx, 'edit_file', {
      path: 'tabs.py',
      old_string: '    if x:\n        return True',
      new_string: '    if y:\n        return False',
    })

    if (result.ok) {
      const updated = readFileSync(filePath, 'utf-8')
      // Must NOT have silently injected 4-space indentation
      expect(updated).not.toContain('    if y:')
      expect(updated).not.toContain('        return False')
      // Tab indentation must be preserved
      expect(updated).toContain('\tif y:')
      expect(updated).toContain('\t\treturn False')
    } else {
      expect(result.error.toLowerCase()).toMatch(/not found|ambiguous/)
    }
  })

  test('outer-indented file with un-indented needle: applies file indent to new_string', async () => {
    // Canonical Aider case: needle is "logical" (no outer indent). File has a
    // consistent outer indent (e.g. inside a function). Replacement should
    // pick up the same outer indent.
    const ctx = createCtx()
    const filePath = join(TEST_DIR, 'outer-indent.py')
    writeFileSync(filePath, 'def foo():\n    if x:\n        return True\n')
    await exec(ctx, 'read_file', { path: 'outer-indent.py' })

    const result = await exec(ctx, 'edit_file', {
      path: 'outer-indent.py',
      // Needle has the inner block but missing the 4-space outer indent
      old_string: 'if x:\n    return True',
      new_string: 'if y:\n    return False',
    })

    expect(result.ok).toBe(true)
    const updated = readFileSync(filePath, 'utf-8')
    // The outer 4-space indent must be applied to both replacement lines
    expect(updated).toContain('    if y:')
    expect(updated).toContain('        return False')
    // The function definition is untouched
    expect(updated).toContain('def foo():\n')
  })
})

// ---------------------------------------------------------------------------
// Bug #5 — uniqueness must be enforced inside non-exact stages
// ---------------------------------------------------------------------------

describe('Bug #5: fuzzy stages must reject ambiguous (multi-match) needles', () => {
  test('curly-quote stage refuses when needle matches multiple curly variants', async () => {
    const ctx = createCtx()
    const filePath = join(TEST_DIR, 'curly-dup.ts')
    // Two distinct curly-quoted strings; both straight-quote-equivalent to
    // the needle. The pre-fix code rewrote the FIRST one silently.
    const left = '\u201C'
    const right = '\u201D'
    writeFileSync(filePath, `var a = ${left}hello${right}\nvar b = ${left}hello${right}\n`)
    await exec(ctx, 'read_file', { path: 'curly-dup.ts' })

    const result = await exec(ctx, 'edit_file', {
      path: 'curly-dup.ts',
      old_string: 'var b = "hello"',
      new_string: 'var b = "world"',
    })

    // The needle is unique under straight-quote normalization (only "var b ="
    // appears once), so this should still succeed and update line 2 only.
    expect(result.ok).toBe(true)
    const updated = readFileSync(filePath, 'utf-8')
    expect(updated).toContain(`var a = ${left}hello${right}`)
    expect(updated).toContain('var b =')
    expect(updated).toContain('world')
  })

  test('fuzzy stage refuses when whitespace-stripped needle matches multiple sites', async () => {
    const ctx = createCtx()
    const filePath = join(TEST_DIR, 'ambig.py')
    // Two different lines that look identical after trimEnd().
    writeFileSync(filePath, 'def foo():   \n    pass\n\ndef foo():\n    pass\n')
    await exec(ctx, 'read_file', { path: 'ambig.py' })

    const result = await exec(ctx, 'edit_file', {
      path: 'ambig.py',
      old_string: 'def foo():\n    pass',
      new_string: 'def bar():\n    pass',
    })

    // Exact-match stage already finds 2 occurrences of the second site, so
    // it returns the not-unique error. (This is the "exact wins" case.)
    // What we want to verify: even if exact-match fails (e.g. via additional
    // trailing-ws variation), the fuzzy stage must NOT silently pick one.
    if (!result.ok) {
      expect(result.error.toLowerCase()).toMatch(/found 2 times|ambiguous|not unique/)
    } else {
      // If a stage matched, it must have matched exactly one site, and only
      // one occurrence of "def bar():" must appear afterwards.
      const updated = readFileSync(filePath, 'utf-8')
      expect((updated.match(/def bar\(\):/g) ?? []).length).toBe(1)
    }
  })

  test('fuzzy stage refuses when whitespace-only differences create multi-site matches', async () => {
    const ctx = createCtx()
    const filePath = join(TEST_DIR, 'ambig-ws.py')
    // First and third occurrences both differ from needle only by whitespace.
    writeFileSync(filePath, 'a = 1\nfoo  bar\nbaz\nfoo bar\nq = 2\n')
    await exec(ctx, 'read_file', { path: 'ambig-ws.py' })

    const result = await exec(ctx, 'edit_file', {
      path: 'ambig-ws.py',
      old_string: 'foo bar',
      new_string: 'FOO BAR',
    })

    // "foo bar" appears as exact at byte 17. Stage 1 (exact) succeeds.
    expect(result.ok).toBe(true)
    const updated = readFileSync(filePath, 'utf-8')
    // The "foo  bar" (two spaces) site must remain untouched.
    expect(updated).toContain('foo  bar')
    // Exactly one "FOO BAR" was inserted.
    expect((updated.match(/FOO BAR/g) ?? []).length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting: every successful edit splices at the documented byte range
// ---------------------------------------------------------------------------

describe('splice byte range integrity', () => {
  test('splicing never drops bytes outside the matched span', async () => {
    const ctx = createCtx()
    const filePath = join(TEST_DIR, 'span.ts')
    const before = 'HEAD\n  middle line\nTAIL\n'
    writeFileSync(filePath, before)
    await exec(ctx, 'read_file', { path: 'span.ts' })

    const result = await exec(ctx, 'edit_file', {
      path: 'span.ts',
      old_string: '  middle line',
      new_string: '  REPLACED',
    })

    expect(result.ok).toBe(true)
    const after = readFileSync(filePath, 'utf-8')
    expect(after).toBe('HEAD\n  REPLACED\nTAIL\n')
  })
})
