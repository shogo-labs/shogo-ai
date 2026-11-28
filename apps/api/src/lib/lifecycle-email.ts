// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Lifecycle (non-transactional) email: the opt-out gate, the exactly-once
 * ledger and the signed unsubscribe link (SHO-615).
 *
 * Three things every lifecycle sender shares:
 *
 *   - `lifecycleEmailAllowed(user)` — email is configured and the person has
 *     not opted out. Transactional mail (receipts, payment failures,
 *     trial-ending) never calls this; it must always be delivered.
 *   - `claimLifecycleEmail(kind, userId, key)` / `releaseLifecycleEmail(id)` —
 *     a once-and-only-once ledger so a Stripe webhook retry or a second cron
 *     tick cannot send twice. The row id is deterministic
 *     (`"<kind>:<userId>:<key>"`) so dedupe rides the primary key; there is no
 *     secondary unique index, which would poison the US/EU replication apply
 *     worker (see scripts/check-multiregion-cron-locks.ts).
 *   - `unsubscribeUrl(userId)` — the signed link behind the `List-Unsubscribe`
 *     header and the footer "unsubscribe". It is verified by
 *     `verifyUnsubscribeToken`; a forged or edited link is rejected.
 *
 * The signing key is `BETTER_AUTH_SECRET`, already present on every deployment
 * that can send mail.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { prisma } from './prisma'
import { isEmailConfigured } from '../services/email.service'

/** Domain separator so an unsubscribe token can never be replayed elsewhere. */
const UNSUBSCRIBE_KIND = 'lifecycle-unsubscribe'

function signingSecret(): string {
  const value = process.env.BETTER_AUTH_SECRET || ''
  if (!value) throw new Error('BETTER_AUTH_SECRET is required to sign lifecycle email links')
  return value
}

/** HMAC-SHA256 of the userId, base64url — the `t` in the unsubscribe link. */
function signUnsubscribe(userId: string): string {
  return createHmac('sha256', signingSecret()).update(`${UNSUBSCRIBE_KIND}.${userId}`).digest('base64url')
}

/** Where the app lives, for links inside lifecycle email. */
function appBaseUrl(): string {
  return (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://app.shogo.ai').replace(/\/$/, '')
}

/**
 * True when a lifecycle email may be sent to this user: email is configured and
 * the person has not opted out. `user` is the caller's already-fetched row (or a
 * minimal `{ lifecycleEmailOptOutAt }`); a missing row is treated as not
 * allowed.
 */
export function lifecycleEmailAllowed(
  user: { lifecycleEmailOptOutAt?: Date | null } | null | undefined,
): boolean {
  if (!isEmailConfigured()) return false
  if (!user) return false
  return !user.lifecycleEmailOptOutAt
}

/** Constant-time check of the `t` param against the userId it was signed for. */
export function verifyUnsubscribeToken(userId: string, token: string): boolean {
  if (!userId || !token) return false
  let expected: Buffer
  try {
    expected = Buffer.from(signUnsubscribe(userId))
  } catch {
    return false
  }
  const actual = Buffer.from(token)
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

/** The signed one-click unsubscribe link for a user. */
export function unsubscribeUrl(userId: string): string {
  const token = signUnsubscribe(userId)
  return `${appBaseUrl()}/api/email/unsubscribe?u=${encodeURIComponent(userId)}&t=${encodeURIComponent(token)}`
}

/**
 * Claim the right to send one lifecycle email. Returns the ledger id when the
 * claim succeeded, or `null` when this `(kind, user, key)` was already claimed —
 * a prior send, a webhook retry, or a second cron tick. Any error other than a
 * duplicate-primary-key conflict is rethrown.
 */
export async function claimLifecycleEmail(kind: string, userId: string, key: string): Promise<string | null> {
  const id = `${kind}:${userId}:${key}`
  try {
    await prisma.lifecycleEmailSend.create({ data: { id, userId, kind } })
    return id
  } catch (err: any) {
    if (err?.code === 'P2002') return null
    throw err
  }
}

/**
 * Release a claim whose send did not go out, so the next tick or retry can try
 * again. Best-effort: a release that fails only delays the next attempt.
 */
export async function releaseLifecycleEmail(id: string): Promise<void> {
  try {
    await prisma.lifecycleEmailSend.delete({ where: { id } })
  } catch (err: any) {
    // P2025 = already gone (nothing to release). Anything else is worth a log,
    // but it must never turn a failed send into a thrown error.
    if (err?.code !== 'P2025') {
      console.warn('[LifecycleEmail] release failed:', err?.message ?? err)
    }
  }
}
