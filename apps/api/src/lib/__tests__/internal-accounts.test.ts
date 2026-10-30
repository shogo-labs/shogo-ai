// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  INTERNAL_EMAIL_CONTAINS,
  INTERNAL_EMAIL_ENDS_WITH,
  INTERNAL_EMAIL_PATTERNS,
  internalEmailClauses,
  isInternalEmail,
} from '../internal-accounts'

/**
 * The filter is what the analytics queries actually run, so the filter is what
 * the test has to exercise. Reading `endsWith('@getodin.')` as "the remaining
 * `@getodin.` is the whole match" is how 47 Odin accounts stayed inside every
 * Prisma-backed number while this suite was green.
 */
function matchesClause(email: string, clause: any): boolean {
  const filter = clause.email
  const address = email.toLowerCase()
  if (typeof filter.endsWith === 'string') return address.endsWith(filter.endsWith.toLowerCase())
  if (typeof filter.contains === 'string') return address.includes(filter.contains.toLowerCase())
  throw new Error(`unexpected clause: ${JSON.stringify(clause)}`)
}

const matchesAnyClause = (email: string) =>
  internalEmailClauses(true).some((clause) => matchesClause(email, clause))

describe('internal accounts', () => {
  test('covers both Odin domains, and any future one', () => {
    expect(isInternalEmail('russell@getodin.ai')).toBe(true)
    expect(isInternalEmail('russell@getodin.io')).toBe(true)
    expect(isInternalEmail('someone@getodin.dev')).toBe(true)
  })

  test('covers Shogo and the test domain', () => {
    expect(isInternalEmail('dev@shogo.ai')).toBe(true)
    expect(isInternalEmail('qa@test.shogo.ai')).toBe(true)
  })

  test('leaves real users alone, including lookalike domains', () => {
    expect(isInternalEmail('someone@gmail.com')).toBe(false)
    expect(isInternalEmail('someone@notshogo.ai')).toBe(false)
    expect(isInternalEmail('someone@notgetodin.com')).toBe(false)
    expect(isInternalEmail(null)).toBe(false)
  })

  test('the prisma filter matches every internal address, both Odin domains included', () => {
    for (const email of [
      'russell@getodin.ai',
      'russell@getodin.io',
      'dev@shogo.ai',
      'qa@test.shogo.ai',
      'Mixed.Case@GetOdin.AI',
    ]) {
      expect(matchesAnyClause(email), `${email} must be excluded`).toBe(true)
    }
  })

  test('the prisma filter leaves real users alone', () => {
    for (const email of [
      'someone@gmail.com',
      'someone@notshogo.ai',
      'someone@notgetodin.com',
      'getodin@gmail.com',
    ]) {
      expect(matchesAnyClause(email), `${email} must not be excluded`).toBe(false)
    }
  })

  test('any getodin.* domain is ours, in the filter and in SQL alike', () => {
    // `%@getodin.%` is a prefix match on the domain, so a hypothetical
    // `getodin.example.com` counts as internal too. That is deliberate: the
    // Prisma filter and the `LIKE`-based exclusion must agree, or the funnel
    // and the admin page would disagree about the same account.
    expect(matchesAnyClause('someone@getodin.example.com')).toBe(true)
    // Same answer from the SQL side, so the funnel can't disagree.
    const asLike = (email: string, pattern: string) =>
      new RegExp(
        `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`,
        'i',
      ).test(email)
    expect(asLike('someone@getodin.example.com', '%@getodin.%')).toBe(true)
  })

  test('split the patterns by what the filter can express', () => {
    // No LIKE wildcards survive in either list.
    for (const suffix of [...INTERNAL_EMAIL_ENDS_WITH, ...INTERNAL_EMAIL_CONTAINS]) {
      expect(suffix).not.toContain('%')
    }
    // A pattern that only ends in `%` is a real `endsWith`.
    expect(INTERNAL_EMAIL_ENDS_WITH).toEqual(['@test.shogo.ai', '@shogo.ai'])
    // `%@getodin.%` has an interior wildcard: `endsWith('@getodin.')` is false
    // for every Odin address, so it has to be a `contains`.
    expect(INTERNAL_EMAIL_CONTAINS).toEqual(['@getodin.'])
    expect(INTERNAL_EMAIL_ENDS_WITH as string[]).not.toContain('@getodin.')
    // The SQL side keeps the wildcard: it is a real `LIKE` pattern.
    expect(INTERNAL_EMAIL_PATTERNS).toContain('%@getodin.%')
  })
})
