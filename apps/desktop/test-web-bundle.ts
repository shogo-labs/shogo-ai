#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `src/web-bundle.ts` — the pure routing + integrity
 * logic behind the `shogo://app/` protocol handler. Run with:
 *
 *   cd apps/desktop && bun test-web-bundle.ts
 *
 * These pin the behaviour of the fix that closed the
 * fix/desktop-ide-tab-files-not-loading bug. Every assertion in here
 * maps to a concrete way the original symptom (Monaco editor stuck on
 * "Loading…") could regress:
 *
 *   - serving a file that exists  → file kind
 *   - asset-shaped path missing   → 404, NOT index.html  (the bug)
 *   - SPA route                   → index.html fallback   (regression guard)
 *   - .. traversal                → 404                   (security guard)
 *   - integrity check passes      → ok                    (happy path)
 *   - integrity check missing     → list of missing files
 *   - integrity check truncated   → flagged as truncated  (HTML-as-JS guard)
 *
 * No fs writes. No electron import. Runs in <50ms.
 */
import {
  REQUIRED_WEB_FILES,
  STATIC_ASSET_PREFIXES,
  routeShogoRequest,
  verifyWebBundleIntegrity,
  type IntegrityFileStat,
} from './src/web-bundle'

import path from 'node:path'

let passed = 0
let failed = 0

function ok(name: string): void {
  passed++
  console.log(`  \x1b[32m✓\x1b[0m ${name}`)
}
function bad(name: string, detail?: unknown): void {
  failed++
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${String(detail)}` : ''}`)
}
function assertEq<T>(name: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(name)
  else bad(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
function assertTrue(name: string, cond: boolean): void {
  if (cond) ok(name)
  else bad(name)
}

// ---------------------------------------------------------------------------
// routeShogoRequest
// ---------------------------------------------------------------------------
console.log('routeShogoRequest')

const WEB = '/opt/shogo/resources/web'

// A fake fs that only "has" the files we tell it about.
function fakeFs(paths: string[]) {
  const set = new Set(paths.map((p) => path.resolve(p)))
  return (p: string) => set.has(path.resolve(p))
}

// 1. File exists → served directly
{
  const decision = routeShogoRequest(
    '/index.html',
    WEB,
    fakeFs([path.join(WEB, 'index.html')]),
  )
  assertEq('serves an existing file by absolute path', decision, {
    kind: 'file',
    absolutePath: path.join(WEB, 'index.html'),
  })
}

// 2. Bare root → SPA fallback to index.html (no asset prefix to bypass)
{
  const decision = routeShogoRequest('/', WEB, fakeFs([]))
  assertEq('root path falls back to index.html', decision, {
    kind: 'spa-fallback',
    absolutePath: path.join(WEB, 'index.html'),
  })
}

// 3. SPA client-side route with no file on disk → fallback to index.html
{
  const decision = routeShogoRequest(
    '/projects/abc/files',
    WEB,
    fakeFs([]),
  )
  assertEq('unknown SPA route falls back to index.html', decision, {
    kind: 'spa-fallback',
    absolutePath: path.join(WEB, 'index.html'),
  })
}

// 4. THE BUG: missing vs/loader.js MUST return 404, not index.html fallthrough.
//    This is the exact assertion that, if it failed, would reintroduce the
//    "IDE editor stuck on Loading…" symptom.
for (const prefix of STATIC_ASSET_PREFIXES) {
  const urlPath = `/${prefix}does-not-exist.js`
  const decision = routeShogoRequest(urlPath, WEB, fakeFs([]))
  assertEq(
    `missing asset under /${prefix} returns 404 (not index.html fallthrough)`,
    decision,
    { kind: 'not-found', urlPath: `${prefix}does-not-exist.js` },
  )
}

// 5. Existing asset-prefix file is still served normally
{
  const decision = routeShogoRequest(
    '/vs/loader.js',
    WEB,
    fakeFs([path.join(WEB, 'vs', 'loader.js')]),
  )
  assertEq('existing vs/loader.js is served as file', decision, {
    kind: 'file',
    absolutePath: path.join(WEB, 'vs', 'loader.js'),
  })
}

// 6. Path-traversal attempt → not-found (refuses to escape webDir)
{
  const decision = routeShogoRequest(
    '/../../etc/passwd',
    WEB,
    // Pretend /etc/passwd exists on disk — the routing decision must still
    // refuse it because resolved path escapes webDir.
    fakeFs(['/etc/passwd']),
  )
  assertTrue(
    'path traversal is refused with not-found',
    decision.kind === 'not-found',
  )
}

// 7. Asset path WITHOUT leading slash (defensive — Electron normalizes to
//    pathname which always starts with /, but handler accepts both shapes)
{
  const decision = routeShogoRequest(
    'vs/missing.js',
    WEB,
    fakeFs([]),
  )
  assertEq('asset path without leading slash still 404s', decision, {
    kind: 'not-found',
    urlPath: 'vs/missing.js',
  })
}

// 8. Asset paths nested deeply still 404 instead of falling through
{
  const decision = routeShogoRequest(
    '/vs/editor/editor.main.js',
    WEB,
    fakeFs([]),
  )
  assertEq('deeply-nested missing vs asset 404s', decision, {
    kind: 'not-found',
    urlPath: 'vs/editor/editor.main.js',
  })
}

// 9. The four STATIC_ASSET_PREFIXES are exactly the documented set —
//    catches accidental deletion / typos
assertEq(
  'STATIC_ASSET_PREFIXES is the documented contract',
  [...STATIC_ASSET_PREFIXES],
  ['vs/', '_expo/', 'assets/', 'static/'],
)

// ---------------------------------------------------------------------------
// verifyWebBundleIntegrity
// ---------------------------------------------------------------------------
console.log('verifyWebBundleIntegrity')

function fakeStat(
  files: Record<string, IntegrityFileStat>,
): (p: string) => IntegrityFileStat {
  return (p: string) =>
    files[p] ?? { exists: false, isFile: false, size: 0 }
}

function statFile(size: number): IntegrityFileStat {
  return { exists: true, isFile: true, size }
}

// 10. Happy path — all files present with adequate size
{
  const files: Record<string, IntegrityFileStat> = {}
  for (const { rel, minBytes } of REQUIRED_WEB_FILES) {
    files[path.join(WEB, rel)] = statFile(minBytes * 10)
  }
  const result = verifyWebBundleIntegrity(WEB, fakeStat(files))
  assertEq('integrity ok when all files present', result, { ok: true })
}

// 11. Missing file → ok:false with that file listed
{
  const files: Record<string, IntegrityFileStat> = {}
  for (const { rel, minBytes } of REQUIRED_WEB_FILES) {
    if (rel !== path.join('vs', 'loader.js')) {
      files[path.join(WEB, rel)] = statFile(minBytes * 10)
    }
  }
  const result = verifyWebBundleIntegrity(WEB, fakeStat(files))
  assertTrue('integrity flags missing loader.js', !result.ok)
  if (!result.ok) {
    assertEq(
      'missing list contains vs/loader.js',
      result.missing,
      [path.join('vs', 'loader.js')],
    )
  }
}

// 12. Truncated file (e.g. served HTML instead of JS) → flagged
{
  const files: Record<string, IntegrityFileStat> = {}
  for (const { rel, minBytes } of REQUIRED_WEB_FILES) {
    files[path.join(WEB, rel)] = statFile(minBytes * 10)
  }
  // Replace loader.js with a tiny file (simulating HTML fallthrough writing
  // a ~400-byte index.html in its place).
  files[path.join(WEB, 'vs', 'loader.js')] = statFile(420)
  const result = verifyWebBundleIntegrity(WEB, fakeStat(files))
  assertTrue('integrity flags truncated loader.js as missing', !result.ok)
  if (!result.ok) {
    assertTrue(
      'truncation message names the file and shows byte counts',
      result.missing.some(
        (m) => m.includes('vs/loader.js') || m.includes(path.join('vs', 'loader.js')),
      ) && result.missing.some((m) => m.includes('truncated:')),
    )
  }
}

// 13. Directory in place of file → treated as missing
{
  const files: Record<string, IntegrityFileStat> = {}
  for (const { rel, minBytes } of REQUIRED_WEB_FILES) {
    files[path.join(WEB, rel)] = statFile(minBytes * 10)
  }
  files[path.join(WEB, 'index.html')] = { exists: true, isFile: false, size: 0 }
  const result = verifyWebBundleIntegrity(WEB, fakeStat(files))
  assertTrue('integrity treats directory-in-place-of-file as missing', !result.ok)
  if (!result.ok) {
    assertTrue(
      'missing list mentions index.html',
      result.missing.includes('index.html'),
    )
  }
}

// 14. Multiple missing files → all reported
{
  const result = verifyWebBundleIntegrity(WEB, fakeStat({}))
  assertTrue('integrity reports failure on empty webDir', !result.ok)
  if (!result.ok) {
    assertEq(
      'missing list lists every REQUIRED_WEB_FILES entry',
      result.missing.length,
      REQUIRED_WEB_FILES.length,
    )
  }
}

// ---------------------------------------------------------------------------

console.log('')
if (failed > 0) {
  console.log(`\x1b[31m${failed} failed\x1b[0m, ${passed} passed`)
  process.exit(1)
}
console.log(`\x1b[32mall ${passed} tests passed\x1b[0m`)
