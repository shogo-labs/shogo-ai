// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * P2 — Per-stage telemetry and "did you mean" suggestion gates.
 *
 * Telemetry: every edit_file result (success and failure) carries a
 * `telemetry` block with the match stage, timings, file size, and
 * occurrence count. A structured one-line stdout log mirrors it for ops
 * scraping. Both shapes are pinned here so refactors can't drop fields.
 *
 * Suggestion: when no stage matches, the failure response includes a
 * verbatim "Did you mean" block plus a `suggested_old_string` field with
 * the file's exact bytes for the region the agent likely meant.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'
import { FileStateCache } from '../file-state-cache'
import { suggestCorrectedNeedle } from '../edit-file-utils'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TEST_DIR = '/tmp/test-edit-file-telemetry'

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

// Capture console.log output during a test so we can pin the structured
// `[edit_file] {...}` log line shape.
function captureConsoleLog<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  return (async () => {
    const original = console.log
    const lines: string[] = []
    console.log = (...args: any[]) => {
      lines.push(args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' '))
    }
    try {
      const result = await fn()
      return { result, lines }
    } finally {
      console.log = original
    }
  })()
}

// ---------------------------------------------------------------------------
// Telemetry — success paths
// ---------------------------------------------------------------------------

describe('edit_file telemetry: success', () => {
  test('exact match path tags telemetry stage="exact"', async () => {
    const ctx = createCtx()
    writeFileSync(join(TEST_DIR, 'a.ts'), 'const x = 1\n')
    await exec(ctx, 'read_file', { path: 'a.ts' })

    const { result, lines } = await captureConsoleLog(() =>
      exec(ctx, 'edit_file', { path: 'a.ts', old_string: 'const x = 1', new_string: 'const x = 2' })
    )

    expect(result.ok).toBe(true)
    expect(result.telemetry).toBeDefined()
    expect(result.telemetry.stage).toBe('exact')
    expect(result.telemetry.occurrences).toBe(1)
    expect(result.telemetry.fileBytes).toBeGreaterThan(0)
    expect(typeof result.telemetry.matchMs).toBe('number')
    expect(typeof result.telemetry.totalMs).toBe('number')
    expect(result.telemetry.totalMs).toBeGreaterThanOrEqual(result.telemetry.matchMs)

    // Structured stdout line is emitted with the same shape
    const editLine = lines.find((l) => l.startsWith('[edit_file] '))
    expect(editLine).toBeDefined()
    const payload = JSON.parse(editLine!.replace(/^\[edit_file\] /, ''))
    expect(payload.tool).toBe('edit_file')
    expect(payload.outcome).toBe('ok')
    expect(payload.stage).toBe('exact')
    expect(payload.path).toBe('a.ts')
  })

  test('curly-quote match path tags telemetry stage="curly-quote"', async () => {
    const ctx = createCtx()
    const left = '\u201C', right = '\u201D'
    writeFileSync(join(TEST_DIR, 'q.ts'), `const msg = ${left}hello${right}\n`)
    await exec(ctx, 'read_file', { path: 'q.ts' })

    const { result } = await captureConsoleLog(() =>
      exec(ctx, 'edit_file', {
        path: 'q.ts',
        old_string: 'const msg = "hello"',
        new_string: 'const msg = "world"',
      })
    )

    expect(result.ok).toBe(true)
    expect(result.telemetry.stage).toBe('curly-quote')
  })

  test('CRLF-only file with LF needle tags telemetry stage="crlf-normalize"', async () => {
    const ctx = createCtx()
    writeFileSync(join(TEST_DIR, 'crlf.ts'), 'line1\r\nline2\r\nline3\r\n')
    await exec(ctx, 'read_file', { path: 'crlf.ts' })

    const { result } = await captureConsoleLog(() =>
      exec(ctx, 'edit_file', {
        path: 'crlf.ts',
        old_string: 'line1\nline2',
        new_string: 'lineA\nlineB',
      })
    )

    expect(result.ok).toBe(true)
    expect(result.telemetry.stage).toBe('crlf-normalize')
  })

  test('trailing-whitespace tolerant match tags telemetry stage="trailing-ws"', async () => {
    const ctx = createCtx()
    writeFileSync(join(TEST_DIR, 't.py'), '    if foo:   \n        return 1\n')
    await exec(ctx, 'read_file', { path: 't.py' })

    const { result } = await captureConsoleLog(() =>
      exec(ctx, 'edit_file', {
        path: 't.py',
        old_string: '    if foo:\n        return 1',
        new_string: '    if bar:\n        return 2',
      })
    )

    expect(result.ok).toBe(true)
    expect(result.telemetry.stage).toBe('trailing-ws')
  })

  test('outer-indent translation tags telemetry stage="indent-translate"', async () => {
    const ctx = createCtx()
    writeFileSync(join(TEST_DIR, 'i.py'), 'def foo():\n    if x:\n        return True\n')
    await exec(ctx, 'read_file', { path: 'i.py' })

    const { result } = await captureConsoleLog(() =>
      exec(ctx, 'edit_file', {
        path: 'i.py',
        old_string: 'if x:\n    return True',
        new_string: 'if y:\n    return False',
      })
    )

    expect(result.ok).toBe(true)
    expect(result.telemetry.stage).toBe('indent-translate')
  })
})

// ---------------------------------------------------------------------------
// Telemetry — error paths
// ---------------------------------------------------------------------------

describe('edit_file telemetry: errors', () => {
  test('not-unique error includes telemetry with true occurrence count', async () => {
    const ctx = createCtx()
    writeFileSync(join(TEST_DIR, 'd.ts'), 'foo\nfoo\nfoo\nfoo\nfoo\n')
    await exec(ctx, 'read_file', { path: 'd.ts' })

    const { result, lines } = await captureConsoleLog(() =>
      exec(ctx, 'edit_file', { path: 'd.ts', old_string: 'foo', new_string: 'bar' })
    )

    expect(result.error).toContain('found 5 times')
    expect(result.telemetry).toBeDefined()
    expect(result.telemetry.stage).toBe('no-match')
    expect(result.telemetry.occurrences).toBe(5)

    const editLine = lines.find((l) => l.startsWith('[edit_file] '))
    const payload = JSON.parse(editLine!.replace(/^\[edit_file\] /, ''))
    expect(payload.outcome).toBe('error')
    expect(payload.errorKind).toBe('not-unique')
  })

  test('not-found error includes telemetry stage="no-match"', async () => {
    const ctx = createCtx()
    writeFileSync(join(TEST_DIR, 'n.ts'), 'function foo() {}\n')
    await exec(ctx, 'read_file', { path: 'n.ts' })

    const { result, lines } = await captureConsoleLog(() =>
      exec(ctx, 'edit_file', { path: 'n.ts', old_string: 'function bar()', new_string: 'function baz()' })
    )

    expect(result.error).toContain('not found')
    expect(result.telemetry.stage).toBe('no-match')
    expect(result.telemetry.occurrences).toBe(0)

    const editLine = lines.find((l) => l.startsWith('[edit_file] '))
    const payload = JSON.parse(editLine!.replace(/^\[edit_file\] /, ''))
    expect(payload.errorKind).toBe('not-found')
  })
})

// ---------------------------------------------------------------------------
// "Did you mean" suggestion — failure responses
// ---------------------------------------------------------------------------

describe('edit_file failure suggestion', () => {
  test('returns verbatim file text when needle differs only in indentation', async () => {
    const ctx = createCtx()
    writeFileSync(join(TEST_DIR, 'tabs.py'), '\tif x:\n\t\treturn True\n')
    await exec(ctx, 'read_file', { path: 'tabs.py' })

    // 4-space indent needle on a tab-indented file. Inconsistent indent
    // translation forces a refusal — the suggestion should hand back the
    // file's exact tab-indented bytes.
    const result = await exec(ctx, 'edit_file', {
      path: 'tabs.py',
      old_string: '    if x:\n        return True',
      new_string: '    if y:\n        return False',
    })

    expect(result.error).toContain('not found')
    expect(result.suggested_old_string).toBe('\tif x:\n\t\treturn True')
    expect(result.hint).toContain('Did you mean')
    expect(result.hint).toContain('\tif x:')
    expect(result.hint).toContain('BEGIN')
    expect(result.hint).toContain('END')
  })

  test('returns verbatim file text when needle has stale extra context', async () => {
    const ctx = createCtx()
    writeFileSync(join(TEST_DIR, 'src.ts'), 'function foo() {\n  return 1\n}\n')
    await exec(ctx, 'read_file', { path: 'src.ts' })

    // Needle assumes a comment that's not actually in the file. The
    // first-line anchor (Tier 3 of suggestCorrectedNeedle) should still
    // produce a usable suggestion starting at "function foo()".
    const result = await exec(ctx, 'edit_file', {
      path: 'src.ts',
      old_string: 'function foo() {\n  // comment\n  return 1\n}',
      new_string: 'function foo() {\n  return 2\n}',
    })

    expect(result.error).toContain('not found')
    expect(typeof result.suggested_old_string).toBe('string')
    expect(result.suggested_old_string).toContain('function foo()')
  })

  test('omits suggested_old_string when no candidate is similar enough', async () => {
    const ctx = createCtx()
    writeFileSync(join(TEST_DIR, 'far.ts'), 'export const a = 1\nexport const b = 2\n')
    await exec(ctx, 'read_file', { path: 'far.ts' })

    const result = await exec(ctx, 'edit_file', {
      path: 'far.ts',
      old_string: 'totally unrelated content',
      new_string: 'whatever',
    })

    expect(result.error).toContain('not found')
    expect(result.suggested_old_string).toBeUndefined()
    expect(result.hint).toContain('No similar content')
  })
})

// ---------------------------------------------------------------------------
// Unit tests for suggestCorrectedNeedle
// ---------------------------------------------------------------------------

describe('suggestCorrectedNeedle', () => {
  test('returns lstrip-equal block (Tier 1)', () => {
    const content = '\tif x:\n\t\treturn True\n'
    expect(suggestCorrectedNeedle(content, '    if x:\n        return True')).toBe('\tif x:\n\t\treturn True')
  })

  test('returns trim-equal block (Tier 2)', () => {
    const content = '   foo bar baz   \n   next   \n'
    // Both lines have leading AND trailing whitespace
    expect(suggestCorrectedNeedle(content, 'foo bar baz\nnext')).toBe('   foo bar baz   \n   next   ')
  })

  test('returns first-line anchor when block has drifted (Tier 3)', () => {
    const content = 'line0\nfunction foo() {\n  return 1\n}\nline4\n'
    const result = suggestCorrectedNeedle(content, 'function foo() {\n  // stale comment\n  return 1\n}')
    expect(result).not.toBeNull()
    expect(result!).toContain('function foo()')
  })

  test('returns null when nothing matches', () => {
    expect(suggestCorrectedNeedle('a\nb\nc\n', 'totally unrelated')).toBeNull()
  })
})
