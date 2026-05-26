#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration test for `scripts/sync-web.mjs`. Run with:
 *
 *   cd apps/desktop && bun test-sync-web.ts
 *
 * We drive the real script against a synthesized fake monorepo:
 *
 *   tmp/
 *     apps/
 *       mobile/
 *         dist/           ← we hand-populate this with mock files
 *         package.json
 *       desktop/
 *         scripts/sync-web.mjs   (copied verbatim from the real one)
 *         resources/
 *
 * Then we invoke `node scripts/sync-web.mjs --skip-mobile-build` and
 * assert the script's exit code, stdout, and the resulting on-disk
 * state of `resources/web/`. The `--skip-mobile-build` flag is essential
 * — without it the script would try to run `bun run build` against the
 * fake mobile package, which has no real expo + monaco deps.
 *
 * Cases pinned here:
 *
 *   1. Happy path  — all REQUIRED_FILES present + non-empty _expo/assets
 *   2. Missing vs/loader.js     → exit 1, error names the file
 *   3. Truncated vs/loader.js   → exit 1, "suspiciously small" message
 *   4. Missing _expo/ directory → exit 1, error names the directory
 *   5. Empty assets/ directory  → exit 1, "required directory is empty"
 *   6. Stale leftover in resources/web is wiped by re-sync (idempotency)
 *   7. --skip-mobile-build with no existing dist → exit 1, clear error
 *
 * No real network, no real expo. Total runtime ~1s.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REAL_REPO = path.resolve(__dirname, '..', '..')
const REAL_SCRIPT = path.join(REAL_REPO, 'apps', 'desktop', 'scripts', 'sync-web.mjs')

let passed = 0
let failed = 0
const tmpRoots: string[] = []

function ok(name: string): void {
  passed++
  console.log(`  \x1b[32m✓\x1b[0m ${name}`)
}
function bad(name: string, detail?: unknown): void {
  failed++
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${String(detail)}` : ''}`)
}

process.on('exit', () => {
  for (const dir of tmpRoots) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

// Sizes that pass the script's min-byte thresholds. Using a buffer of
// repeated 'x' is enough — sync-web.mjs only checks file size, not
// content semantics.
const BIG = (n: number) => Buffer.alloc(n, 'x').toString()

interface MakeFakeOptions {
  loaderBytes?: number | null // null = file absent
  editorMainJsBytes?: number | null
  editorMainCssBytes?: number | null
  indexHtmlBytes?: number | null
  includeExpo?: boolean
  expoEmpty?: boolean
  includeAssets?: boolean
  assetsEmpty?: boolean
  includeDist?: boolean
}

/** Build a fake repo and return paths. */
function makeFakeRepo(opts: MakeFakeOptions = {}): {
  root: string
  desktopDir: string
  webDir: string
} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shogo-sync-web-test-'))
  tmpRoots.push(root)

  const mobile = path.join(root, 'apps', 'mobile')
  const desktop = path.join(root, 'apps', 'desktop')
  const desktopScripts = path.join(desktop, 'scripts')
  const mobileDist = path.join(mobile, 'dist')

  mkdirSync(mobile, { recursive: true })
  mkdirSync(desktopScripts, { recursive: true })
  mkdirSync(path.join(desktop, 'resources'), { recursive: true })

  // Mobile package.json so sync-web's existence check passes.
  writeFileSync(
    path.join(mobile, 'package.json'),
    JSON.stringify({ name: 'mobile', scripts: { build: 'true' } }),
  )

  if (opts.includeDist !== false) {
    mkdirSync(path.join(mobileDist, 'vs', 'editor'), { recursive: true })

    if (opts.indexHtmlBytes !== null) {
      writeFileSync(path.join(mobileDist, 'index.html'), BIG(opts.indexHtmlBytes ?? 500))
    }
    if (opts.loaderBytes !== null) {
      writeFileSync(path.join(mobileDist, 'vs', 'loader.js'), BIG(opts.loaderBytes ?? 50_000))
    }
    if (opts.editorMainJsBytes !== null) {
      writeFileSync(
        path.join(mobileDist, 'vs', 'editor', 'editor.main.js'),
        BIG(opts.editorMainJsBytes ?? 90_000),
      )
    }
    if (opts.editorMainCssBytes !== null) {
      writeFileSync(
        path.join(mobileDist, 'vs', 'editor', 'editor.main.css'),
        BIG(opts.editorMainCssBytes ?? 300_000),
      )
    }

    if (opts.includeExpo !== false) {
      mkdirSync(path.join(mobileDist, '_expo'), { recursive: true })
      if (!opts.expoEmpty) {
        writeFileSync(path.join(mobileDist, '_expo', 'static.js'), 'x')
      }
    }
    if (opts.includeAssets !== false) {
      mkdirSync(path.join(mobileDist, 'assets'), { recursive: true })
      if (!opts.assetsEmpty) {
        writeFileSync(path.join(mobileDist, 'assets', 'icon.png'), 'x')
      }
    }
  }

  // Copy the real sync-web.mjs verbatim into the fake desktop. We don't
  // mutate it — we just want to exercise the actual production code path.
  cpSync(REAL_SCRIPT, path.join(desktopScripts, 'sync-web.mjs'))

  return {
    root,
    desktopDir: desktop,
    webDir: path.join(desktop, 'resources', 'web'),
  }
}

function runSync(desktopDir: string, args: string[] = ['--skip-mobile-build']): {
  status: number | null
  stdout: string
  stderr: string
  combined: string
} {
  const r = spawnSync('node', [path.join(desktopDir, 'scripts', 'sync-web.mjs'), ...args], {
    cwd: desktopDir,
    encoding: 'utf8',
  })
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    combined: (r.stdout ?? '') + (r.stderr ?? ''),
  }
}

// ---------------------------------------------------------------------------
console.log('sync-web.mjs')

// 1. Happy path
{
  const fake = makeFakeRepo()
  const r = runSync(fake.desktopDir)
  if (r.status !== 0) bad('happy path exits 0', `status=${r.status}\n${r.combined}`)
  else ok('happy path exits 0')
  if (!existsSync(path.join(fake.webDir, 'vs', 'loader.js'))) {
    bad('happy path copies vs/loader.js into resources/web')
  } else ok('happy path copies vs/loader.js into resources/web')
  if (!existsSync(path.join(fake.webDir, 'index.html'))) {
    bad('happy path copies index.html into resources/web')
  } else ok('happy path copies index.html into resources/web')
}

// 2. Missing vs/loader.js → exit 1 with clear error
{
  const fake = makeFakeRepo({ loaderBytes: null })
  const r = runSync(fake.desktopDir)
  if (r.status === 0) bad('missing loader.js fails', r.combined)
  else ok('missing loader.js fails (non-zero exit)')
  if (!r.combined.includes('vs/loader.js')) {
    bad('error names vs/loader.js', r.combined.slice(0, 500))
  } else ok('error names vs/loader.js')
  if (!r.combined.includes('missing required file')) {
    bad('error uses "missing required file" phrase')
  } else ok('error uses "missing required file" phrase')
}

// 3. Truncated vs/loader.js → exit 1 with "suspiciously small"
{
  const fake = makeFakeRepo({ loaderBytes: 500 }) // way below the 20_000 floor
  const r = runSync(fake.desktopDir)
  if (r.status === 0) bad('truncated loader.js fails', r.combined)
  else ok('truncated loader.js fails (non-zero exit)')
  if (!r.combined.includes('suspiciously small')) {
    bad('error uses "suspiciously small" phrase', r.combined.slice(0, 500))
  } else ok('error uses "suspiciously small" phrase')
}

// 4. Missing _expo directory → exit 1
{
  const fake = makeFakeRepo({ includeExpo: false })
  const r = runSync(fake.desktopDir)
  if (r.status === 0) bad('missing _expo/ fails', r.combined)
  else ok('missing _expo/ fails')
  if (!r.combined.includes('_expo')) bad('error names _expo')
  else ok('error names _expo')
}

// 5. Empty assets/ directory → exit 1
{
  const fake = makeFakeRepo({ assetsEmpty: true })
  const r = runSync(fake.desktopDir)
  if (r.status === 0) bad('empty assets/ fails', r.combined)
  else ok('empty assets/ fails')
  if (!r.combined.includes('empty')) bad('error mentions "empty"')
  else ok('error mentions "empty"')
}

// 6. Idempotency / stale-wipe — pre-populate resources/web with a marker
//    file that does NOT exist in dist/, then run sync. The marker MUST be
//    gone after sync (proves wipe-before-copy).
{
  const fake = makeFakeRepo()
  mkdirSync(fake.webDir, { recursive: true })
  writeFileSync(path.join(fake.webDir, 'stale-leftover.txt'), 'old data')
  const r = runSync(fake.desktopDir)
  if (r.status !== 0) bad('idempotent re-sync exits 0', r.combined)
  else ok('idempotent re-sync exits 0')
  if (existsSync(path.join(fake.webDir, 'stale-leftover.txt'))) {
    bad('stale leftover was NOT wiped')
  } else ok('stale leftover from previous build is wiped')
  if (!existsSync(path.join(fake.webDir, 'vs', 'loader.js'))) {
    bad('re-sync still copied vs/loader.js')
  } else ok('re-sync still copied vs/loader.js after wipe')
}

// 7. --skip-mobile-build with no existing dist → clear error
{
  const fake = makeFakeRepo({ includeDist: false })
  const r = runSync(fake.desktopDir)
  if (r.status === 0) bad('skip-mobile-build with no dist fails', r.combined)
  else ok('skip-mobile-build with no dist fails')
  if (!r.combined.includes('no existing build')) {
    bad('error explains the cause clearly', r.combined.slice(0, 500))
  } else ok('error explains the cause ("no existing build")')
}

// ---------------------------------------------------------------------------

console.log('')
if (failed > 0) {
  console.log(`\x1b[31m${failed} failed\x1b[0m, ${passed} passed`)
  process.exit(1)
}
console.log(`\x1b[32mall ${passed} tests passed\x1b[0m`)
