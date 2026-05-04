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

function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0))
}

export interface GrantMonthlyRefillSummary {
  candidates: number
  refilled: number
  skipped: number
  failed: number
  period: Date
}

export async function runGrantMonthlyRefill(
  options: { now?: Date } = {},
): Promise<GrantMonthlyRefillSummary> {
  const now = options.now ?? new Date()
  const period = startOfMonthUtc(now)

  // Find workspaces that have at least one currently-active grant with a
  // monthly USD allotment and no active paid subscription.
  const grants = await prisma.workspaceGrant.findMany({
    where: {
      monthlyIncludedUsd: { gt: 0 },
      startsAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      workspace: {
        subscriptions: {
          none: { status: { in: ['active', 'trialing'] } },
        },
      },
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
