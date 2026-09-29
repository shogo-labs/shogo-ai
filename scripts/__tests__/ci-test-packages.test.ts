// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Every package with unit tests must actually run in PR CI.
 *
 * apps/metal-agent's ~540 pool tests (every Firecracker lifecycle fix since
 * 2.0 came with one) were never executed by any workflow because the package
 * was missing from TEST_PACKAGES. This fails the next time a package with
 * tests is left out, or a TEST_PACKAGES entry drops out of the ci.yml matrix.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { TEST_PACKAGES } from '../run-all-tests'

const ROOT = resolve(import.meta.dir, '../..')

/**
 * Packages with test files that PR CI deliberately does not run. Each entry
 * is debt: fix the suite and move the package into TEST_PACKAGES.
 */
const NOT_IN_PR_CI: Record<string, string> = {
  'apps/desktop': 'in TEST_PACKAGES but has no test script, so the runner skips it; 8 failing tests',
  'packages/canvas-runtime': 'suite fails: react / react-dom version mismatch in the test env',
  'packages/cli': 'suite has a failing test; not run anywhere yet',
  'packages/shogo-worker': '39 failing tests (git/PATH/sqlite fixtures rotted while unrun)',
  'packages/desktop-terminal': 'no test script; tests need a native PTY',
  'packages/pty-core': 'no test script; tests need a native PTY',
  'packages/domain-stores': 'no test script',
}

function hasUnitTests(dir: string): boolean {
  const walk = (d: string): boolean => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'e2e' || entry.name.startsWith('.')) continue
      const p = join(d, entry.name)
      if (entry.isDirectory()) {
        if (walk(p)) return true
      } else if (/\.test\.tsx?$/.test(entry.name)) {
        return true
      }
    }
    return false
  }
  return walk(dir)
}

function workspacePackages(): string[] {
  return ['apps', 'packages'].flatMap((top) =>
    readdirSync(join(ROOT, top), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(ROOT, top, e.name, 'package.json')))
      .map((e) => `${top}/${e.name}`),
  )
}

function hasTestScript(pkg: string): boolean {
  const pj = JSON.parse(readFileSync(join(ROOT, pkg, 'package.json'), 'utf8'))
  return !!pj.scripts?.test
}

/** run-all-tests silently skips a TEST_PACKAGES entry without a `test` script. */
const EFFECTIVELY_RUN = new Set<string>(TEST_PACKAGES.filter(hasTestScript))

describe('PR CI runs every package that has unit tests', () => {
  it('each package with *.test.ts files is run by run-all-tests or explicitly excused', () => {
    const missing = workspacePackages().filter(
      (pkg) => hasUnitTests(join(ROOT, pkg)) && !EFFECTIVELY_RUN.has(pkg) && !(pkg in NOT_IN_PR_CI),
    )
    expect(missing).toEqual([])
  })

  it('excused packages are not actually running (drop the excuse once fixed)', () => {
    expect(Object.keys(NOT_IN_PR_CI).filter((pkg) => EFFECTIVELY_RUN.has(pkg))).toEqual([])
  })

  it('every package run-all-tests runs appears in the ci.yml test matrix', () => {
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
    const matrix = new Set(
      [...ci.matchAll(/^\s+packages: (.+)$/gm)].flatMap((m) => m[1].split(',').map((p) => p.trim())),
    )
    expect([...EFFECTIVELY_RUN].filter((pkg) => !matrix.has(pkg))).toEqual([])
  })
})
