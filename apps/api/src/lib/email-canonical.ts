// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Email canonicalization for duplicate-account detection.
 *
 * Gmail ignores dots in the local part and treats `+tag` as an alias, so
 * `o.m.patil+x@gmail.com` and `ompatil@gmail.com` are the same mailbox. Other
 * providers commonly honour plus tags too. The canonical form is used only to
 * spot likely duplicate accounts. It is never used to log anyone in.
 *
 * Keep this in sync with the SQL backfill in
 * `prisma/migrations/20261016010000_signup_credit_trials_risk/migration.sql`.
 */

import { GMAIL_DOMAINS } from '../config/signup-risk-config'

/** Lowercased domain of an email, or `''` when there is no `@`. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 0) return ''
  return email.slice(at + 1).trim().toLowerCase()
}

/** Lowercased local part with any `+tag` removed (dots kept). */
export function emailLocalPartWithoutTag(email: string): string {
  const at = email.lastIndexOf('@')
  const local = at < 0 ? email : email.slice(0, at)
  return local.trim().toLowerCase().split('+')[0]
}

/**
 * Canonical form used for duplicate detection.
 *  - Gmail / Googlemail: dots removed, `+tag` removed, domain normalized to gmail.com.
 *  - Everything else: `+tag` removed, domain kept.
 */
export function canonicalizeEmail(email: string): string {
  const domain = emailDomain(email)
  if (!domain) return email.trim().toLowerCase()
  let local = emailLocalPartWithoutTag(email)
  if (GMAIL_DOMAINS.has(domain)) {
    return `${local.replace(/\./g, '')}@gmail.com`
  }
  return `${local}@${domain}`
}
