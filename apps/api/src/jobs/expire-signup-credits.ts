// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hourly sweep that settles expired signup Shogo credit.
 *
 * Multi-region: home-region partitioned, not globally locked. `shogo_credit_grants`
 * is published, so every region holds a copy — but only the workspace's home
 * region may write its rows (the same single-writer rule as the wallet; see
 * `check-multiregion-cron-locks.ts` ACCEPTED_UNIQUE_KEYS). So each region
 * settles only the grants `homeWorkspaceIds` says it owns, and a global lock
 * would let one region fight a peer's copy under last_update_wins. Mirrors
 * `grant-monthly-refill.ts`; see `scripts/check-multiregion-cron-locks.ts`
 * (HOME_REGION_PARTITIONED).
 *
 * Expired credit is never spendable: `availableShogoCredit` already treats an
 * expired grant as 0, so this job only settles the stored balance and writes the
 * audit event. Missing a run delays bookkeeping, not charging.
 */

import { expireSignupCredits } from '../services/signup-credit.service'

export async function runExpireSignupCredits(options: { now?: Date } = {}): Promise<number> {
  const expired = await expireSignupCredits(options.now ?? new Date())
  if (expired > 0) {
    console.log('[SignupCredit] expired promo credit for wallets:', expired)
  }
  return expired
}

/** Hourly scheduler. Mirrors `startGrantMonthlyRefillCron` so `server.ts` wiring is consistent. */
export function startExpireSignupCreditsCron(intervalMs: number = 60 * 60 * 1000) {
  setTimeout(() => {
    runExpireSignupCredits().catch((err) =>
      console.error('[SignupCredit] initial expiry run failed:', err),
    )
    setInterval(() => {
      runExpireSignupCredits().catch((err) =>
        console.error('[SignupCredit] periodic expiry run failed:', err),
      )
    }, intervalMs)
  }, 35_000)
  console.log(
    `[SignupCredit] promo expiry cron scheduled (every ${Math.round(intervalMs / 60000)}m)`,
  )
}
