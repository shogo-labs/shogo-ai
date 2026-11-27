// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-601 — Shiki loads through exactly one door.
 *
 * The bug this pins: two independent `import("shiki")` call sites made Metro
 * treat the grammars both chunks needed as shared, promote them into
 * `__common-*.js`, and parse 2.6 MB of TextMate grammars before first paint.
 * Nothing in the type system or the build stops a second call site coming back,
 * so this test does: every Shiki import in the app has to sit behind
 * `lib/code-highlight.ts`, which owns the single dynamic `import()` (in
 * `lib/code-highlight-shiki.ts`, one hop down so Metro keeps it async).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const MOBILE_ROOT = path.resolve(import.meta.dir, '../..')
const SCANNED_DIRS = ['app', 'components', 'hooks', 'lib', 'test', 'stubs']
const SKIPPED = new Set(['node_modules', '.tmp', 'dist', '.expo', 'ios', 'android'])

// The one module allowed to import Shiki, plus itself and the tests that stand
// the highlighter up on purpose.
const ALLOWED = new Set([
  'lib/code-highlight-shiki.ts',
  'lib/code-highlight.ts',
  'lib/__tests__/code-highlight.test.ts',
  'lib/__tests__/code-highlight-single-entry.test.ts',
])

const SHIKI_IMPORT = /(?:from\s*|import\(\s*|require\(\s*)['"]shiki(?:\/[^'"]*)?['"]/

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, found)
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) found.push(full)
  }
  return found
}

describe('Shiki has one entry point (SHO-601)', () => {
  test('no module outside lib/code-highlight* imports shiki', () => {
    const offenders: string[] = []
    for (const dir of SCANNED_DIRS) {
      let stat
      try {
        stat = statSync(path.join(MOBILE_ROOT, dir))
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      for (const file of walk(path.join(MOBILE_ROOT, dir))) {
        const relative = path.relative(MOBILE_ROOT, file).split(path.sep).join('/')
        if (ALLOWED.has(relative)) continue
        const source = readFileSync(file, 'utf8')
        if (SHIKI_IMPORT.test(source)) offenders.push(relative)
      }
    }

    expect(offenders).toEqual([])
  })

  test('the entry point loads the highlighter with a dynamic import, not a static one', () => {
    const entry = readFileSync(path.join(MOBILE_ROOT, 'lib/code-highlight.ts'), 'utf8')
    expect(entry).toContain("import('./code-highlight-shiki')")
    expect(entry).not.toMatch(/^import\s+(?!type\b).*from\s*['"]shiki/m)
  })
})
