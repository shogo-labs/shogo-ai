// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One trust check for a signup, read by every surface that can spend money.
 *
 * On 2026-11-17 (PT) an API-key farm made ~1,600 accounts in about an hour.
 * `signup_risk_assessments` scored 1,486 of them `high`, but that only withheld
 * *promo* credit: each account still minted a working `shogo_sk_` key and drew
 * the free plan's included allowance. This module is the single place that
 * answers "is this account allowed to spend anything yet?" so the API-key
 * routes, the AI proxy and the billing preflight all agree.
 *
 * A hold is deliberately narrow:
 *   - local mode is a no-op (desktop has no signup, so it must not fork),
 *   - no assessment row means "as before" (legacy users, and a scoring failure
 *     must never lock someone out),
 *   - social sign-ins (Google/Apple) are verified by the provider,
 *   - an admin approval releases it.
 *
 * The farm's domains were custom `.dev`/`.com`, so the attacker could receive
 * mail and verify. "Verified" alone is therefore not trust: verification
 * re-scores the account (`releaseSignupCreditOnVerification`), and a high band
 * that survives the re-score moves to `account_review_required` instead of
 * being released.
 */

import { HTTPException } from 'hono/http-exception'
import { prisma } from './prisma'

/**
 * Read at call time, not module load: the test runner and the desktop bundle
 * both flip this, and a stale const would silently disable the gate.
 */
function isLocalMode(): boolean {
  return process.env.SHOGO_LOCAL_MODE === 'true'
}

/** Why an account is held. Doubles as the API error code. */
export type SignupTrustHold =
  | 'email_verification_required'
  | 'account_review_required'
  | 'account_banned'

export const SIGNUP_TRUST_MESSAGES: Record<SignupTrustHold, string> = {
  email_verification_required:
    'Verify your email to start using AI. Check your inbox for the verification link, or resend it from Settings.',
  account_review_required:
    'Your account is under review. Contact support if you think this is a mistake.',
  account_banned: 'Account suspended. Contact support@shogo.ai.',
}

/**
 * How long a resolved hold is reused. The check sits on the debit hot path, so
 * it must not cost a query per request; 60s is short enough that verifying an
 * email takes effect on the next turn in practice, and every path that changes
 * the answer (`afterEmailVerification`, admin approve/revoke) clears it
 * explicitly anyway.
 */
const CACHE_TTL_MS = 60_000

interface HoldEntry {
  hold: SignupTrustHold | null
  expiresAt: number
}

const holdCache = new Map<string, HoldEntry>()
const ownerCache = new Map<string, { userId: string | null; expiresAt: number }>()

/**
 * The reads a hold needs. Structural so `mintDeviceApiKey` can pass the client
 * it was handed (its callers and tests supply their own) instead of reaching
 * for the singleton.
 */
export interface SignupTrustClient {
  signupRiskAssessment: { findUnique: (args: any) => Promise<any> }
  user: { findUnique: (args: any) => Promise<any> }
  member: { findFirst: (args: any) => Promise<any> }
}

const defaultClient = prisma as unknown as SignupTrustClient

/** Test hook: drop every cached hold and owner lookup. */
export function _clearSignupTrustCacheForTests(): void {
  holdCache.clear()
  ownerCache.clear()
}

/**
 * Drop the cached hold for one user. Called when something changes the answer:
 * the email was verified, or an admin approved/revoked the account.
 */
export function invalidateSignupTrustHold(userId: string): void {
  holdCache.delete(userId)
}

/**
 * The hold on one user, or `null` when they may spend. One indexed lookup
 * (`signup_risk_assessments.userId` is unique) plus the `users` row, cached.
 */
export async function getSignupTrustHold(
  userId: string,
  client: SignupTrustClient = defaultClient,
): Promise<SignupTrustHold | null> {
  if (isLocalMode()) return null
  if (!userId) return null

  const now = Date.now()
  const cached = holdCache.get(userId)
  if (cached && cached.expiresAt > now) return cached.hold

  let hold: SignupTrustHold | null
  try {
    const [assessment, user] = await Promise.all([
      client.signupRiskAssessment.findUnique({
        where: { userId },
        select: { band: true, reviewDecision: true, signals: true },
      }),
      client.user.findUnique({ where: { id: userId }, select: { emailVerified: true, bannedAt: true } }),
    ])
    hold = resolveHold(assessment, user?.emailVerified === true, !!user?.bannedAt)
  } catch (err) {
    // Fail open. This read sits on the debit hot path, so a transient database
    // error must not stop every account from spending — the same reason a
    // missing assessment row is not a hold. Cached like a real answer so a
    // persistent failure logs once per TTL instead of once per request.
    console.warn('[signup-trust] hold lookup failed, treating as not held', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    hold = null
  }

  holdCache.set(userId, { hold, expiresAt: now + CACHE_TTL_MS })
  return hold
}

/** Pure decision, so every branch is unit-testable without a database. */
export function resolveHold(
  assessment: { band: string; reviewDecision: string | null; signals: unknown } | null,
  emailVerified: boolean,
  banned: boolean = false,
): SignupTrustHold | null {
  // A ban wins over every other branch, including approved/social.
  if (banned) return 'account_banned'
  if (!assessment) return null
  if (assessment.reviewDecision === 'approved') return null
  const signals = (assessment.signals ?? {}) as { provider?: string }
  if (signals.provider === 'social') return null
  if (assessment.band !== 'high') return null
  return emailVerified ? 'account_review_required' : 'email_verification_required'
}

/**
 * The owner of a billing workspace, cached. A personal workspace's owner is the
 * account whose signup credit and free allowance the wallet actually belongs
 * to, so a held owner must hold the wallet.
 */
async function billingWorkspaceOwnerId(
  billingWorkspaceId: string,
  client: SignupTrustClient,
): Promise<string | null> {
  const now = Date.now()
  const cached = ownerCache.get(billingWorkspaceId)
  if (cached && cached.expiresAt > now) return cached.userId

  let userId: string | null
  try {
    const owner = await client.member.findFirst({
      where: { workspaceId: billingWorkspaceId, role: 'owner', projectId: null },
      select: { userId: true },
      orderBy: { createdAt: 'asc' },
    })
    userId = owner?.userId ?? null
  } catch (err) {
    // Same fail-open rule as the hold itself: an owner lookup that errors must
    // not turn into a hold on the whole workspace.
    console.warn('[signup-trust] workspace owner lookup failed, treating as not held', {
      billingWorkspaceId,
      error: err instanceof Error ? err.message : String(err),
    })
    userId = null
  }
  ownerCache.set(billingWorkspaceId, { userId, expiresAt: now + CACHE_TTL_MS })
  return userId
}

/**
 * The hold that applies to a spend against `billingWorkspaceId`: the caller's
 * own hold, or the wallet owner's. `memberId` is a userId (the seat behind the
 * request), matching `checkUsageBalance`'s argument.
 */
export async function getBillingWorkspaceTrustHold(
  billingWorkspaceId: string,
  memberId?: string | null,
  client: SignupTrustClient = defaultClient,
): Promise<SignupTrustHold | null> {
  if (isLocalMode()) return null

  if (memberId) {
    const own = await getSignupTrustHold(memberId, client)
    if (own) return own
  }
  const ownerId = await billingWorkspaceOwnerId(billingWorkspaceId, client)
  if (!ownerId || ownerId === memberId) return null
  return getSignupTrustHold(ownerId, client)
}

/** The JSON body every held surface returns. */
export function signupTrustHoldPayload(hold: SignupTrustHold): {
  error: { code: SignupTrustHold; message: string }
} {
  return { error: { code: hold, message: SIGNUP_TRUST_MESSAGES[hold] } }
}

/**
 * Thrown from the AI proxy's auth validators, which return `null` for "no
 * credentials" and would otherwise turn a held key into a generic 401. The
 * server's `onError` passes `HTTPException` through untouched, so this reaches
 * the client as a 403 with the code.
 */
export class SignupTrustHoldError extends HTTPException {
  readonly hold: SignupTrustHold

  constructor(hold: SignupTrustHold) {
    super(403, {
      res: new Response(JSON.stringify(signupTrustHoldPayload(hold)), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    })
    this.hold = hold
  }
}
