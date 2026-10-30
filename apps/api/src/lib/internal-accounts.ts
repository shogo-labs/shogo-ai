// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which accounts are "internal" and must never be counted as users, activity or
 * spend in analytics.
 *
 * This list used to live in `analytics.service.ts` and was applied by one
 * helper, so the digest collector and several page queries silently counted
 * our own accounts. Prod had 46 `@getodin.ai` users and 1 `@getodin.io` user
 * inside the funnel before that was noticed — Odin is internal too, and the
 * pattern must cover every Odin domain (`@getodin.%`), not just `.ai`.
 *
 * Define the list once here and read it from everywhere.
 */

/**
 * Email suffix match, in the `LIKE` pattern shape the SQL branches already
 * use. `%@getodin.%` covers every Odin domain (`getodin.ai`, `getodin.io`, and
 * any future one); the `%` in the middle is a real wildcard there.
 */
export const INTERNAL_EMAIL_PATTERNS = [
  '%@test.shogo.ai',
  '%@shogo.ai',
  '%@getodin.%',
] as const

/**
 * The same patterns as literal suffixes, for Prisma filters. Strip every `%`
 * (the LIKE wildcards) rather than only the leading one: with `endsWith` the
 * remaining `@getodin.` is the whole match, whereas keeping the trailing `%`
 * would look for a literal percent sign in the address — which is exactly how
 * the old `contains` filter let Odin accounts through every Prisma query.
 */
export const INTERNAL_EMAIL_SUFFIXES = INTERNAL_EMAIL_PATTERNS.map((pattern) =>
  pattern.replace(/%/g, ''),
) as readonly string[]

/** `role: 'super_admin'` is internal too, alongside these addresses. */
export const INTERNAL_ROLE = 'super_admin'

/**
 * The patterns compiled for in-memory checks. `LIKE` and `endsWith` don't
 * agree on a suffix with a wildcard in the middle, so derive one regex per
 * pattern (`%` → `.*`) and anchor it.
 */
const INTERNAL_EMAIL_REGEXES = INTERNAL_EMAIL_PATTERNS.map((pattern) => {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
})

/** True when this address belongs to an internal account (Shogo, test or Odin). */
export function isInternalEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return INTERNAL_EMAIL_REGEXES.some((re) => re.test(email))
}
