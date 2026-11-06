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
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..')

describe('the runtime package contains no React source of its own', () => {
  it('has no .tsx file at the top of src/', () => {
    const strays = readdirSync(SRC, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
      .map((entry) => entry.name)
      .sort()

    expect(strays).toEqual([])
  })
})
