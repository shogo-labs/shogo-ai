// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * banUser / unbanUser — the single entry point for a real account ban.
 *
 * Used by the daily abuse-check job (bannedByUserId = null) and by the admin
 * Abuse tab (bannedByUserId = adminUserId). Each step is idempotent so
 * calling banUser twice is safe.
 *
 * SHO-459. Cloud-only: local mode is a no-op (desktop has no abuse job).
 */

import { prisma } from '../../lib/prisma'
import { invalidateSignupTrustHold } from '../../lib/signup-trust'
import { revokeSignupCredit } from '../signup-credit.service'

function isLocalMode(): boolean {
  return process.env.SHOGO_LOCAL_MODE === 'true'
}

/** Stop the runtimes of every project whose creator is a given user. */
async function stopUserRuntimes(userId: string): Promise<void> {
  try {
    const { getRuntimeManager } = await import('../../lib/runtime/manager')
    const mgr = getRuntimeManager()
    const projects: Array<{ id: string }> = await (prisma as any).project.findMany({
      where: { createdById: userId },
      select: { id: true },
    })
    await Promise.allSettled(projects.map((p) => mgr.stop(p.id, 'banned')))
  } catch (err) {
    console.warn('[banUser] stopUserRuntimes failed', err instanceof Error ? err.message : err)
  }
}

/** Cancel any active Stripe trial for workspaces the user owns. */
async function cancelUserTrials(userId: string): Promise<void> {
  try {
    // Lazily import the billing module that holds the Stripe singleton.
    // If Stripe is not configured this is a no-op.
    const billingMod = await import('../../services/billing.service').catch(() => null)
    const stripe = (billingMod as any)?.getStripeClient?.() ?? null
    if (!stripe) return

    const trials: Array<{ stripeSubscriptionId: string }> = await (prisma as any).trialRedemption.findMany({
      where: {
        status: 'trialing',
        workspace: { members: { some: { userId, role: 'owner', projectId: null } } },
      },
      select: { stripeSubscriptionId: true },
    })

    await Promise.allSettled(
      trials.map(async (t) => {
        try {
          await stripe.subscriptions.update(t.stripeSubscriptionId, {
            cancel_at_period_end: true,
            metadata: { cancellation_reason: 'account_banned' },
          })
          await (prisma as any).trialRedemption.updateMany({
            where: { stripeSubscriptionId: t.stripeSubscriptionId, status: 'trialing' },
            data: { status: 'ended' },
          })
        } catch (err) {
          console.warn('[banUser] cancel trial failed', t.stripeSubscriptionId, err instanceof Error ? err.message : err)
        }
      }),
    )
  } catch (err) {
    console.warn('[banUser] cancelUserTrials failed', err instanceof Error ? err.message : err)
  }
}

export interface BanResult {
  alreadyBanned: boolean
  sessionsDeleted: number
  keysRevoked: number
}

/**
 * Ban a user. Each step is idempotent.
 *
 * @param bannedByUserId  Null = auto (the daily job). An admin's userId otherwise.
 */
export async function banUser(params: {
  userId: string
  reason: string
  bannedByUserId: string | null
  /** Flag ids to mark as 'banned'. */
  flagIds?: string[]
}): Promise<BanResult> {
  if (isLocalMode()) return { alreadyBanned: false, sessionsDeleted: 0, keysRevoked: 0 }

  const db = prisma as any
  const { userId, reason, bannedByUserId, flagIds } = params

  // 1. Stamp bannedAt (idempotent — only writes on the first call).
  const existing = await db.user.findUnique({
    where: { id: userId },
    select: { bannedAt: true },
  })
  const alreadyBanned = !!existing?.bannedAt

  await db.user.update({
    where: { id: userId },
    data: {
      bannedAt: existing?.bannedAt ?? new Date(),
      banReason: reason,
      bannedByUserId,
    },
  })

  // 2. Delete sessions (idempotent).
  const { count: sessionsDeleted } = await db.session.deleteMany({ where: { userId } })

  // 3. Revoke every API key (idempotent — revokedAt stays once set).
  const { count: keysRevoked } = await db.apiKey.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })

  // 4. Revoke signup credit.
  try {
    await revokeSignupCredit({ userId, adminUserId: bannedByUserId ?? 'auto', reviewDecision: 'banned' })
  } catch (err) {
    console.warn('[banUser] revokeSignupCredit failed', err instanceof Error ? err.message : err)
  }

  // 5. Cancel Stripe trial (best-effort).
  await cancelUserTrials(userId)

  // 6. Stop runtimes (best-effort).
  await stopUserRuntimes(userId)

  // 7. Mark flags as banned.
  if (flagIds && flagIds.length > 0) {
    await db.abuseFlag.updateMany({
      where: { id: { in: flagIds } },
      data: { status: 'banned', decidedByUserId: bannedByUserId, decidedAt: new Date() },
    })
  }

  // 8. Invalidate signup-trust cache so the ban takes effect immediately.
  invalidateSignupTrustHold(userId)

  return { alreadyBanned, sessionsDeleted, keysRevoked }
}

export async function unbanUser(params: {
  userId: string
  adminUserId: string
}): Promise<void> {
  if (isLocalMode()) return

  const db = prisma as any
  const { userId, adminUserId } = params

  await db.user.update({
    where: { id: userId },
    data: { bannedAt: null, banReason: null, bannedByUserId: null },
  })

  // Clear flags linked to this user.
  await db.abuseFlag.updateMany({
    where: { userId, status: 'banned' },
    data: { status: 'cleared', decidedByUserId: adminUserId, decidedAt: new Date() },
  })

  // Keys stay revoked — the user mints new ones.
  invalidateSignupTrustHold(userId)
}
