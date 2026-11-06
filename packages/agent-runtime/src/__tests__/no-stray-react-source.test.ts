// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The agent runtime is a Node/Bun package: React lives in the canvas template
 * (`templates/runtime-template/`), never here.
 *
 * This exists because five files did land here — `App.tsx`, `main.tsx`,
 * `ShogoErrorBoundary.tsx`, `x.tsx`, `utils.ts`, one of them containing
 * `// hijacked` — swept into a commit by a `git add -A` from a tool test that
 * wrote fixtures relative to the wrong cwd. `tsconfig.json` includes `src`, so
 * they were compiled and shipped as part of the package. The test that owns them
 * can be fixed; this makes sure the debris cannot travel to `main` again.
 */

import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..')

const topLevelFiles = () =>
  readdirSync(SRC, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)

describe('the runtime package contains no React source of its own', () => {
  it('has no .tsx or .jsx file at the top of src/', () => {
    const strays = topLevelFiles()
      .filter((name) => name.endsWith('.tsx') || name.endsWith('.jsx'))
      .sort()

    expect(strays).toEqual([])
  })

  it('has no untracked file at the top of src/, whatever its extension', () => {
    // The leak wrote `utils.ts` too — a `.tsx`-only check misses half of it. Every
    // real module here is tracked, so an untracked one is debris by definition.
    // Skipped where git is unavailable (a source tarball, a packaged release).
    let tracked: string[] | null = null
    try {
      tracked = execFileSync('git', ['ls-files', '--', '.'], { cwd: SRC, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('/').pop()!)
    } catch {
      tracked = null
    }
    if (!tracked) return

    const trackedNames = new Set(tracked)
    const untracked = topLevelFiles()
      .filter((name) => !trackedNames.has(name))
      .sort()

    expect(untracked).toEqual([])
  })
})
