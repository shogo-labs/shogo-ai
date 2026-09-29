#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Fails when a hosted-e2e quarantine entry (e2e/staging/quarantine.ts) has
 * expired, lacks an owner/reason, exceeds MAX_QUARANTINE_DAYS, or no longer
 * matches a test title in its spec file. Keeps quarantine a short, owned loan
 * instead of a silent way to stop running a spec.
 */

import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import {
  MAX_QUARANTINE_DAYS,
  QUARANTINE,
  type QuarantineEntry,
} from '../e2e/staging/quarantine'
import { CRITICAL_PATH_SPECS } from '../e2e/staging/critical-path'

const DAY_MS = 24 * 60 * 60 * 1000

export function validateQuarantine(
  entries: QuarantineEntry[],
  opts: { today?: Date; specDir?: string; readSpec?: (path: string) => string | null } = {},
): string[] {
  const today = opts.today ?? new Date()
  const specDir = opts.specDir ?? resolve(import.meta.dir, '../e2e/staging')
  const readSpec =
    opts.readSpec ?? ((p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null))
  const errors: string[] = []
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())

  for (const e of entries) {
    const label = `${e.file} › ${e.title}`
    if (!e.owner?.trim()) errors.push(`${label}: missing owner`)
    if (!e.reason?.trim()) errors.push(`${label}: missing reason`)

    const expires = /^\d{4}-\d{2}-\d{2}$/.test(e.expires) ? Date.parse(`${e.expires}T00:00:00Z`) : NaN
    if (Number.isNaN(expires)) {
      errors.push(`${label}: expires must be YYYY-MM-DD (got "${e.expires}")`)
    } else if (expires <= todayUtc) {
      errors.push(`${label}: quarantine expired on ${e.expires} — fix the spec or delete it (owner: ${e.owner})`)
    } else if (expires - todayUtc > MAX_QUARANTINE_DAYS * DAY_MS) {
      errors.push(`${label}: expires more than ${MAX_QUARANTINE_DAYS} days out`)
    }

    const source = readSpec(join(specDir, e.file))
    if (source === null) {
      errors.push(`${label}: spec file not found`)
    } else if (!source.includes(JSON.stringify(e.title)) && !source.includes(`'${e.title}'`) && !source.includes(`\`${e.title}\``)) {
      errors.push(`${label}: no test with this exact title in ${e.file} (stale entry?)`)
    }
  }
  return errors
}

/**
 * The critical-path subset gates production, so a renamed/deleted spec must
 * fail CI rather than silently shrink the gate. A quarantined critical-path
 * test is also rejected: quarantine it out of the gate list first.
 */
export function validateCriticalPath(
  specs: readonly string[],
  quarantine: QuarantineEntry[],
  opts: { specDir?: string; exists?: (path: string) => boolean } = {},
): string[] {
  const specDir = opts.specDir ?? resolve(import.meta.dir, '../e2e/staging')
  const exists = opts.exists ?? existsSync
  const errors: string[] = []
  if (specs.length === 0) errors.push('critical-path: CRITICAL_PATH_SPECS is empty')
  for (const file of specs) {
    if (!exists(join(specDir, file))) errors.push(`critical-path: ${file} not found`)
    if (quarantine.some((q) => q.file === file)) {
      errors.push(`critical-path: ${file} has quarantined tests; remove it from CRITICAL_PATH_SPECS while quarantined`)
    }
  }
  return errors
}

if (import.meta.main) {
  const errors = [
    ...validateQuarantine(QUARANTINE),
    ...validateCriticalPath(CRITICAL_PATH_SPECS, QUARANTINE),
  ]
  if (errors.length > 0) {
    console.error('e2e quarantine check failed:')
    for (const err of errors) console.error(`  - ${err}`)
    process.exit(1)
  }
  console.log(
    `e2e quarantine OK (${QUARANTINE.length} quarantined, ${CRITICAL_PATH_SPECS.length} critical-path specs)`,
  )
}
