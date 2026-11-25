// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Signup Shogo credit: grants, verification release, admin overrides, expiry.
 *
 * The money lives in `shogo_credit_grants` (one `signup` row per stage, see
 * `shogo-credit.service.ts`) on the signup's team workspace, which is where the
 * user builds. It is spent by `_consumeUsageTransaction` after the rolling
 * windows and before overage — and only on Hoshi models (SHO-572).
 *
 * Idempotency: `usage_wallets.promoCreditStage` only moves forward
 * (0 none -> 1 initial granted -> 2 fully granted). Every grant is a conditional
 * `updateMany` on the stage, so retries, duplicate verification links and
 * concurrent hooks can't pay out twice; the grant itself is keyed
 * `signup:<workspaceId>:stage<n>` and `grantShogoCredit` is idempotent on it.
 * The wallet's `promoCredit*` money columns are no longer written.
 */

import { prisma } from '../lib/prisma'
import {
  SIGNUP_CREDIT_TOTAL_USD,
  SIGNUP_CREDIT_TTL_DAYS,
  SIGNUP_CREDIT_VERIFIED_USD,
} from '../config/usage-plans'
import { allocateFreeWallet } from './billing.service'
import {
  grantShogoCredit,
  grantedShogoCreditUsd,
  revokeShogoCredit,
} from './shogo-credit.service'
import { homeWorkspaceIds } from '../lib/region'
import { invalidateSignupTrustHold } from '../lib/signup-trust'
import {
  collectSignupRiskFeatures,
  recordSignupRiskAssessment,
  type SignupRequestInfo,
} from './signup-risk.service'
import {
  scoreSignupRisk,
  type SignupProvider,
  type SignupRiskResult,
} from './signup-risk-scoring'

/** Credit decisions stored on `signup_risk_assessments.decision`. */
export const CREDIT_DECISIONS = {
  full: 'credit_full',
  initial: 'credit_initial',
  held: 'credit_held',
  none: 'no_credit',
  released: 'credit_released',
} as const

const STAGE_INITIAL = 1
const STAGE_FULL = 2

/** Team workspace for the user (the one they build in). Null if none exists. */
export async function findSignupCreditWorkspaceId(userId: string): Promise<string | null> {
  const member = await prisma.member.findFirst({
    where: {
      userId,
      role: 'owner',
      projectId: null,
      workspace: { kind: 'team', parentWorkspaceId: null },
    },
    select: { workspaceId: true },
    orderBy: { createdAt: 'asc' },
  })
  return member?.workspaceId ?? null
}

/** The grant ref for a signup stage: one payout per workspace per stage. */
function signupGrantRef(workspaceId: string, stage: number): string {
  return `signup:${workspaceId}:stage${stage}`
}

function signupExpiry(now: Date): Date {
  return new Date(now.getTime() + SIGNUP_CREDIT_TTL_DAYS * 24 * 60 * 60 * 1000)
}

/**
 * Add the signup credit for a stage as a Shogo credit grant and advance the
 * stage marker. The expiry is anchored to the first grant (stage 0 -> n) and is
 * not extended by later stages.
 * Returns true if this call granted anything.
 */
export async function grantPromoCredit(params: {
  workspaceId: string
  amountUsd: number
  toStage: typeof STAGE_INITIAL | typeof STAGE_FULL
  now?: Date
}): Promise<boolean> {
  const { workspaceId, amountUsd, toStage } = params
  const now = params.now ?? new Date()
  await allocateFreeWallet(workspaceId)

  const wallet = await prisma.usageWallet.findUnique({
    where: { workspaceId },
    select: { promoCreditExpiresAt: true },
  })
  // The 30-day expiry is anchored to the first stage and never extended by a
  // later one. `promoCreditExpiresAt` is a legacy (no longer money-bearing)
  // column, kept as the anchor so a migrated balance keeps its original expiry.
  const expiresAt = wallet?.promoCreditExpiresAt ?? signupExpiry(now)

  // Move the stage marker forward, conditionally, so concurrent grants (the
  // signup hook and a verification link) cannot pay the same stage twice.
  const first = await prisma.usageWallet.updateMany({
    where: { workspaceId, promoCreditStage: 0 },
    data: { promoCreditStage: toStage, promoCreditExpiresAt: expiresAt },
  })
  if (first.count === 0) {
    const next = await prisma.usageWallet.updateMany({
      where: { workspaceId, promoCreditStage: { gt: 0, lt: toStage } },
      data: { promoCreditStage: toStage },
    })
    if (next.count === 0) return false
  }

  await grantShogoCredit({
    workspaceId,
    amountUsd,
    source: 'signup',
    sourceRef: signupGrantRef(workspaceId, toStage),
    expiresAt,
  })
  return true
}

/**
 * Apply the new-signup decision: initial grant and decision record. Called from
 * the `user.create.after` hook once the team workspace exists.
 */
export async function applyInitialSignupCredit(params: {
  userId: string
  result: SignupRiskResult
  now?: Date
}): Promise<{ granted: boolean; workspaceId: string | null }> {
  const { result } = params
  const workspaceId = await findSignupCreditWorkspaceId(params.userId)
  // Held (medium) signups get nothing now. Granting $0 would still start the
  // 30-day expiry clock at signup instead of at verification.
  if (!workspaceId || result.decision === CREDIT_DECISIONS.none || result.initialCreditUsd <= 0) {
    return { granted: false, workspaceId }
  }

  // Verified at signup gets the full amount now. Otherwise stage 1 (the low
  // band's initial part; the rest waits for verification).
  const toStage = result.decision === CREDIT_DECISIONS.full ? STAGE_FULL : STAGE_INITIAL
  const granted = await grantPromoCredit({
    workspaceId,
    amountUsd: result.initialCreditUsd,
    toStage,
    now: params.now,
  })
  return { granted, workspaceId }
}

export interface VerificationReleaseOutcome {
  released: boolean
  reason:
    | 'no_assessment'
    | 'not_eligible'
    | 'rescored_high_risk'
    | 'rescored_below_high'
    | 'no_workspace'
    | 'released'
  band?: string
  amountUsd?: number
}

/**
 * Re-score a signup once its email is verified, then release the rest of the
 * credit if it still qualifies. The re-score uses the stored features (IP, device,
 * canonical email) and counts accounts created since signup, so a burst that
 * arrives after the first signup is caught here.
 *
 * A high-band account is re-scored even though it was never eligible for credit
 * (`no_credit`): the re-score is what lifts — or confirms — the trust hold in
 * `lib/signup-trust.ts` (SHO-416). Its credit decision stays `no_credit` either
 * way, because verification does not change the credit rules.
 */
export async function releaseSignupCreditOnVerification(params: {
  userId: string
  now?: Date
}): Promise<VerificationReleaseOutcome> {
  const now = params.now ?? new Date()
  const assessment = await prisma.signupRiskAssessment.findUnique({
    where: { userId: params.userId },
  })
  if (!assessment) return { released: false, reason: 'no_assessment' }
  const creditEligible =
    assessment.decision === CREDIT_DECISIONS.initial || assessment.decision === CREDIT_DECISIONS.held
  if (!creditEligible && assessment.band !== 'high') {
    return { released: false, reason: 'not_eligible' }
  }

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { email: true },
  })
  if (!user) return { released: false, reason: 'no_assessment' }

  const signals = (assessment.signals ?? {}) as {
    provider?: SignupProvider
    allowlisted?: boolean
    country?: string | null
  }
  const request: SignupRequestInfo = {
    ip: assessment.ip,
    ipPrefix: assessment.ipPrefix,
    country: assessment.country,
    deviceId: assessment.deviceId,
    e2eAllowlisted: signals.allowlisted === true,
  }
  const features = await collectSignupRiskFeatures({
    userId: params.userId,
    email: user.email,
    provider: signals.provider ?? 'credential',
    emailVerified: true,
    request,
    now,
  })
  const result = scoreSignupRisk(features)

  if (result.band === 'high' || (result.disposableDomain && !result.allowlisted)) {
    await recordSignupRiskAssessment({
      userId: params.userId,
      email: user.email,
      provider: signals.provider ?? 'credential',
      request,
      result,
      decision: CREDIT_DECISIONS.none,
    })
    return { released: false, reason: 'rescored_high_risk', band: result.band }
  }

  // Verified and no longer clustered. A high-band account was never eligible
  // for credit, so only the hold lifts — record the new band and stop.
  if (!creditEligible) {
    await recordSignupRiskAssessment({
      userId: params.userId,
      email: user.email,
      provider: signals.provider ?? 'credential',
      request,
      result,
      decision: CREDIT_DECISIONS.none,
    })
    return { released: false, reason: 'rescored_below_high', band: result.band }
  }

  const workspaceId = await findSignupCreditWorkspaceId(params.userId)
  if (!workspaceId) return { released: false, reason: 'no_workspace' }

  // Initial stage already granted $2 (low band) → release the rest. Held (medium)
  // had nothing yet → release the full amount.
  const amountUsd =
    assessment.decision === CREDIT_DECISIONS.initial ? SIGNUP_CREDIT_VERIFIED_USD : SIGNUP_CREDIT_TOTAL_USD
  await grantPromoCredit({ workspaceId, amountUsd, toStage: STAGE_FULL, now })
  await recordSignupRiskAssessment({
    userId: params.userId,
    email: user.email,
    provider: signals.provider ?? 'credential',
    request,
    result,
    decision: CREDIT_DECISIONS.released,
  })
  return { released: true, reason: 'released', band: result.band, amountUsd }
}

/**
 * Admin: bring the workspace up to the full credit regardless of band, including
 * after an earlier revoke. The granted total is the sum of `signup` grants net
 * of revokes, so the amount owed is simply the total minus what is already
 * granted; once approved it is 0 and a repeat approval is a no-op. Expired
 * credit gets a fresh expiry.
 */
export async function approveSignupCredit(params: {
  userId: string
  adminUserId: string
  now?: Date
}): Promise<{ granted: boolean; grantedUsd: number }> {
  const now = params.now ?? new Date()
  const workspaceId = await findSignupCreditWorkspaceId(params.userId)
  let grantedUsd = 0
  if (workspaceId) {
    await allocateFreeWallet(workspaceId)
    const wallet = await prisma.usageWallet.findUnique({
      where: { workspaceId },
      select: { promoCreditExpiresAt: true },
    })
    const alreadyGranted = await grantedShogoCreditUsd(prisma, workspaceId, 'signup')
    const owed = Math.max(0, SIGNUP_CREDIT_TOTAL_USD - alreadyGranted)
    if (owed > 0) {
      const live = wallet?.promoCreditExpiresAt && new Date(wallet.promoCreditExpiresAt).getTime() > now.getTime()
      const expiresAt = live ? new Date(wallet!.promoCreditExpiresAt!) : signupExpiry(now)
      // One grant per approval slot: the ref counts the signup grants already on
      // this workspace, so two concurrent approvals compute the same ref and
      // `grantShogoCredit` pays once (P2002 → existing row).
      const priorGrants = await prisma.shogoCreditGrant.count({
        where: { workspaceId, source: 'signup' },
      })
      const grant = await grantShogoCredit({
        workspaceId,
        amountUsd: owed,
        source: 'signup',
        sourceRef: `signup:${workspaceId}:admin:${priorGrants}`,
        expiresAt,
      })
      if (grant.amountUsd > 0) grantedUsd = grant.amountUsd
      await prisma.usageWallet.update({
        where: { workspaceId },
        data: { promoCreditStage: STAGE_FULL, promoCreditExpiresAt: expiresAt },
      })
    }
  }
  await prisma.signupRiskAssessment.updateMany({
    where: { userId: params.userId },
    data: {
      // The credit is settled; verification must not release it again.
      decision: CREDIT_DECISIONS.released,
      reviewDecision: 'approved',
      reviewedByUserId: params.adminUserId,
      reviewedAt: now,
    },
  })
  // An approval releases the trust hold too (SHO-416).
  invalidateSignupTrustHold(params.userId)
  return { granted: grantedUsd > 0, grantedUsd }
}

/**
 * Admin: zero every live `signup` grant and stop any future release. The
 * revoked amount comes off the granted total (so a later approval can restore
 * it) and is recorded as a zero-cost audit event.
 */
export async function revokeSignupCredit(params: {
  userId: string
  adminUserId: string
  reviewDecision?: 'revoked' | 'banned'
}): Promise<{ revokedUsd: number }> {
  const workspaceId = await findSignupCreditWorkspaceId(params.userId)
  let revokedUsd = 0
  if (workspaceId) {
    revokedUsd = await prisma.$transaction(async (tx) => {
      const balance = await revokeShogoCredit({ workspaceId, source: 'signup' }, tx)
      if (balance <= 0) return 0
      await recordPromoAuditEvent(tx, workspaceId, 'signup_credit_revoked', balance)
      return balance
    })
  }
  await prisma.signupRiskAssessment.updateMany({
    where: { userId: params.userId },
    data: {
      decision: CREDIT_DECISIONS.none,
      reviewDecision: params.reviewDecision ?? 'revoked',
      reviewedByUserId: params.adminUserId,
      reviewedAt: new Date(),
    },
  })
  // A revoke can change the hold (a revoked account is no longer approved).
  invalidateSignupTrustHold(params.userId)
  return { revokedUsd }
}

type PrismaTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/**
 * Zero-cost `UsageEvent` recording a promo balance change that wasn't a spend
 * (expiry, revoke). `billedUsd` is 0, so usage totals are unchanged. Attributed
 * to the workspace's first member; skipped (with a warning) if there is none.
 */
async function recordPromoAuditEvent(
  tx: PrismaTx,
  workspaceId: string,
  actionType: 'signup_credit_expired' | 'signup_credit_revoked',
  amountUsd: number,
): Promise<void> {
  const member = await tx.member.findFirst({
    where: { workspaceId, projectId: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!member) {
    console.warn('[signup-credit] Shogo credit change with no member to attribute the event to', {
      workspaceId,
      actionType,
    })
    return
  }
  await tx.usageEvent.create({
    data: {
      workspaceId,
      memberId: member.id,
      actionType,
      actionMetadata: { amountUsd },
      rawUsd: null,
      billedUsd: 0,
      source: 'promo',
      balanceBefore: amountUsd,
      balanceAfter: 0,
    },
  })
}

/**
 * Settle `signup` grants whose expiry has passed and record one zero-cost
 * `UsageEvent` per workspace for the audit trail. Returns the number of
 * workspaces settled.
 *
 * Expired credit is never spendable anyway (`availableShogoCredit` filters on
 * `expiresAt`), so this job is bookkeeping — missing a run delays the audit
 * row, not a charge.
 */
export async function expireSignupCredits(now: Date = new Date(), batchSize = 500): Promise<number> {
  const candidates = await prisma.shogoCreditGrant.findMany({
    where: {
      source: 'signup',
      remainingUsd: { gt: 0 },
      revokedAt: null,
      expiresAt: { lte: now },
    },
    select: { workspaceId: true },
    take: batchSize * 4,
  })
  const workspaceIds = [...new Set(candidates.map((g) => g.workspaceId))].slice(0, batchSize)
  // shogo_credit_grants is home-region partitioned with usage_wallets (never
  // replicated), so each region only settles the workspaces it owns.
  // `null` = single-region / local: all of them.
  const home = await homeWorkspaceIds(workspaceIds)
  const due = home ? workspaceIds.filter((id) => home.has(id)) : workspaceIds
  let expired = 0
  for (const workspaceId of due) {
    // The grant settle and its audit event commit together.
    const didExpire = await prisma.$transaction(async (tx) => {
      const grants = await tx.shogoCreditGrant.findMany({
        where: { workspaceId, source: 'signup', remainingUsd: { gt: 0 }, revokedAt: null, expiresAt: { lte: now } },
        select: { id: true, remainingUsd: true },
      })
      const balance = grants.reduce((sum, g) => sum + Math.max(0, g.remainingUsd), 0)
      if (balance <= 0) return false
      const res = await tx.shogoCreditGrant.updateMany({
        // Conditional on the rows read above: a concurrent settle (or a spend
        // that landed between the read and the write) makes this a no-op
        // instead of recording a stale amount.
        where: { id: { in: grants.map((g) => g.id) }, revokedAt: null, remainingUsd: { gt: 0 } },
        data: { remainingUsd: 0 },
      })
      if (res.count === 0) return false
      await recordPromoAuditEvent(tx, workspaceId, 'signup_credit_expired', balance)
      return true
    })
    if (didExpire) expired += 1
  }
  return expired
}
