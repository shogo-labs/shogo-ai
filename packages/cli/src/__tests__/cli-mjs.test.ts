// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression tests for `bin/cli.mjs` — the published `@shogo-ai/sdk` CLI
 * entry point that runtime pods execute as `bun .../cli.mjs generate`.
 *
 * Locks in the fix for the bug where workspaces under macOS paths
 * containing spaces (e.g. "/Users/<u>/Library/Application Support/Shogo/...")
 * caused `shogo generate` to die with:
 *
 *   error: Module not found "/Users/<u>/Library/Application"
 *
 * The original `execSync(\`bun ${generateScript}\`, ...)` handed the
 * command to `/bin/sh -c`, which tokenized on whitespace before bun
 * ever saw the script path. The fix is to use `execFileSync('bun',
 * [generateScript], ...)` so the script path is passed verbatim as a
 * single argv entry.
 */

import { describe, expect, test } from 'bun:test'
import { execFileSync, execSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const CLI_PATH = resolve(import.meta.dir, '..', '..', '..', 'sdk', 'bin', 'cli.mjs')

describe('bin/cli.mjs — path-with-spaces regression', () => {
  test('source uses execFileSync (not bare execSync template) for the generate script', () => {
    const source = readFileSync(CLI_PATH, 'utf-8')

    // The fix: array-argv invocation, no shell tokenization.
    expect(source).toContain("execFileSync('bun', [generateScript]")

    // The bug: never re-introduce a string-template `bun ${...}` exec.
    expect(source).not.toMatch(/execSync\(`bun \$\{generateScript\}`/)
  })

  test('source converts the deploy module path through pathToFileURL', () => {
    const source = readFileSync(CLI_PATH, 'utf-8')

    // Defensive fix from the same investigation: dynamic import() of an
    // absolute filesystem path containing spaces breaks under Node's
    // strict file-URL parser. pathToFileURL is the canonical wrapper.
    expect(source).toContain('pathToFileURL')
    expect(source).toContain('await import(pathToFileURL(deployPath).href)')
  })

  test('execFileSync handles bun-script paths containing spaces; bare execSync does not', () => {
    // Build a tmp dir whose path is GUARANTEED to contain a space, so
    // we exercise the real code-path even on CI runners with a flat
    // /tmp prefix. We *don't* use mkdtempSync directly because some
    // sandboxes hand back paths without spaces.
    const baseDir = mkdtempSync(join(tmpdir(), 'shogo-cli-mjs-'))
    const spacedRoot = join(baseDir, 'has spaces in name')
    mkdirSync(spacedRoot, { recursive: true })

    const scriptPath = join(spacedRoot, 'marker.ts')
    const markerPath = join(spacedRoot, 'marker.txt')

    // Minimal Bun script — writes a sentinel and exits 0.
    writeFileSync(
      scriptPath,
      [
        `import { writeFileSync } from 'fs'`,
        `writeFileSync(${JSON.stringify(markerPath)}, 'ok')`,
        ``,
      ].join('\n'),
    )

    try {
      // Buggy form: `/bin/sh -c "bun /…/has spaces in name/marker.ts"`
      // splits the path and bun sees a phantom module specifier.
      let bareExecError: Error | null = null
      try {
        execSync(`bun ${scriptPath}`, { stdio: 'pipe' })
      } catch (err) {
        bareExecError = err as Error
      }
      expect(bareExecError).not.toBeNull()

      // Fixed form: array argv, no shell. Must succeed and run the script.
      execFileSync('bun', [scriptPath], { stdio: 'pipe' })
      expect(readFileSync(markerPath, 'utf-8')).toBe('ok')
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })
})
