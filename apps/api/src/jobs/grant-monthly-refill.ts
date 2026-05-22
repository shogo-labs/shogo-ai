// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Daily cron that refills the monthly USD allotment on free-tier
 * workspaces that have an active super-admin `WorkspaceGrant`.
 *
 * Paid workspaces are refilled by `allocateMonthlyIncluded` on the
 * Stripe `invoice.payment_succeeded` webhook (the grant is stacked there
 * already), so this job only operates on workspaces with no active
 * paid `Subscription`. The same logic also runs lazily inside
 * `consumeUsage` when a free workspace makes its first call after a
 * month boundary; this cron is the safety net for workspaces that go
 * an entire month without making any usage call (otherwise their
 * grant USD would never refill).
 *
 * Safe to re-run: `applyGrantMonthlyAllocation` only triggers on a
 * UTC-month rollover (we filter by `lastMonthlyReset < startOfMonthUtc`
 * before calling it).
 */

import { prisma } from '../lib/prisma'
import { applyGrantMonthlyAllocation } from '../services/billing.service'
import { withGlobalJobLock } from '../lib/global-job-lock'

function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0))
}

export interface GrantMonthlyRefillSummary {
  candidates: number
  refilled: number
  skipped: number
  failed: number
  period: Date
  /**
   * True when the global advisory lock was held by a peer region and
   * this region skipped the cycle entirely. The rest of the counters
   * are zeroed in that case.
   */
  lockSkipped?: boolean
}

/**
 * Multi-region safety: wrapped in `withGlobalJobLock('grant-monthly-refill')`
 * so that across all API replicas in US/EU/India exactly one writer
 * runs per tick. Without this, every region's daily tick concurrently
 * upserts on `usage_wallets.workspaceId` (a non-PK unique index),
 * which logical replication's `last_update_wins` cannot resolve and
 * which would poison the apply worker until manually unwedged — same
 * failure class as the 2026-05-21 `analytics_digests` incident. See
 * `apps/api/src/lib/global-job-lock.ts` for the lock contract.
 */
export async function runGrantMonthlyRefill(
  options: { now?: Date } = {},
): Promise<GrantMonthlyRefillSummary> {
  const now = options.now ?? new Date()
  const period = startOfMonthUtc(now)

  const lockResult = await withGlobalJobLock('grant-monthly-refill', async () => {
    // Find workspaces that have at least one currently-active grant that
    // contributes to the monthly allotment — either a monthly USD amount
    // or a `planId` that confers per-seat included USD — and no active
    // paid subscription. Seat-only grants (`freeSeats > 0`, no USD, no
    // planId) are excluded because their only effect is reducing the
    // Stripe seat quantity, which is irrelevant when there's no Stripe
    // subscription.
    const grants = await prisma.workspaceGrant.findMany({
      where: {
        startsAt: { lte: now },
        workspace: {
          subscriptions: {
            none: { status: { in: ['active', 'trialing'] } },
          },
        },
        AND: [
          { OR: [{ monthlyIncludedUsd: { gt: 0 } }, { planId: { not: null } }] },
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        ],
      },
      select: { workspaceId: true },
    })
    const workspaceIds = Array.from(new Set(grants.map((g) => g.workspaceId)))

    const summary: GrantMonthlyRefillSummary = {
      candidates: workspaceIds.length,
      refilled: 0,
      skipped: 0,
      failed: 0,
      period,
    }

    for (const workspaceId of workspaceIds) {
      try {
        const wallet = await prisma.usageWallet.findUnique({
          where: { workspaceId },
          select: { lastMonthlyReset: true },
        })
        // No wallet yet -> `allocateFreeWallet` will seed it with the grant
        // amount the first time the workspace consumes anything; nothing to
        // do here.
        if (!wallet) {
          summary.skipped += 1
          continue
        }
        if (wallet.lastMonthlyReset >= period) {
          summary.skipped += 1
          continue
        }
        await applyGrantMonthlyAllocation(workspaceId, now)
        summary.refilled += 1
      } catch (err) {
        summary.failed += 1
        console.error('[GrantRefill] unexpected error:', { workspaceId, err })
      }
    }

    if (summary.candidates > 0) {
      console.log('[GrantRefill] cycle complete', summary)
    }
    return summary
  })

  if (lockResult.acquired) {
    return lockResult.result
  }
  return {
    candidates: 0,
    refilled: 0,
    skipped: 0,
    failed: 0,
    period,
    lockSkipped: true,
  }
}

/**
 * Start a setInterval-based scheduler that runs the grant refill once
 * per day. Mirrors `startVoiceMonthlyRebillCron` so the surface in
 * `server.ts` is consistent.
 */
export function startGrantMonthlyRefillCron(
  intervalMs: number = 24 * 60 * 60 * 1000,
) {
  setTimeout(() => {
    runGrantMonthlyRefill().catch((err) =>
      console.error('[GrantRefill] initial run failed:', err),
    )
    setInterval(() => {
      runGrantMonthlyRefill().catch((err) =>
        console.error('[GrantRefill] periodic run failed:', err),
      )
    }, intervalMs)
  }, 25_000)
  console.log(
    `[GrantRefill] grant monthly refill cron scheduled (every ${Math.round(
      intervalMs / 3600000,
    )}h)`,
  )
}
