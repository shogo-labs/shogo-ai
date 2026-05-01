// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the `bunx` → `bun x` Windows shim.
 *
 * Background: Shogo Desktop on Windows ships a bundled `bun.exe` but
 * historically did not bundle `bunx.exe`. Many of our agent prompts,
 * package.json scripts, and template docs still use the `bunx` form
 * (`bunx shogo generate`, `bunx prisma db push`, `bunx tsc --noEmit`,
 * `bunx shadcn add ...`), which crashes on Windows with
 * `'bunx' is not recognized`.
 *
 * `rewriteBunxOnWindows` defends the exec layer by transparently
 * translating leading-position `bunx` invocations to `bun x`. Tests
 * cover both the rewrite itself and that we don't accidentally
 * clobber unrelated occurrences (e.g. `grep bunx README.md`).
 *
 * Note: the rewrite is gated on `process.platform === 'win32'`.
 * On non-Windows platforms it is a no-op, so most tests check the
 * platform-agnostic invariants by calling the helper with both real
 * and synthetic input shapes.
 */

import { describe, test, expect } from 'bun:test'
import { rewriteBunxOnWindows } from '../sandbox-exec'

const IS_WIN = process.platform === 'win32'

describe('rewriteBunxOnWindows', () => {
  test('is a no-op on non-Windows platforms', () => {
    if (IS_WIN) return // skipped — see Windows-specific tests below
    expect(rewriteBunxOnWindows('bunx shogo generate')).toBe('bunx shogo generate')
    expect(rewriteBunxOnWindows('bunx --bun prisma db push')).toBe('bunx --bun prisma db push')
  })

  test('rewrites leading bunx → bun x on Windows', () => {
    if (!IS_WIN) return
    expect(rewriteBunxOnWindows('bunx shogo generate')).toBe('bun x shogo generate')
    expect(rewriteBunxOnWindows('bunx --bun prisma db push')).toBe('bun x --bun prisma db push')
    expect(rewriteBunxOnWindows('bunx tsc --noEmit')).toBe('bun x tsc --noEmit')
    expect(rewriteBunxOnWindows('bunx shadcn@latest add button card dialog')).toBe(
      'bun x shadcn@latest add button card dialog',
    )
  })

  test('rewrites bare `bunx` (no args)', () => {
    if (!IS_WIN) return
    expect(rewriteBunxOnWindows('bunx')).toBe('bun x')
  })

  test('rewrites bunx after `&&`, `||`, `;`, `|`, and newlines', () => {
    if (!IS_WIN) return
    expect(rewriteBunxOnWindows('bun install && bunx prisma generate')).toBe(
      'bun install && bun x prisma generate',
    )
    expect(rewriteBunxOnWindows('bun install || bunx shogo generate')).toBe(
      'bun install || bun x shogo generate',
    )
    expect(rewriteBunxOnWindows('echo a; bunx tsc --noEmit')).toBe(
      'echo a; bun x tsc --noEmit',
    )
    expect(rewriteBunxOnWindows('echo a | bunx jq .')).toBe(
      'echo a | bun x jq .',
    )
    expect(rewriteBunxOnWindows('echo first\nbunx prisma db push')).toBe(
      'echo first\nbun x prisma db push',
    )
  })

  test('does NOT rewrite bunx that appears mid-argument', () => {
    if (!IS_WIN) return
    // Real-world false-positive guards: command names / paths / quoted
    // strings that happen to contain the substring "bunx" must not be
    // mangled into "bun x ...".
    expect(rewriteBunxOnWindows('grep bunx README.md')).toBe('grep bunx README.md')
    expect(rewriteBunxOnWindows('echo "ran bunx earlier"')).toBe('echo "ran bunx earlier"')
    expect(rewriteBunxOnWindows('cat /path/to/bunx-helper.sh')).toBe(
      'cat /path/to/bunx-helper.sh',
    )
    expect(rewriteBunxOnWindows('node ./scripts/bunx-shim.mjs')).toBe(
      'node ./scripts/bunx-shim.mjs',
    )
  })

  test('handles commands without bunx unchanged', () => {
    if (!IS_WIN) return
    expect(rewriteBunxOnWindows('bun install')).toBe('bun install')
    expect(rewriteBunxOnWindows('npm install')).toBe('npm install')
    expect(rewriteBunxOnWindows('echo hello world')).toBe('echo hello world')
    expect(rewriteBunxOnWindows('')).toBe('')
  })

  test('rewrites multiple bunx occurrences in a chained command', () => {
    if (!IS_WIN) return
    expect(rewriteBunxOnWindows('bunx prisma generate && bunx prisma db push')).toBe(
      'bun x prisma generate && bun x prisma db push',
    )
  })
})
