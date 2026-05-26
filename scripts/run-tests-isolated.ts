// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Run a directory of `bun test` files one process per file so that
 * `mock.module()` state can't leak across files.
 *
 * Background: `bun:test`'s `mock.module(specifier, factory)` is process-
 * global — once a file mocks a module, every later file that imports the
 * real module ends up with the mock. apps/api has ~25 test files that
 * each install a different mock for `../lib/prisma`; running them
 * in-process produces hundreds of bogus failures whose root cause is
 * "wrong prisma mock won the race", not real bugs. Per-file isolation is
 * the cheapest reliable fix.
 *
 * Usage:
 *   bun run scripts/run-tests-isolated.ts <packageDir> [testGlob]
 *
 *   # apps/api uses src/__tests__/ and src/lib/__tests__/
 *   bun run scripts/run-tests-isolated.ts apps/api
 *
 *   # Pass extra test args after `--`:
 *   bun run scripts/run-tests-isolated.ts apps/api -- --coverage
 *
 * Exits non-zero if any file fails. Prints a per-file summary at the end.
 */

import { readdirSync, statSync, existsSync, mkdirSync, rmSync, renameSync, readFileSync, writeFileSync } from 'fs'
import { join, relative, resolve } from 'path'
import { spawn, spawnSync } from 'child_process'
import { cpus } from 'os'

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/
const SKIP_DIR_RE = /(?:^|\/)(?:node_modules|dist|build|generated|\.next|coverage)(?:\/|$)/

function slugify(rel: string): string {
  return rel.replace(/[/\\]/g, '__').replace(/\.(test|spec)\.[^.]+$/, '')
}

function findTestFiles(dir: string): string[] {
  const out: string[] = []
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry)
      if (SKIP_DIR_RE.test(full)) continue
      let stat
      try { stat = statSync(full) } catch { continue }
      if (stat.isDirectory()) {
        stack.push(full)
      } else if (TEST_FILE_RE.test(entry)) {
        out.push(full)
      }
    }
  }
  return out.sort()
}

interface FileResult {
  file: string
  passed: number
  failed: number
  skipped: number
  durationMs: number
  exitCode: number
}

function parseSummary(output: string): { passed: number; failed: number; skipped: number } {
  // bun test prints lines like: ` 12 pass`, ` 0 fail`, ` 3 skip` near the end.
  const passed = Number(output.match(/^\s*(\d+)\s+pass\b/m)?.[1] ?? 0)
  const failed = Number(output.match(/^\s*(\d+)\s+fail\b/m)?.[1] ?? 0)
  const skipped = Number(output.match(/^\s*(\d+)\s+skip\b/m)?.[1] ?? 0)
  return { passed, failed, skipped }
}

function runOneSync(
  file: string,
  extraArgs: string[],
  cwd: string,
  coverageOpts: CoverageOpts | null,
): FileResult {
  const start = Date.now()
  // Run with the package dir as cwd so relative paths inside test files
  // (sqlite `file:./shogo.db`, prisma config, fixture loading) resolve the
  // same way `bun test` from the package would.
  const relFile = relative(cwd, file)
  const args = ['test', relFile, ...extraArgs]
  let shardDir: string | null = null
  if (coverageOpts) {
    // We pass `--coverage`. Bun honours the package's `bunfig.toml` for
    // `coverageDir` (currently "coverage") and ignores a CLI override
    // when both are set. So every subprocess writes the same path —
    // `<cwd>/coverage/lcov.info` — and we have to relocate the file
    // into a unique shard dir BEFORE the next subprocess runs.
    //
    // We deliberately don't set a per-file threshold here: bun would
    // always trip it for files that exercise only a sliver of the
    // package. The repo-wide aggregate threshold is enforced by
    // scripts/merge-lcov.ts after the fan-out.
    args.push('--coverage')
    shardDir = join(coverageOpts.shardsRoot, slugify(relFile))
  }
  // Scrub the local-dev env vars that `.env.local` (auto-loaded by
  // bun) bleeds into every child process. Tests like
  // `gateway-tools blocks path traversal` exercise production guards
  // that are intentionally bypassed when SHOGO_LOCAL_MODE=true (see
  // permission-engine.ts), so a developer who runs `bun dev:all` and
  // then `bun run test:coverage` from the same shell would see those
  // tests fail through no fault of the test author. We pass
  // `--no-env-file` on the child bun command (so it doesn't re-read
  // .env.local from disk) AND drop the offending keys from the
  // inherited env so a parent that already loaded them can't leak
  // them through.
  const childEnv = { ...process.env }
  delete childEnv.SHOGO_LOCAL_MODE
  delete childEnv.DATABASE_URL
  // AI_PROXY_URL is inherited from the Shogo desktop app shell and
  // makes modules that call configureAIProxy() at load time FATAL when
  // AI_PROXY_TOKEN is missing. See run-all-tests.ts for the longer
  // explanation. Drop both for test processes.
  delete childEnv.AI_PROXY_URL
  delete childEnv.AI_PROXY_TOKEN
  // `--no-env-file` must come BEFORE `test` (it's a runtime flag, not
  // a test-runner flag). `--conditions=development` makes bun honour
  // the `"development"` export-condition declared by workspace packages
  // (e.g. `@shogo-ai/sdk`'s `./instrumentation`, `./cli/pkg`, `./macos-junk`
  // subpath exports map `development -> ./src/...ts`). Without it, bun
  // resolves the default `import` condition which points at `./dist/*.js`
  // — files that do not exist on a fresh checkout or after `git clean -fd`
  // wipes the gitignored `dist/` dir, so transitive `import` chains in
  // packages/shared-runtime, packages/agent-runtime, etc. fail at module
  // load with `Cannot find module '@shogo-ai/sdk/...'`. The flag is a
  // no-op for packages that do not declare a `development` condition
  // (apps/api, etc.), so we apply it unconditionally.
  const procArgs = ['--no-env-file', '--conditions=development', ...args]
  const proc = spawnSync('bun', procArgs, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
    cwd,
  })
  if (coverageOpts && shardDir) {
    const defaultLcov = join(cwd, 'coverage', 'lcov.info')
    if (existsSync(defaultLcov)) {
      mkdirSync(shardDir, { recursive: true })
      // Move (rename) so we leave nothing stale for the next subprocess.
      try {
        renameSync(defaultLcov, join(shardDir, 'lcov.info'))
      } catch {
        // Cross-device fallback: copy + unlink. Unlikely in practice
        // (everything is on the same partition) but cheap to handle.
        try {
          const buf = readFileSync(defaultLcov)
          writeFileSync(join(shardDir, 'lcov.info'), buf)
          rmSync(defaultLcov, { force: true })
        } catch { /* best-effort */ }
      }
    }
  }
  const durationMs = Date.now() - start
  const stdout = proc.stdout || ''
  const stderr = proc.stderr || ''
  // bun test writes the final summary to stderr
  const combined = stderr + '\n' + stdout
  const { passed, failed, skipped } = parseSummary(combined)
  if (proc.status !== 0) {
    process.stdout.write(stdout)
    process.stderr.write(stderr)
  }
  return {
    file,
    passed,
    failed,
    skipped,
    durationMs,
    exitCode: proc.status ?? 1,
  }
}

interface CoverageOpts {
  shardsRoot: string
  outFile: string
}

/**
 * Async variant of {@link runOneSync} that spawns a child without blocking
 * the loop. Used by the parallel pool below.
 *
 * Coverage runs intentionally fall back to the sync variant — Bun writes
 * `coverage/lcov.info` relative to cwd and ignores CLI overrides, so two
 * children running in the same package's cwd would clobber each other's
 * shard. The parallel pool detects this and serialises coverage-bearing
 * children.
 */
function runOneAsync(
  file: string,
  extraArgs: string[],
  cwd: string,
): Promise<FileResult> {
  return new Promise((resolveFn) => {
    const start = Date.now()
    const relFile = relative(cwd, file)
    const childEnv = { ...process.env }
    delete childEnv.SHOGO_LOCAL_MODE
    delete childEnv.DATABASE_URL
    delete childEnv.AI_PROXY_URL
    delete childEnv.AI_PROXY_TOKEN
    const procArgs = ['--no-env-file', '--conditions=development', 'test', relFile, ...extraArgs]
    const proc = spawn('bun', procArgs, { env: childEnv, cwd })

    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d) => { stdout += d.toString() })
    proc.stderr?.on('data', (d) => { stderr += d.toString() })

    proc.on('close', (code) => {
      const durationMs = Date.now() - start
      const combined = stderr + '\n' + stdout
      const { passed, failed, skipped } = parseSummary(combined)
      const exitCode = code ?? 1
      if (exitCode !== 0) {
        process.stdout.write(stdout)
        process.stderr.write(stderr)
      }
      resolveFn({ file, passed, failed, skipped, durationMs, exitCode })
    })

    proc.on('error', () => {
      resolveFn({
        file,
        passed: 0,
        failed: 1,
        skipped: 0,
        durationMs: Date.now() - start,
        exitCode: 1,
      })
    })
  })
}

/**
 * Drain `files` through a pool of {@link concurrency} parallel workers.
 * Each worker pulls the next file from the queue and runs it via
 * {@link runOneAsync}. Returns results in completion order (not input
 * order); the caller sorts by file name for the summary.
 */
async function runPool(
  files: string[],
  extraArgs: string[],
  cwd: string,
  concurrency: number,
): Promise<FileResult[]> {
  const results: FileResult[] = []
  let cursor = 0
  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(concurrency, files.length); i++) {
    workers.push((async () => {
      while (true) {
        const idx = cursor++
        if (idx >= files.length) return
        const file = files[idx]
        const rel = relative(process.cwd(), file)
        process.stdout.write(`  ${rel} ... `)
        const result = await runOneAsync(file, extraArgs, cwd)
        const tag = result.exitCode === 0 ? 'OK' : 'FAIL'
        process.stdout.write(
          `${tag} (${result.passed} pass, ${result.failed} fail, ${result.skipped} skip, ${result.durationMs}ms)\n`,
        )
        results.push(result)
      }
    })())
  }
  await Promise.all(workers)
  return results
}

/**
 * Resolve the `--parallel <N>` flag from argv. Defaults to half the
 * available CPUs (capped at 8) when omitted — empirically that's the
 * sweet spot for an apps/api shard that ~30 test files where each
 * subprocess fork-bombs sqlite, OpenAI mocks, and node:child_process.
 *
 * Coverage runs always force N=1 because Bun writes `coverage/lcov.info`
 * relative to cwd and ignores CLI overrides, so parallel children in
 * the same package cwd would clobber each other's shard.
 */
function parseParallel(argv: string[]): { parallel: number; rest: string[] } {
  const rest: string[] = []
  let parallel = Math.max(1, Math.min(8, Math.ceil(cpus().length / 2)))
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--parallel' && argv[i + 1]) {
      const n = parseInt(argv[i + 1], 10)
      if (Number.isFinite(n) && n >= 1) parallel = n
      i++
      continue
    }
    if (a.startsWith('--parallel=')) {
      const n = parseInt(a.split('=')[1] ?? '', 10)
      if (Number.isFinite(n) && n >= 1) parallel = n
      continue
    }
    rest.push(a)
  }
  return { parallel, rest }
}

async function main() {
  const argv = process.argv.slice(2)
  const dashIdx = argv.indexOf('--')
  const positionalRaw = dashIdx === -1 ? argv : argv.slice(0, dashIdx)
  const extraArgs = dashIdx === -1 ? [] : argv.slice(dashIdx + 1)

  // Support --coverage on the runner itself so a package can run
  //   bun ../../scripts/run-tests-isolated.ts . --coverage
  // and end up with merged `coverage/lcov.info`.
  const wantCoverage = positionalRaw.includes('--coverage')
  const filteredRaw = positionalRaw.filter((a) => a !== '--coverage')
  const { parallel: parallelFlag, rest: positional } = parseParallel(filteredRaw)
  // Coverage forces serial — Bun writes lcov.info relative to cwd.
  const effectiveParallel = wantCoverage ? 1 : parallelFlag

  const target = positional[0]
  if (!target) {
    console.error('usage: run-tests-isolated.ts <packageDir> [--coverage] [--parallel N] [-- ...extraBunTestArgs]')
    process.exit(2)
  }

  const root = resolve(process.cwd(), target)
  if (!existsSync(root)) {
    console.error(`error: ${target} does not exist`)
    process.exit(2)
  }

  let coverageOpts: CoverageOpts | null = null
  if (wantCoverage) {
    const coverageDir = join(root, 'coverage')
    const shardsRoot = join(coverageDir, '.shards')
    // Wipe stale shards so a new run starts clean.
    try { rmSync(shardsRoot, { recursive: true, force: true }) } catch {}
    mkdirSync(shardsRoot, { recursive: true })
    coverageOpts = { shardsRoot, outFile: join(coverageDir, 'lcov.info') }
  }

  const candidates = ['src', 'tests', 'test', '__tests__']
    .map((d) => join(root, d))
    .filter((d) => existsSync(d))

  const searchRoots = candidates.length ? candidates : [root]
  const allFiles = searchRoots.flatMap(findTestFiles)

  if (!allFiles.length) {
    console.error(`no test files found under ${target}`)
    process.exit(1)
  }

  const modeNote = wantCoverage
    ? ' (with coverage; serial)'
    : effectiveParallel > 1
      ? ` (parallel ×${effectiveParallel})`
      : ''
  console.log(`running ${allFiles.length} test files isolated under ${target}${modeNote}...`)
  console.log()

  let results: FileResult[]
  if (wantCoverage || effectiveParallel <= 1) {
    results = []
    for (const file of allFiles) {
      const rel = relative(process.cwd(), file)
      process.stdout.write(`  ${rel} ... `)
      const result = runOneSync(file, extraArgs, root, coverageOpts)
      results.push(result)
      const tag = result.exitCode === 0 ? 'OK' : 'FAIL'
      process.stdout.write(
        `${tag} (${result.passed} pass, ${result.failed} fail, ${result.skipped} skip, ${result.durationMs}ms)\n`,
      )
    }
  } else {
    results = await runPool(allFiles, extraArgs, root, effectiveParallel)
  }

  let totalPassed = 0
  let totalFailed = 0
  let totalSkipped = 0
  for (const r of results) {
    totalPassed += r.passed
    totalFailed += r.failed
    totalSkipped += r.skipped
  }

  console.log()
  const failedFiles = results.filter((r) => r.exitCode !== 0)
  console.log('─'.repeat(72))
  console.log(`Total: ${totalPassed} pass, ${totalFailed} fail, ${totalSkipped} skip across ${results.length} files`)
  if (failedFiles.length) {
    console.log()
    console.log(`Failed files (${failedFiles.length}):`)
    for (const r of failedFiles) {
      console.log(`  ${relative(process.cwd(), r.file)}  (exit ${r.exitCode})`)
    }
  }

  let coverageExit = 0
  if (coverageOpts) {
    const shardLcovs: string[] = []
    const collect = (dir: string) => {
      let entries: string[]
      try { entries = readdirSync(dir) } catch { return }
      for (const entry of entries) {
        const full = join(dir, entry)
        let stat
        try { stat = statSync(full) } catch { continue }
        if (stat.isDirectory()) collect(full)
        else if (entry === 'lcov.info') shardLcovs.push(full)
      }
    }
    collect(coverageOpts.shardsRoot)

    if (!shardLcovs.length) {
      console.log()
      console.log('coverage: no shards produced (none of the test files exercised package source)')
    } else {
      const mergeArgs = [
        'run', resolve(import.meta.dir, 'merge-lcov.ts'),
        '-o', coverageOpts.outFile,
        '--threshold-line', '0.5',
        '--threshold-function', '0.5',
        ...shardLcovs,
      ]
      const merge = spawnSync('bun', mergeArgs, { stdio: 'inherit' })
      coverageExit = merge.status ?? 1
    }
  }

  if (failedFiles.length) process.exit(1)
  process.exit(coverageExit)
}

main().catch((err) => {
  console.error('run-tests-isolated.ts failed:', err)
  process.exit(1)
})
