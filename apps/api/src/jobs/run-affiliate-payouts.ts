// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Daily cron — batches approved affiliate commissions and pays out
 * via Stripe Connect (platform balance → Connect account → bank).
 *
 * Multi-region safety: wrapped in `withGlobalJobLock('affiliate-payouts')`
 * because the underlying service writes `affiliate_payouts` rows and
 * mutates per-affiliate counters; concurrent runs in two regions
 * could double-pay the same approved commission set.
 *
 * Failure isolation lives inside the service: one affiliate's
 * transfer error doesn't abort the batch. This cron is just the lock
 * + entry point.
 */

import { runAffiliatePayouts, type PayoutSummary } from '../services/affiliate.service'
import { withGlobalJobLock } from '../lib/global-job-lock'

export interface AffiliatePayoutsCronSummary extends Partial<PayoutSummary> {
  lockSkipped?: boolean
  flagDisabled?: boolean
}

export async function runAffiliatePayoutsCron(
  opts: { now?: Date } = {},
): Promise<AffiliatePayoutsCronSummary> {
  if (process.env.SHOGO_AFFILIATES_NATIVE !== 'true') {
    return { flagDisabled: true }
  }
  const now = opts.now ?? new Date()
  const lockResult = await withGlobalJobLock('affiliate-payouts', async () => {
    return runAffiliatePayouts(now)
  })
  if (!lockResult.acquired) {
    return { lockSkipped: true }
  }
  return lockResult.result
}

/**
 * Schedule the payout cron. Daily by default — Stripe payouts settle
 * over 2-3 business days; running more often than once a day just
 * fragments the per-affiliate batch without speeding settlement.
 */
export function startAffiliatePayoutsCron(
  intervalMs: number = 24 * 60 * 60 * 1000,
) {
  setTimeout(() => {
    runAffiliatePayoutsCron().catch((err) =>
      console.error('[AffiliatePayouts] initial run failed:', err),
    )
    setInterval(() => {
      runAffiliatePayoutsCron().catch((err) =>
        console.error('[AffiliatePayouts] periodic run failed:', err),
      )
    }, intervalMs)
  }, 40_000)
  console.log(
    `[AffiliatePayouts] cron scheduled (every ${Math.round(intervalMs / 3600000)}h)`,
  )
}
