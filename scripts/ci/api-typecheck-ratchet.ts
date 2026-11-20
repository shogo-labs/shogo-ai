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
 * edits don't churn the baseline) and counted. The check fails when a key's
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

export function parseTscOutput(output: string): Baseline {
  const counts: Baseline = {}
  const lines = output.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = LINE.exec(lines[i].trimEnd())
    if (!m) continue
    const [, file, , , code, first] = m
    // tsc continues long messages on indented lines; keep only the first.
    const message = first.split(REPO_ROOT).join('<repo>').replace(/\s+/g, ' ').trim()
    const key = `${normalizePath(file)} ${code} ${message}`
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

  const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'))
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
