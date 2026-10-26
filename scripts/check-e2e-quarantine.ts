#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Fails when a hosted-e2e quarantine entry (e2e/staging/quarantine.ts) has
 * expired, lacks an owner/reason, exceeds MAX_QUARANTINE_DAYS, or no longer
 * matches a test title in its spec file. Keeps quarantine a short, owned loan
 * instead of a silent way to stop running a spec. Entries expiring within 7
 * days print a `::warning` (never a failure) so an expiry is a heads-up
 * instead of a red required check on the day.
 */

import { appendFileSync, existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import {
  MAX_QUARANTINE_DAYS,
  QUARANTINE,
  type QuarantineEntry,
} from '../e2e/staging/quarantine'
import { CRITICAL_PATH_SPECS } from '../e2e/staging/critical-path'

const DAY_MS = 24 * 60 * 60 * 1000

/** Whole days from `today` (UTC midnight) until `expires`, or NaN if unparseable. */
export function daysUntilExpiry(expires: string, today: Date): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) return NaN
  const target = Date.parse(`${expires}T00:00:00Z`)
  if (Number.isNaN(target)) return NaN
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  return Math.round((target - todayUtc) / DAY_MS)
}

/**
 * Entries expiring within `warnDays` days that have not expired yet. CI prints
 * these as `::warning` annotations so an expiry is a heads-up a week out
 * instead of a red required check on the day (2026-10-25: all 11 entries
 * expired at once and turned every PR red).
 */
export function quarantineWarnings(
  entries: QuarantineEntry[],
  opts: { today?: Date; warnDays?: number } = {},
): QuarantineEntry[] {
  const today = opts.today ?? new Date()
  const warnDays = opts.warnDays ?? 7
  return entries.filter((e) => {
    const days = daysUntilExpiry(e.expires, today)
    return !Number.isNaN(days) && days > 0 && days <= warnDays
  })
}

export function validateQuarantine(
  entries: QuarantineEntry[],
  opts: { today?: Date; specDir?: string; readSpec?: (path: string) => string | null } = {},
): string[] {
  const today = opts.today ?? new Date()
  const specDir = opts.specDir ?? resolve(import.meta.dir, '../e2e/staging')
  const readSpec =
    opts.readSpec ?? ((p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null))
  const errors: string[] = []

  for (const e of entries) {
    const label = `${e.file} › ${e.title}`
    if (!e.owner?.trim()) errors.push(`${label}: missing owner`)
    if (!e.reason?.trim()) errors.push(`${label}: missing reason`)

    const days = daysUntilExpiry(e.expires, today)
    if (Number.isNaN(days)) {
      errors.push(`${label}: expires must be YYYY-MM-DD (got "${e.expires}")`)
    } else if (days <= 0) {
      errors.push(`${label}: quarantine expired on ${e.expires} — fix the spec or delete it (owner: ${e.owner})`)
    } else if (days > MAX_QUARANTINE_DAYS) {
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

/** One-line description of an expiring entry, used in the annotation and summary. */
export function describeExpiringEntry(entry: QuarantineEntry, today: Date): string {
  const days = daysUntilExpiry(entry.expires, today)
  const day = days === 1 ? 'day' : 'days'
  return `${entry.file} › ${entry.title} expires ${entry.expires} (${days} ${day}, owner ${entry.owner})`
}

/** `::warning` workflow commands for entries about to expire. Never fails the job. */
export function quarantineWarningAnnotations(entries: QuarantineEntry[], today: Date): string[] {
  return entries.map(
    (e) =>
      `::warning file=e2e/staging/quarantine.ts,title=e2e quarantine expiring::${describeExpiringEntry(e, today)}`,
  )
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

  const today = new Date()
  const expiring = quarantineWarnings(QUARANTINE, { today })
  if (expiring.length > 0) {
    for (const line of quarantineWarningAnnotations(expiring, today)) console.log(line)
    const summary = process.env.GITHUB_STEP_SUMMARY
    if (summary) {
      const lines = expiring.map((e) => `- ${describeExpiringEntry(e, today)}`)
      appendFileSync(summary, `### ⚠️ e2e quarantine expiring\n\n${lines.join('\n')}\n\n`)
    }
  }

  console.log(
    `e2e quarantine OK (${QUARANTINE.length} quarantined, ${CRITICAL_PATH_SPECS.length} critical-path specs)`,
  )
}
