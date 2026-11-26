// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The cross-region publication has THREE hand-maintained lists of "tables that
 * are deliberately not published", and they must agree:
 *
 *   1. `EXCLUDED_TABLES` in `k8s/cnpg/logical-replication/replication-monitor.yaml`
 *      — the monitor's completeness/READDED checks.
 *   2. `INTENTIONALLY_UNPUBLISHED` in `scripts/check-publication-drift.ts`
 *      — the CI guard, also imported by `check-migration-derived-ids.ts`.
 *   3. `region_local` in `k8s/cnpg/logical-replication/exclude-region-local-tables.sql`
 *      — the array that actually drops the tables from the live publication.
 *
 * Each file carried a "keep this list in sync" comment and that did not stop
 * SHO-423 from adding `storage_usage_daily` to (3) and (2) only. The monitor
 * then reported the table as "missing from the publication" every 5 minutes
 * from 2026-11-25 07:50Z, and nothing else noticed — a page that was true in
 * form and wrong in fact, which is exactly how a real page gets ignored later
 * (SHO-592). A comment is not a test.
 *
 * So: parse the three real lists out of the real files and fail on any
 * difference. The parser is deliberately strict about each file's shape — if a
 * list is reformatted so this cannot read it, the test fails rather than
 * silently comparing nothing.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { INTENTIONALLY_UNPUBLISHED } from '../check-publication-drift'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

const MONITOR = 'k8s/cnpg/logical-replication/replication-monitor.yaml'
const SQL = 'k8s/cnpg/logical-replication/exclude-region-local-tables.sql'
const DRIFT = 'scripts/check-publication-drift.ts'

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8')
}

/** `EXCLUDED_TABLES="'storage_usage','proxy_turns'"` → ['storage_usage','proxy_turns'] */
export function parseMonitorExcluded(src: string): string[] {
  const m = src.match(/^\s*EXCLUDED_TABLES="([^"]*)"\s*$/m)
  if (!m) throw new Error(`could not find EXCLUDED_TABLES="…" in ${MONITOR}`)
  return m[1]
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const quoted = t.match(/^'(.*)'$/)
      if (!quoted) throw new Error(`EXCLUDED_TABLES entry is not a quoted name: ${t}`)
      return quoted[1]
    })
}

/** `region_local text[] := ARRAY['a', 'b'];` → ['a','b'] */
export function parseRegionLocal(src: string): string[] {
  const m = src.match(/region_local\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/)
  if (!m) throw new Error(`could not find region_local text[] := ARRAY[…] in ${SQL}`)
  return m[1]
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const quoted = t.match(/^'(.*)'$/)
      if (!quoted) throw new Error(`region_local entry is not a quoted name: ${t}`)
      return quoted[1]
    })
}

const sorted = (xs: readonly string[]) => [...xs].sort()
const sets = (xs: readonly string[]) => sorted(new Set(xs))

describe('region-local publication lists are the same list in all three files', () => {
  const monitor = parseMonitorExcluded(read(MONITOR))
  const sql = parseRegionLocal(read(SQL))
  const drift = [...INTENTIONALLY_UNPUBLISHED]

  it('parses all three lists (so a reformat cannot silently compare nothing)', () => {
    for (const [name, list] of [
      ['replication-monitor.yaml', monitor],
      ['exclude-region-local-tables.sql', sql],
      ['check-publication-drift.ts', drift],
    ] as const) {
      expect(list.length, `${name} parsed as empty`).toBeGreaterThan(0)
      for (const t of list) expect(t).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('the monitor excludes exactly the tables the SQL keeps region-local', () => {
    expect(sets(monitor)).toEqual(sets(sql))
  })

  it('the CI drift guard excludes exactly the tables the SQL keeps region-local', () => {
    expect(sets(drift)).toEqual(sets(sql))
  })

  it('still carries the region-local tables this class is about', () => {
    // A regression that EMPTIES all three at once would pass the equality
    // checks above, so pin the members whose absence re-opens a real incident.
    for (const table of ['storage_usage', 'storage_usage_daily', 'usage_wallets', 'proxy_turns']) {
      expect(sets(sql)).toContain(table)
    }
    // SHO-142 put this one BACK in the publication on purpose.
    expect(sets(sql)).not.toContain('device_version_events')
  })

  it('the monitor interpolates EXCLUDED_TABLES into both membership checks', () => {
    const src = read(MONITOR)
    const uses = src.match(/NOT IN \(\$\{EXCLUDED_TABLES\}\)/g) ?? []
    expect(uses.length).toBe(2)
    expect(src).toContain('tablename IN (${EXCLUDED_TABLES})')
  })
})

describe('check-publication-drift runs clean on the real checkout', () => {
  it('exits 0', () => {
    const proc = Bun.spawnSync(['bun', join(REPO_ROOT, DRIFT)], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(proc.stderr.toString()).toBe('')
    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString()).toContain('OK')
  })
})
