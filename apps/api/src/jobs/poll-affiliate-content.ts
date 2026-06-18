// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Periodic cron (every 4 hours) — polls every verified affiliate social account for new
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
 * Frequency vs. concurrency: the lock prevents *concurrent* sweeps, but it is
 * released as soon as a sweep finishes, so it does NOT stop the staggered
 * per-pod/per-region timers from each kicking off a fresh sweep. Polling
 * frequency is instead enforced inside `pollAllVerifiedAccounts`, which only
 * touches accounts whose `lastPolledAt` is older than
 * `affiliate.content.minPollIntervalMinutes` (default 4h). That keeps
 * EnsembleData unit spend at one provider sweep per account per interval no
 * matter how many pods are running or how often their timers fire.
 */

import { withGlobalJobLock } from '../lib/global-job-lock'
import {
  pollAllVerifiedAccounts,
  type PollAllSummary,
} from '../services/affiliate-content.service'

export interface PollAffiliateContentSummary extends Partial<PollAllSummary> {
  lockSkipped?: boolean
}

export async function runPollAffiliateContent(
  opts: { now?: Date } = {},
): Promise<PollAffiliateContentSummary> {
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
 * Schedule the content poll. Every 4 hours by default — keeps EnsembleData
 * unit spend bounded (one provider sweep per verified account per cycle).
 * Override the interval via the argument in tests.
 */
export function startPollAffiliateContentCron(intervalMs: number = 4 * 60 * 60 * 1000) {
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
