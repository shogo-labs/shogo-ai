// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Guard the cross-region logical replication publication YAMLs against the
 * "stale hand-list" failure mode that caused #501 (api_keys + 25 other
 * tables silently absent from EU/India for weeks).
 *
 * Background
 * ----------
 * Each region has a `k8s/cnpg/production-{us,eu,india}-oci/platform-publication.yaml`
 * that defines a CNPG `Publication` CR mapping to a Postgres publication. The
 * old version of these files hand-listed every table:
 *
 *   target:
 *     objects:
 *       - table: { name: users }
 *       - table: { name: workspaces }
 *       ...
 *
 * That list has to be updated by hand every time `prisma migrate deploy`
 * adds a new model. For 26 tables in a row, nobody did. Cross-region
 * replication silently dropped the new tables, and any row written in US
 * never reached EU/India — including the API keys that desktop heartbeats
 * authenticate against.
 *
 * Fix
 * ---
 * The YAMLs now use `tablesInSchema: public`, which maps to
 * `CREATE PUBLICATION ... FOR TABLES IN SCHEMA public`. Postgres maintains
 * the publication membership itself: every current and future table in the
 * `public` schema is published, no YAML edits needed.
 *
 * This script enforces the new shape. It runs in CI on every PR and rejects
 * any change that would regress the publication YAML back to a hand-list.
 *
 * Checks
 * ------
 *   1. Each `platform-publication.yaml` exists.
 *   2. The `target.objects` list contains exactly one entry, and that entry
 *      is `tablesInSchema: public` (no `table:` entries).
 *   3. All three regional YAMLs are byte-identical except for the leading
 *      "EU/US/India" comment — the only legitimate variation. Any other
 *      difference (different cluster name, namespace, publication name,
 *      reclaim policy, …) is almost certainly a bug.
 *
 * Usage
 * -----
 *   bun scripts/check-publication-drift.ts
 *
 * Exit code is 0 on success, 1 on any violation.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REGIONS = ['us', 'eu', 'india'] as const
const REPO_ROOT = resolve(import.meta.dir, '..')

interface Violation {
  file: string
  message: string
}

function pubPath(region: (typeof REGIONS)[number]): string {
  return `k8s/cnpg/production-${region}-oci/platform-publication.yaml`
}

function readPub(region: (typeof REGIONS)[number]): string | null {
  const abs = resolve(REPO_ROOT, pubPath(region))
  if (!existsSync(abs)) return null
  return readFileSync(abs, 'utf-8')
}

/**
 * Strip the leading region-specific comment block so the three YAMLs can be
 * compared for structural equality. The comment ends at the first non-`#`,
 * non-blank line (i.e. the first manifest line, typically `apiVersion:`).
 */
function stripLeadingComments(src: string): string {
  const lines = src.split('\n')
  let i = 0
  while (i < lines.length && (lines[i].startsWith('#') || lines[i].trim() === '')) {
    i++
  }
  return lines.slice(i).join('\n')
}

function checkUsesTablesInSchema(file: string, src: string): Violation[] {
  const violations: Violation[] = []

  // Negative: no hand-listed `table:` entries should remain.
  if (/^\s*-\s*table:\s*\{/m.test(src)) {
    violations.push({
      file,
      message:
        'Found `- table: { name: ... }` entry. The publication must use ' +
        '`tablesInSchema: public` so it auto-includes new tables. ' +
        'See the file header for the rationale (issue #501).',
    })
  }

  // Positive: exactly one `tablesInSchema: public` entry.
  const matches = src.match(/^\s*-\s*tablesInSchema:\s*public\s*$/gm) ?? []
  if (matches.length === 0) {
    violations.push({
      file,
      message:
        'Missing `- tablesInSchema: public` under `spec.target.objects`. ' +
        'This is the only supported shape for the cross-region publication.',
    })
  } else if (matches.length > 1) {
    violations.push({
      file,
      message: `Found ${matches.length} \`tablesInSchema:\` entries; expected exactly 1.`,
    })
  }

  return violations
}

function checkRegionsIdentical(
  contents: Record<string, string>
): Violation[] {
  const violations: Violation[] = []
  const stripped: Record<string, string> = {}
  for (const [region, src] of Object.entries(contents)) {
    stripped[region] = stripLeadingComments(src)
  }
  const reference = stripped['us']
  for (const region of ['eu', 'india']) {
    if (stripped[region] !== reference) {
      violations.push({
        file: pubPath(region as (typeof REGIONS)[number]),
        message:
          `Manifest body differs from US (excluding the leading region-name ` +
          `comment). All three regional Publication CRs must be structurally ` +
          `identical — they're the same publication name, same cluster name, ` +
          `same target. Diff against ${pubPath('us')}.`,
      })
    }
  }
  return violations
}

function main(): number {
  const violations: Violation[] = []
  const contents: Record<string, string> = {}

  for (const region of REGIONS) {
    const file = pubPath(region)
    const src = readPub(region)
    if (src == null) {
      violations.push({ file, message: 'File missing.' })
      continue
    }
    contents[region] = src
    violations.push(...checkUsesTablesInSchema(file, src))
  }

  if (Object.keys(contents).length === REGIONS.length) {
    violations.push(...checkRegionsIdentical(contents))
  }

  if (violations.length === 0) {
    console.log(
      `[check-publication-drift] OK — all ${REGIONS.length} regional ` +
        `platform-publication.yaml files use \`tablesInSchema: public\` ` +
        `and are structurally identical.`
    )
    return 0
  }

  console.error('[check-publication-drift] FAIL')
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.message}`)
  }
  console.error(
    '\nThe replication publication is intentionally self-maintaining. See\n' +
      '`k8s/cnpg/logical-replication/RUNBOOK.md` for context, and #501 for the\n' +
      'incident this guard prevents.'
  )
  return 1
}

process.exit(main())
