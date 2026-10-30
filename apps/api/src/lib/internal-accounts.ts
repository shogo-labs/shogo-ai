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
 * The same patterns as literal suffixes, for Prisma filters. Strip the LIKE
 * wildcards, then split by what the filter can actually express:
 *
 * - a pattern that only ends in `%` (`%@shogo.ai`) is a real `endsWith`;
 * - a pattern with a wildcard in the middle (`%@getodin.%`) is **not** — the
 *   literal body of that one is `@getodin.`, and `'russell@getodin.ai'
 *   .endsWith('@getodin.')` is false. `endsWith` therefore let all 46
 *   `@getodin.ai` accounts through every Prisma query that used this list.
 *   For those, `contains: '@getodin.'` is the correct filter (an email address
 *   has exactly one `@`, so the fragment can only match the domain).
 */
const partition = (patterns: readonly string[]) => {
  const endsWith: string[] = []
  const contains: string[] = []
  for (const pattern of patterns) {
    const body = pattern.replace(/^%/, '')
    if (body.endsWith('%')) {
      // Interior wildcard: match the literal prefix, anywhere in the address.
      contains.push(body.replace(/%/g, ''))
    } else {
      endsWith.push(body.replace(/%/g, ''))
    }
  }
  return { endsWith, contains }
}

const INTERNAL_MATCH = partition(INTERNAL_EMAIL_PATTERNS)

/** `endsWith` fragments: `@test.shogo.ai`, `@shogo.ai`. */
export const INTERNAL_EMAIL_ENDS_WITH = INTERNAL_MATCH.endsWith as readonly string[]

/** `contains` fragments for patterns with an interior wildcard: `@getodin.`. */
export const INTERNAL_EMAIL_CONTAINS = INTERNAL_MATCH.contains as readonly string[]

/**
 * The OR clauses that select internal addresses, in the shape Prisma wants.
 * Pass `insensitive` on Postgres; SQLite has no `mode` option.
 */
export function internalEmailClauses(insensitive: boolean) {
  const mode = insensitive ? ({ mode: 'insensitive' as const }) : {}
  return [
    ...INTERNAL_EMAIL_ENDS_WITH.map((suffix) => ({ email: { endsWith: suffix, ...mode } })),
    ...INTERNAL_EMAIL_CONTAINS.map((fragment) => ({ email: { contains: fragment, ...mode } })),
  ]
}

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
