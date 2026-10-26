// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hosted e2e quarantine registry.
 *
 * The nightly suite was red for 10+ consecutive nights after 2.0 shipped, so a
 * real regression was indistinguishable from known noise. A spec that cannot
 * be fixed right away goes here instead of staying red — with an owner and an
 * expiry, so quarantine is a loan, not a graveyard.
 *
 * Quarantined specs are excluded via `grepInvert` in e2e/playwright.config.ts
 * (set E2E_INCLUDE_QUARANTINED=1 to run them anyway). `bun run
 * check:e2e-quarantine` (CI) fails once an entry expires, is missing an owner,
 * or no longer matches a test title in its file.
 */

export interface QuarantineEntry {
  /** Spec path relative to e2e/staging, e.g. "workspace-switch.test.ts". */
  file: string
  /** Exact test title as passed to `test(...)`. */
  title: string
  /** GitHub handle accountable for fixing or deleting the spec. */
  owner: string
  /** Why it is quarantined (the failure, not "flaky"). */
  reason: string
  /** ISO date (YYYY-MM-DD); the CI check fails on or after this day. */
  expires: string
  /** Tracking issue URL. */
  issue?: string
}

/** Longest a spec may stay quarantined before it must be fixed or deleted. */
export const MAX_QUARANTINE_DAYS = 14

/**
 * Nothing is quarantined today. The 11 entries that expired on 2026-10-25 were
 * not flaky — they were three real bugs, fixed in SHO-207: the cloud
 * attachments route only existed in local mode, staging minted production
 * publish URLs, and the collision test raced a reservation that landed too late.
 * Keep this list empty unless a spec is genuinely broken and cannot be fixed.
 */
export const QUARANTINE: QuarantineEntry[] = []

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** `grepInvert` patterns for every quarantined title, or undefined when empty. */
export function quarantineGrepInvert(entries: QuarantineEntry[] = QUARANTINE): RegExp[] | undefined {
  if (entries.length === 0) return undefined
  return entries.map((e) => new RegExp(`${escapeRegExp(e.title)}$`))
}
