// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hourly cron — polls every verified affiliate social account for new
 * posts and view counts, snapshots the metrics, and accrues CPM
 * commissions on the incremental views. Earnings are written as
 * `AffiliateCommission` rows (`source = 'content'`) so the existing
 * approval + payout crons settle them with no special-casing.
 *
 * Multi-region safety: wrapped in `withGlobalJobLock('poll-affiliate-content')`
 * — the body writes `affiliate_posts`, `affiliate_post_snapshots`, and
 * `affiliate_commissions` and bumps per-affiliate counters; two regions
 * polling the same account on the same tick would race on the view
 * delta and could double-snapshot / double-pay. Exactly one region wins
 * the lock per tick.
 *
 * Feature-gated: short-circuits unless the affiliate program env flag
 * `SHOGO_AFFILIATES_NATIVE` is 'true' AND the super-admin DB master toggle
 * `affiliate.content.enabled` is set (see isContentCpmEnabled), so stacks
 * without the content rollout never call the data provider or accrue.
 */

import { withGlobalJobLock } from '../lib/global-job-lock'
import {
  isContentCpmEnabled,
  pollAllVerifiedAccounts,
  type PollAllSummary,
} from '../services/affiliate-content.service'

export interface PollAffiliateContentSummary extends Partial<PollAllSummary> {
  lockSkipped?: boolean
  flagDisabled?: boolean
}

export async function runPollAffiliateContent(
  opts: { now?: Date } = {},
): Promise<PollAffiliateContentSummary> {
  if (!(await isContentCpmEnabled())) {
    return { flagDisabled: true }
  }
  const now = opts.now ?? new Date()
  const lockResult = await withGlobalJobLock('poll-affiliate-content', async () => {
    return pollAllVerifiedAccounts(now)
  })
  if (!lockResult.acquired) {
    return { lockSkipped: true }
  }
  return lockResult.result
}

/**
 * Schedule the content poll. Hourly by default — matches the cadence the
 * affiliate-facing spec calls for and keeps EnsembleData unit spend
 * bounded (one provider sweep per verified account per hour). Override
 * the interval via the argument in tests.
 */
export function startPollAffiliateContentCron(intervalMs: number = 60 * 60 * 1000) {
  setTimeout(() => {
    runPollAffiliateContent().catch((err) =>
      console.error('[PollAffiliateContent] initial run failed:', err),
    )
    setInterval(() => {
      runPollAffiliateContent().catch((err) =>
        console.error('[PollAffiliateContent] periodic run failed:', err),
      )
    }, intervalMs)
  }, 50_000)
  console.log(
    `[PollAffiliateContent] cron scheduled (every ${Math.round(intervalMs / 60000)}m)`,
  )
}
