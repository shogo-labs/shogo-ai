// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Root-level test runner. Fans out the per-package `test` (or
 * `test:coverage`) script to every workspace package that ships tests,
 * then — when run with `--coverage` — merges all per-package
 * `coverage/lcov.info` files into a unified `coverage/lcov.info` at
 * the repo root and enforces a soft 50% line / 50% function floor.
 *
 * Why a custom runner instead of `bun --filter '*' test`?
 *
 *   - We want to fail-fast on test failures *and* still always run the
 *     coverage merge step so the unified lcov is available even on
 *     partial runs (CI uploads the file regardless of pass/fail).
 *   - apps/api uses scripts/run-tests-isolated.ts (process-per-file) to
 *     avoid `mock.module()` cross-test contamination; that runner has a
 *     different stdout shape than `bun test` and we want to surface its
 *     failure list inline.
 *   - We need an aggregate threshold check (`scripts/merge-lcov.ts`
 *     enforces it post-merge) — Bun's per-process threshold can't see
 *     across packages.
 *
 * Usage:
 *   bun run scripts/run-all-tests.ts             # plain unit run
 *   bun run scripts/run-all-tests.ts --coverage  # + lcov merge + threshold
 */

import { existsSync, readFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { spawnSync } from 'child_process'

const REPO_ROOT = resolve(import.meta.dir, '..')

// Packages with executable unit tests. Order matters only for output —
// failures from any package mark the whole run failed, but we keep going
// so the summary is complete.
const TEST_PACKAGES = [
  'packages/model-catalog',
  'packages/shared-runtime',
  'packages/shared-app',
  'packages/sdk',
  'packages/agent-runtime',
  'apps/api',
  'apps/mobile',
] as const

interface PackageResult {
  pkg: string
  exitCode: number
  durationMs: number
}

function readPkgScripts(pkgDir: string): Record<string, string> {
  const pkgJson = join(pkgDir, 'package.json')
  if (!existsSync(pkgJson)) return {}
  try {
    const parsed = JSON.parse(readFileSync(pkgJson, 'utf-8'))
    return (parsed.scripts ?? {}) as Record<string, string>
  } catch {
    return {}
  }
}

function runPackage(pkg: string, withCoverage: boolean): PackageResult {
  const start = Date.now()
  const pkgDir = join(REPO_ROOT, pkg)
  const scripts = readPkgScripts(pkgDir)

  const scriptName = withCoverage && scripts['test:coverage']
    ? 'test:coverage'
    : 'test'

  if (!scripts[scriptName]) {
    console.log(`\n=== ${pkg}: no \`${scriptName}\` script — skipping ===`)
    return { pkg, exitCode: 0, durationMs: 0 }
  }

  console.log(`\n=== ${pkg}: bun run ${scriptName} ===`)
  // Scrub local-dev env vars that .env.local bakes into every shell
  // (SHOGO_LOCAL_MODE=true bypasses production guards in
  // permission-engine.ts; DATABASE_URL points at the dev SQLite). If
  // a developer runs `bun dev:all` and then `bun run test:coverage`
  // from the same terminal these would leak in and break tests like
  // `gateway-tools blocks path traversal`.
  const childEnv = { ...process.env }
  delete childEnv.SHOGO_LOCAL_MODE
  delete childEnv.DATABASE_URL
  const proc = spawnSync('bun', ['run', scriptName], {
    stdio: 'inherit',
    cwd: pkgDir,
    env: childEnv,
  })
  const durationMs = Date.now() - start
  return { pkg, exitCode: proc.status ?? 1, durationMs }
}

function findLcovFiles(pkg: string): string[] {
  // Per-package coverage lives at <pkg>/coverage/lcov.info. Some packages
  // (apps/api) generate per-file shards under <pkg>/coverage/.shards/...,
  // but the isolated runner already merges those into
  // <pkg>/coverage/lcov.info — we only need to pick that up.
  const candidate = join(REPO_ROOT, pkg, 'coverage', 'lcov.info')
  return existsSync(candidate) ? [candidate] : []
}

function main() {
  const argv = process.argv.slice(2)
  const withCoverage = argv.includes('--coverage')

  const rootCoverageDir = join(REPO_ROOT, 'coverage')
  if (withCoverage) {
    try { rmSync(rootCoverageDir, { recursive: true, force: true }) } catch {}
    mkdirSync(rootCoverageDir, { recursive: true })
  }

  const results: PackageResult[] = []
  for (const pkg of TEST_PACKAGES) {
    results.push(runPackage(pkg, withCoverage))
  }

  console.log()
  console.log('═'.repeat(72))
  console.log('Per-package test summary:')
  console.log('═'.repeat(72))
  const failed: PackageResult[] = []
  for (const r of results) {
    const status = r.exitCode === 0 ? 'PASS' : 'FAIL'
    console.log(`  ${status.padEnd(4)}  ${r.pkg.padEnd(34)}  ${(r.durationMs / 1000).toFixed(1)}s`)
    if (r.exitCode !== 0) failed.push(r)
  }

  let coverageExit = 0
  if (withCoverage) {
    console.log()
    console.log('═'.repeat(72))
    console.log('Aggregating per-package coverage into root lcov...')
    console.log('═'.repeat(72))
    const allLcovs: string[] = []
    for (const pkg of TEST_PACKAGES) {
      allLcovs.push(...findLcovFiles(pkg))
    }
    if (!allLcovs.length) {
      console.log('  (no per-package coverage shards found — skipping merge)')
    } else {
      const out = join(rootCoverageDir, 'lcov.info')
      const merge = spawnSync('bun', [
        'run', join(REPO_ROOT, 'scripts', 'merge-lcov.ts'),
        '-o', out,
        '--threshold-line', '0.5',
        '--threshold-function', '0.5',
        '--update-readme', join(REPO_ROOT, 'README.md'),
        ...allLcovs,
      ], { stdio: 'inherit' })
      coverageExit = merge.status ?? 1
    }
  }

  if (failed.length) {
    console.log()
    console.log(`✗ ${failed.length} package(s) had test failures`)
    process.exit(1)
  }
  if (coverageExit !== 0) {
    console.log()
    console.log('✗ aggregate coverage thresholds not met')
    process.exit(coverageExit)
  }
  console.log()
  console.log('✓ all packages passed')
  process.exit(0)
}

main()
