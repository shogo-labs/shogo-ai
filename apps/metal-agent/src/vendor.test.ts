// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The deployed agent bundle is apps/metal-agent/src alone, so shipped code may
 * only import from inside src/. Shared modules are vendored into src/vendor/
 * and must stay byte-identical to packages/shared-runtime, or the agent and the
 * API would disagree about the repo manifest format.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'

const SRC = import.meta.dir
const SHARED = resolve(SRC, '../../../packages/shared-runtime/src')

describe('vendored shared-runtime modules', () => {
  for (const f of readdirSync(join(SRC, 'vendor'))) {
    test(`${f} matches packages/shared-runtime (run scripts/metal-agent/sync-vendor.sh)`, () => {
      expect(readFileSync(join(SRC, 'vendor', f), 'utf8')).toBe(readFileSync(join(SHARED, f), 'utf8'))
    })
  }

  test('shipped sources do not import outside src/', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name !== 'test-harness') walk(p)
          continue
        }
        if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) continue
        for (const m of readFileSync(p, 'utf8').matchAll(/(?:from|import\()\s*['"](\.[^'"]+)['"]/g)) {
          if (!resolve(dir, m[1]).startsWith(SRC + '/')) offenders.push(`${p.slice(SRC.length + 1)}: ${m[1]}`)
        }
      }
    }
    walk(SRC)
    expect(offenders).toEqual([])
  })
})
