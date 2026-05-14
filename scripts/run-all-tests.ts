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

import { existsSync, readFileSync, mkdirSync, readdirSync, statSync, rmSync, renameSync } from 'fs'
import { join, resolve } from 'path'
import { spawnSync } from 'child_process'

const REPO_ROOT = resolve(import.meta.dir, '..')

// Backend packages — counted in the primary "backend coverage" roll-up
// that drives the README badge and the strict per-package floors. These
// are server / runtime / library code; their behavior is exercised
// directly by in-process Bun tests and is the metric that matters for
// shipping the agent platform.
const BACKEND_PACKAGES = [
  'packages/model-catalog',
  'packages/shared-runtime',
  'packages/sdk',
  'packages/agent-runtime',
  'apps/api',
  // Internal repo tooling tests (merge-lcov, etc.). Lives outside the
  // bun workspaces glob — see scripts/package.json. Counted as backend
  // because it tests our build/coverage machinery.
  'scripts',
] as const

// Frontend packages — measured separately. These produce a parallel
// `coverage/frontend-summary.json` and `coverage/frontend-lcov.info`
// for visibility, but DO NOT contribute to the badge or the strict
// floors. UI testing has fundamentally different coverage economics
// (snapshot tests, integration via Playwright, etc.) and conflating
// the two distorts both metrics.
//
// Frontend coverage roadmap is tracked separately; until it has its
// own dedicated CI gating, the right thing for the merged badge is to
// not pretend backend + frontend share a meaningful aggregate.
const FRONTEND_PACKAGES = [
  'apps/mobile',
  // apps/desktop — Electron app, has only Playwright e2e tests today
  // (no `test:coverage` script). Listed here for documentation; the
  // runPackage skip path takes care of it.
  'apps/desktop',
  // packages/shared-app — UI-shared code (component primitives,
  // theming, etc.) used by the mobile + desktop frontends.
  'packages/shared-app',
] as const

const TEST_PACKAGES = [...BACKEND_PACKAGES, ...FRONTEND_PACKAGES] as const

// In-process e2e suites that import API/runtime modules directly (no
// external server needed). Counted toward backend coverage because
// they exercise route handlers and cross-module integration that
// pure unit tests don't reach (e.g. project-export-import wired
// through the production middleware layering).
//
// NOT included here: e2e/channels (needs a running runtime via
// AGENT_URL), e2e/replication (needs three regional Postgres
// instances), and the Playwright suites under e2e/staging|dev|local
// (browser-based, point at remote URLs). Capturing coverage from
// those requires V8-coverage instrumentation of the live server
// process — see Phase 3b in the README's coverage section.
//
// All in-process e2e tests force SHOGO_LOCAL_MODE=true +
// DATABASE_URL=sqlite to bypass the production guards that would
// otherwise reject local DB writes.
interface InProcessE2ESuite {
  name: string
  files: readonly string[]
  env: Record<string, string>
}
const IN_PROCESS_E2E_SUITES: readonly InProcessE2ESuite[] = [
  {
    name: 'apps/api in-process e2e',
    files: [
      'e2e/shogo-persistence.test.ts',
      'e2e/project-export-import.test.ts',
    ],
    env: {
      SHOGO_LOCAL_MODE: 'true',
      DATABASE_URL: 'file:./shogo.db',
    },
  },
] as const

interface PackageResult {
  pkg: string
  exitCode: number
  durationMs: number
}

interface E2EResult {
  name: string
  exitCode: number
  durationMs: number
  skipped?: string
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

/**
 * Run an in-process e2e suite from the repo root with `bun test
 * --coverage` and relocate the generated lcov to a stable shard path
 * (`coverage/.e2e-shards/<slug>/lcov.info`) so the post-fan-out merge
 * step can pick it up.
 *
 * Why we don't just lump these into a TEST_PACKAGES entry:
 *
 *   - The e2e files live under `/e2e/`, NOT under `apps/api/src/` or
 *     any other package. They're keyed against the repo root so the
 *     SF: paths in the resulting lcov already point at the right
 *     places (`apps/api/src/routes/voice.ts`, etc.) without any
 *     package-specific relativising.
 *   - They require process-level env (`SHOGO_LOCAL_MODE=true` +
 *     `DATABASE_URL=sqlite`) that we don't want to leak into the
 *     unit-test runs of other packages.
 *   - They depend on the local SQLite schema being pre-migrated; if
 *     `shogo.db` is missing we surface a clear "skipped — run db
 *     setup" message instead of failing 30s into a coverage build.
 *
 * Returns `skipped` when `shogo.db` is missing so coverage runs in
 * fresh checkouts (or CI without a DB step) don't false-fail. Returns
 * non-zero `exitCode` only when the bun test process itself fails.
 */
function runE2ESuite(
  suite: InProcessE2ESuite,
  withCoverage: boolean,
  coverageShardsRoot: string,
): E2EResult {
  const start = Date.now()
  const dbPath = resolve(REPO_ROOT, suite.env.DATABASE_URL?.replace(/^file:/, '') ?? '')
  if (suite.env.DATABASE_URL?.startsWith('file:') && !existsSync(dbPath)) {
    console.log(`\n=== ${suite.name}: SKIPPED ===`)
    console.log(`  ${dbPath} does not exist — run \`bun run db:generate:all\` (or \`bun dev:all\` once) to create it`)
    return { name: suite.name, exitCode: 0, durationMs: 0, skipped: 'sqlite db missing' }
  }

  console.log(`\n=== ${suite.name}: bun test ${suite.files.join(' ')} ${withCoverage ? '--coverage' : ''} ===`)
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...suite.env }
  // bun test writes coverage to <cwd>/coverage/lcov.info IF a bunfig
  // sets `coverageReporter = ["text", "lcov"]`. There's no bunfig at
  // the repo root (each package has its own), so the default reporter
  // is `text` only — hence we pass `--coverage-reporter=lcov`
  // explicitly when we run from the repo root. Without this, bun
  // prints the per-file table to stdout and writes no lcov file at
  // all, and the post-run rename silently no-ops.
  //
  // We rename the produced file post-run into a stable shard
  // directory so the next e2e suite (or the merge step that wipes
  // coverage/) doesn't clobber it.
  const args = ['--no-env-file', 'test', ...suite.files]
  if (withCoverage) {
    args.push('--coverage', '--coverage-reporter=lcov')
  }
  const proc = spawnSync('bun', args, {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    env: childEnv,
  })
  const exitCode = proc.status ?? 1
  const durationMs = Date.now() - start

  if (withCoverage) {
    const generated = join(REPO_ROOT, 'coverage', 'lcov.info')
    if (existsSync(generated)) {
      const slug = suite.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
      const shardDir = join(coverageShardsRoot, slug)
      mkdirSync(shardDir, { recursive: true })
      const dest = join(shardDir, 'lcov.info')
      try {
        renameSync(generated, dest)
      } catch (err) {
        // Cross-device fallback shouldn't happen here (same partition)
        // but if it does, leave the original file in place — the merge
        // step would then count it as a stray repo-root shard, which
        // is wrong but at least preserves the data.
        console.warn(`  [e2e] failed to relocate coverage shard: ${err}`)
      }
    } else {
      // Defensive: if Bun emits no lcov, surface the contents of
      // `coverage/` so a developer can tell the difference between
      // "tests didn't run" and "tests ran but the wrong reporter
      // wrote to disk". The most common cause is a missing
      // --coverage-reporter=lcov flag (no bunfig at the e2e cwd).
      const coverageDir = join(REPO_ROOT, 'coverage')
      const inventory = existsSync(coverageDir) ? readdirSync(coverageDir).join(', ') : '<missing>'
      console.warn(`  [e2e] expected coverage at ${generated} but file is missing (coverage/ contents: ${inventory})`)
    }
  }

  return { name: suite.name, exitCode, durationMs }
}

/**
 * Collect every e2e shard the runner produced. Mirrors the per-package
 * findLcovFiles contract so the merge step's input list is uniform.
 */
function findE2eShardLcovs(coverageShardsRoot: string): string[] {
  if (!existsSync(coverageShardsRoot)) return []
  const out: string[] = []
  for (const entry of readdirSync(coverageShardsRoot)) {
    const candidate = join(coverageShardsRoot, entry, 'lcov.info')
    if (existsSync(candidate)) out.push(candidate)
  }
  return out
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
  const e2eShardsRoot = join(rootCoverageDir, '.e2e-shards')
  if (withCoverage) {
    try { rmSync(rootCoverageDir, { recursive: true, force: true }) } catch {}
    mkdirSync(rootCoverageDir, { recursive: true })
    mkdirSync(e2eShardsRoot, { recursive: true })
  }

  const results: PackageResult[] = []
  for (const pkg of TEST_PACKAGES) {
    results.push(runPackage(pkg, withCoverage))
  }

  // In-process e2e suites — exercise the API server through its real
  // route handlers (with the production middleware layering) but
  // without needing a running HTTP server. Shipped after the package
  // fan-out because they often depend on the latest generated routes,
  // and run last so a missing local DB just emits a SKIPPED line
  // instead of bringing down the whole coverage build.
  const e2eResults: E2EResult[] = []
  for (const suite of IN_PROCESS_E2E_SUITES) {
    e2eResults.push(runE2ESuite(suite, withCoverage, e2eShardsRoot))
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
  for (const r of e2eResults) {
    const status = r.skipped ? 'SKIP' : (r.exitCode === 0 ? 'PASS' : 'FAIL')
    const trail = r.skipped ? `  (${r.skipped})` : ''
    console.log(`  ${status.padEnd(4)}  ${r.name.padEnd(34)}  ${(r.durationMs / 1000).toFixed(1)}s${trail}`)
    if (r.exitCode !== 0 && !r.skipped) {
      // Surface as a generic failure entry — the merge step doesn't
      // care which packageResult vs e2eResult triggered the exit, only
      // that something failed.
      failed.push({ pkg: r.name, exitCode: r.exitCode, durationMs: r.durationMs })
    }
  }

  let coverageExit = 0
  if (withCoverage) {
    // Collect every per-package lcov shard ONCE — the merger reads them
    // twice (backend + frontend roll-ups) and uses --include-package to
    // partition by `packageKey(SF:)`. We have to feed BOTH passes the
    // full shard set because Bun emits cross-package coverage (e.g.
    // agent-runtime tests load shared-runtime sources, mobile tests
    // load shared-app sources); per-source filtering is the only way
    // to get an honest split.
    const allLcovs: string[] = []
    for (const pkg of TEST_PACKAGES) {
      allLcovs.push(...findLcovFiles(pkg))
    }
    // E2E shards live under `coverage/.e2e-shards/<slug>/lcov.info`.
    // SF: paths are repo-relative (the suite ran from the repo root),
    // so they merge cleanly with the per-package shards keyed under
    // the same prefixes (apps/api, packages/shared-runtime, etc.) and
    // sum line hits with whatever the unit tests already covered.
    allLcovs.push(...findE2eShardLcovs(e2eShardsRoot))

    if (!allLcovs.length) {
      console.log()
      console.log('═'.repeat(72))
      console.log('  (no per-package coverage shards found — skipping merge)')
      console.log('═'.repeat(72))
    } else {
      // ────────────────────────────────────────────────────────────
      // Backend roll-up — drives the README badge and the strict
      // per-package floors. Strictness is intentionally OFF for the
      // initial split so we land an honest baseline first; once the
      // numbers are stable we can re-introduce --strict and tighten
      // the floors. See coverage/summary.json for the current
      // baseline used to set these floors.
      //
      // Per-package floors are aspirational targets, not historical
      // baselines: `bun test:coverage` runs in soft-floor mode (a
      // breach prints `[WARN]` but exit code stays 0). CI can opt
      // into strict enforcement with SHOGO_COVERAGE_STRICT=1 once
      // every backend package is at-or-above its floor.
      // ────────────────────────────────────────────────────────────
      console.log()
      console.log('═'.repeat(72))
      console.log('Aggregating BACKEND coverage (apps/api, packages/*, scripts)...')
      console.log('═'.repeat(72))
      const backendOut = join(rootCoverageDir, 'lcov.info')
      const backendArgs: string[] = [
        'run', join(REPO_ROOT, 'scripts', 'merge-lcov.ts'),
        '-o', backendOut,
        '--update-readme', join(REPO_ROOT, 'README.md'),
        // Two coverage badges live in the README — one for backend
        // (this run), one for frontend (the next run). Keying the
        // badge block by `coverage-badge:backend` keeps each merger
        // call updating only its own badge instead of fighting over
        // a single shared marker. Label + lcov-path control the
        // shields.io text and the GitHub click-through link.
        '--badge-key', 'coverage-badge:backend',
        '--badge-label', 'backend coverage',
        '--badge-lcov-path', 'coverage/lcov.info',
        '--summary-json', join(REPO_ROOT, 'coverage', 'summary.json'),
      ]
      for (const pkg of BACKEND_PACKAGES) {
        backendArgs.push('--include-package', pkg)
      }
      backendArgs.push(
        '--threshold-line', '0.7',
        '--threshold-function', '0.7',
        '--per-package-floor', 'apps/api:0.55',
        '--per-package-floor', 'packages/agent-runtime:0.6',
        '--per-package-floor', 'packages/shared-runtime:0.55',
        '--per-package-floor', 'packages/sdk:0.7',
        '--per-package-floor', 'packages/model-catalog:0.9',
      )
      backendArgs.push(...allLcovs)
      const backendMerge = spawnSync('bun', backendArgs, { stdio: 'inherit' })
      coverageExit = backendMerge.status ?? 1

      // ────────────────────────────────────────────────────────────
      // Frontend roll-up — informational only. No README badge, no
      // threshold enforcement, no impact on the run's exit code.
      // Captures whatever coverage the in-process unit tests under
      // apps/mobile + packages/shared-app produced so we have a
      // baseline to improve from when frontend testing gets its own
      // dedicated story (Playwright UI suites, RTL component tests,
      // etc.). apps/desktop is included for shape but currently has
      // no `test:coverage` script — the runner just skips it above.
      // ────────────────────────────────────────────────────────────
      console.log()
      console.log('═'.repeat(72))
      console.log('Aggregating FRONTEND coverage (apps/mobile, apps/desktop, packages/shared-app)...')
      console.log('═'.repeat(72))
      const frontendOut = join(rootCoverageDir, 'frontend-lcov.info')
      const frontendArgs: string[] = [
        'run', join(REPO_ROOT, 'scripts', 'merge-lcov.ts'),
        '-o', frontendOut,
        // Update the frontend badge in the README (sibling to the
        // backend badge above). No threshold enforcement on the
        // frontend roll-up today; we want visibility, not gating.
        '--update-readme', join(REPO_ROOT, 'README.md'),
        '--badge-key', 'coverage-badge:frontend',
        '--badge-label', 'frontend coverage',
        '--badge-lcov-path', 'coverage/frontend-lcov.info',
        '--summary-json', join(REPO_ROOT, 'coverage', 'frontend-summary.json'),
      ]
      for (const pkg of FRONTEND_PACKAGES) {
        frontendArgs.push('--include-package', pkg)
      }
      frontendArgs.push(...allLcovs)
      // Intentionally ignore frontend merge exit code — frontend
      // coverage doesn't gate the build today.
      spawnSync('bun', frontendArgs, { stdio: 'inherit' })
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
