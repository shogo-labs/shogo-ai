// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hourly cron — flips affiliate commissions from `pending` to
 * `approved` once their refund-hold window (default 30 days) has
 * elapsed. Approved commissions are eligible for the next payout
 * batch.
 *
 * Multi-region safety: wrapped in `withGlobalJobLock('approve-commissions')`
 * for the same reasons as `grant-monthly-refill` — `affiliate_commissions`
 * has a non-PK unique key on `(stripeInvoiceId, affiliateId, level)`,
 * and concurrent UPDATEs from multiple regions racing through the
 * `pending → approved` transition could trip the apply worker on a
 * shadow conflict. Exactly one region wins the lock per tick.
 *
 * Feature-flag gated: short-circuits when `SHOGO_AFFILIATES_NATIVE`
 * is unset so dev/test stacks without the affiliate rollout don't
 * incur the DB roundtrip on every tick.
 */

import { approveEligibleCommissions } from '../services/affiliate.service'
import { withGlobalJobLock } from '../lib/global-job-lock'

export interface ApproveEligibleCommissionsSummary {
  approved: number
  lockSkipped?: boolean
  flagDisabled?: boolean
}

export async function runApproveEligibleCommissions(
  opts: { now?: Date } = {},
): Promise<ApproveEligibleCommissionsSummary> {
  if (process.env.SHOGO_AFFILIATES_NATIVE !== 'true') {
    return { approved: 0, flagDisabled: true }
  }
  const now = opts.now ?? new Date()
  const lockResult = await withGlobalJobLock('approve-commissions', async () => {
    return approveEligibleCommissions(now)
  })
  if (!lockResult.acquired) {
    return { approved: 0, lockSkipped: true }
  }
  return lockResult.result
}

/**
 * Schedule the approval cron. Hourly by default — the refund hold is
 * measured in days (default 30) so an hourly granularity is plenty
 * and keeps mobile-dashboard pendings/approved counts fresh.
 */
export function startApproveEligibleCommissionsCron(
  intervalMs: number = 60 * 60 * 1000,
) {
  setTimeout(() => {
    runApproveEligibleCommissions().catch((err) =>
      console.error('[ApproveCommissions] initial run failed:', err),
    )
    setInterval(() => {
      runApproveEligibleCommissions().catch((err) =>
        console.error('[ApproveCommissions] periodic run failed:', err),
      )
    }, intervalMs)
  }, 30_000)
  console.log(
    `[ApproveCommissions] cron scheduled (every ${Math.round(intervalMs / 60000)}m)`,
  )
}
