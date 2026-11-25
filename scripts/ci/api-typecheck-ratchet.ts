#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Blocking typecheck for apps/api that tolerates the existing debt but not new
 * errors.
 *
 * apps/api sits in run-typecheck.ts's EXPECTED_FAIL set, so nothing in CI
 * type-checked it: SHO-459 shipped Prisma queries against fields and
 * relations the schema doesn't have, and production found them (a 500 on
 * /api/billing/workspace-plan that locked models on every grant workspace).
 *
 * Errors are keyed by file + code + message (no line/column, so unrelated
 * edits don't churn the baseline), with union members sorted inside the message
 * (`canonicalMessage`), and counted. The check fails when a key's
 * count goes above apps/api/typecheck-baseline.json.
 *
 *   bun scripts/ci/api-typecheck-ratchet.ts            # check
 *   bun scripts/ci/api-typecheck-ratchet.ts --update   # rewrite the baseline (after fixing errors)
 */
import { spawnSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, relative, resolve, isAbsolute } from 'path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const API_DIR = join(REPO_ROOT, 'apps', 'api')
const BASELINE_PATH = join(API_DIR, 'typecheck-baseline.json')
const LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/

export type Baseline = Record<string, number>

/** Repo-relative paths so the key is the same on every machine. */
function normalizePath(path: string): string {
  const abs = isAbsolute(path) ? path : resolve(API_DIR, path)
  return relative(REPO_ROOT, abs).split('\\').join('/')
}

// The gate protects apps/api/src — only errors whose repo-relative path starts
// here are counted. Two further classes of error are explicitly excluded even
// when they originate inside apps/api/src:
//
//   TS6059 rootDir / TS5097 allowImportingTsExtensions — appear whenever tsc
//   resolves a transitive import outside apps/api's rootDir. The key depends on
//   the worktree/symlink layout of the CI runner, so the same code produces
//   different baseline keys across environments (packages/X on main vs.
//   ../wt-*/packages/X on a dev machine).
//
//   dist-vs-src TS2322 identity mismatches — tsc picks up the dist/ build of an
//   SDK package on some machines (pre-built locally) and the src/ on others (CI
//   cold cache). The two types are structurally identical but nominally distinct,
//   so tsc reports a TS2322. The error can appear in apps/api/src itself when
//   cloud-content-sync.ts imports from the SDK and CI hasn't built it yet.
//   Detected by: TS2322 message contains both packages/X/src/ and packages/X/dist/
//   for the same X. A real TS2322 (wrong field name, wrong shape) will NOT match
//   this pattern.
//
//   Broad exclusion is intentional. A real cross-package break still surfaces at
//   the Prisma query, service call or route handler in apps/api/src — those errors
//   ARE counted.
const API_SRC_PREFIX = 'apps/api/src/'

const ROOT_DIR_CODES = new Set(['TS6059', 'TS5097'])

/**
 * tsc prints union members in the order their types were created, so an
 * unrelated file joining the program can turn `'400 | 404'` into `'404 | 400'`
 * and make the same error read as new (SHO-486). Sort them.
 */
export function canonicalMessage(message: string): string {
  return message.replace(/'([^']*\|[^']*)'/g, (_whole, union: string) =>
    `'${union
      .split('|')
      .map((part) => part.trim())
      .sort()
      .join(' | ')}'`,
  )
}

/** A baseline key carries its message too, so it is normalized the same way. */
export function canonicalKey(key: string): string {
  const m = /^(\S+) (TS\d+) (.*)$/.exec(key)
  if (!m) return key
  return `${m[1]} ${m[2]} ${canonicalMessage(m[3])}`
}

export function canonicalBaseline(baseline: Baseline): Baseline {
  const out: Baseline = {}
  for (const [key, n] of Object.entries(baseline)) {
    const code = /^(\S+) (TS\d+) /.exec(key)?.[2] ?? ''
    if (ROOT_DIR_CODES.has(code)) continue
    const canonical = canonicalKey(key)
    out[canonical] = (out[canonical] ?? 0) + n
  }
  return out
}

// Returns true when a TS2322 message is a src-vs-dist nominal identity mismatch
// (same package, one arm from /src/, the other from /dist/). These are build-
// environment noise, not real type errors.
function isSrcDistMismatch(code: string, message: string): boolean {
  if (code !== 'TS2322') return false
  const m = /packages\/([^/]+)\/src\//.exec(message)
  if (!m) return false
  return message.includes(`packages/${m[1]}/dist/`)
}

export function parseTscOutput(output: string): Baseline {
  const counts: Baseline = {}
  const lines = output.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = LINE.exec(lines[i].trimEnd())
    if (!m) continue
    const [, file, , , code, first] = m
    const normalized = normalizePath(file)
    // Only count errors in apps/api/src — see note above.
    if (!normalized.startsWith(API_SRC_PREFIX)) continue
    if (ROOT_DIR_CODES.has(code)) continue
    // tsc continues long messages on indented lines; keep only the first.
    const message = canonicalMessage(first.split(REPO_ROOT).join('<repo>').replace(/\s+/g, ' ').trim())
    // Exclude src-vs-dist TS2322 nominal identity noise — see note above.
    if (isSrcDistMismatch(code, message)) continue
    const key = `${normalized} ${code} ${message}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

export function regressions(baseline: Baseline, current: Baseline): string[] {
  return Object.entries(current)
    .filter(([key, n]) => n > (baseline[key] ?? 0))
    .map(([key, n]) => `+${n - (baseline[key] ?? 0)}  ${key}`)
    .sort()
}

function sortKeys(b: Baseline): Baseline {
  return Object.fromEntries(Object.entries(b).sort(([a], [z]) => a.localeCompare(z)))
}

function main() {
  const update = process.argv.includes('--update')
  const tsc = spawnSync('bunx', ['tsc', '--noEmit', '-p', '.'], {
    cwd: API_DIR,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const output = `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`
  if (tsc.error) {
    console.error('[api-typecheck] could not run tsc:', tsc.error)
    process.exit(2)
  }
  const current = parseTscOutput(output)
  const total = Object.values(current).reduce((a, b) => a + b, 0)
  if (tsc.status !== 0 && total === 0) {
    console.error('[api-typecheck] tsc failed without parseable errors:\n' + output.slice(-4000))
    process.exit(2)
  }

  if (update) {
    writeFileSync(BASELINE_PATH, JSON.stringify(sortKeys(current), null, 2) + '\n')
    console.log(`[api-typecheck] baseline written: ${total} known error(s) in ${Object.keys(current).length} key(s)`)
    return
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error(`[api-typecheck] ${relative(REPO_ROOT, BASELINE_PATH)} is missing. Computed baseline follows; commit it:`)
    console.log(JSON.stringify(sortKeys(current), null, 2))
    process.exit(1)
  }

  const baseline: Baseline = canonicalBaseline(JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')))
  const added = regressions(baseline, current)
  const known = Object.values(baseline).reduce((a, b) => a + b, 0)
  if (added.length) {
    console.error(`[api-typecheck] ${added.length} new type error(s) in apps/api (known debt: ${known}):`)
    for (const line of added) console.error('  ' + line)
    console.error('\nFix them. Prisma queries in particular must type-check: an invalid field or relation is a production 500.')
    process.exit(1)
  }
  const fixed = known - Object.entries(current).reduce((a, [k, n]) => a + Math.min(n, baseline[k] ?? 0), 0)
  console.log(`[api-typecheck] ok: no new errors (${total} known${fixed > 0 ? `, ${fixed} fixed — run with --update to lock that in` : ''})`)
}

if (import.meta.main) main()
