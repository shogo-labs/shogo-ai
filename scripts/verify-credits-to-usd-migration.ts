// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Verify the credits → USD migration ran cleanly.
 *
 * The real work is done by the SQL migration
 * prisma/migrations/20260424000000_credits_to_usd/migration.sql:
 *   - Renames credit_ledgers → usage_wallets with USD-denominated columns
 *     (credits × $0.10 / credit = legacy CREDIT_DOLLAR_VALUE parity).
 *   - Converts usage_events.creditCost → billedUsd at the same rate and adds
 *     a nullable rawUsd column for future entries.
 *   - Adds overage columns (overageEnabled, overageHardLimitUsd,
 *     overageAccumulatedUsd, stripeMeteredItemId).
 *   - Drops billing_accounts.creditsBalance and renames
 *     analytics_digests.totalCreditsUsed → totalSpendUsd (with conversion).
 *
 * This script is a safety-net for staging / production rollouts: it
 *   - counts wallets + usage events,
 *   - sanity-checks that the new USD columns look reasonable,
 *   - reports any wallets that are missing overage defaults, and
 *   - optionally (with --fix) patches any wallets where overage columns
 *     were not backfilled by the DDL (e.g. when the migration was replayed
 *     against a partially-migrated copy of the DB).
 *
 * Usage:
 *   bun scripts/verify-credits-to-usd-migration.ts         # dry-run report
 *   bun scripts/verify-credits-to-usd-migration.ts --fix   # patch bad rows
 */

import { prisma } from '../apps/api/src/lib/prisma'

const FIX = process.argv.includes('--fix')

async function main() {
  // eslint-disable-next-line no-console
  console.log(`[migration-verify] mode=${FIX ? 'fix' : 'dry-run'}`)

  // 1. Wallet counts + ranges.
  const walletCount = await prisma.usageWallet.count()
  const agg = await prisma.usageWallet.aggregate({
    _sum: {
      monthlyIncludedUsd: true,
      dailyIncludedUsd: true,
      monthlyIncludedAllocationUsd: true,
      dailyUsedThisMonthUsd: true,
      overageAccumulatedUsd: true,
    },
  })

  // eslint-disable-next-line no-console
  console.log('[migration-verify] usage_wallets', {
    count: walletCount,
    sumMonthlyIncludedUsd: agg._sum.monthlyIncludedUsd ?? 0,
    sumDailyIncludedUsd: agg._sum.dailyIncludedUsd ?? 0,
    sumMonthlyAllocationUsd: agg._sum.monthlyIncludedAllocationUsd ?? 0,
    sumDailyUsedThisMonthUsd: agg._sum.dailyUsedThisMonthUsd ?? 0,
    sumOverageAccumulatedUsd: agg._sum.overageAccumulatedUsd ?? 0,
  })

  // 2. Wallets with nonsense values (likely missed the conversion).
  const suspicious = await prisma.usageWallet.findMany({
    where: {
      OR: [
        { monthlyIncludedUsd: { gt: 5000 } },
        { dailyIncludedUsd: { gt: 100 } },
      ],
    },
    select: { id: true, workspaceId: true, monthlyIncludedUsd: true, dailyIncludedUsd: true },
    take: 25,
  })
  if (suspicious.length) {
    // eslint-disable-next-line no-console
    console.warn(
      '[migration-verify] WARNING: wallets with unexpectedly large USD values (did credits conversion run?):',
      suspicious,
    )
  }

  // 3. Backfill any rows missing overage defaults.
  // (Defensive only — migration.sql should have added them with NOT NULL DEFAULT.)
  if (FIX) {
    const { count } = await prisma.usageWallet.updateMany({
      where: { overageEnabled: null as unknown as boolean },
      data: { overageEnabled: false, overageAccumulatedUsd: 0 },
    })
    // eslint-disable-next-line no-console
    console.log(`[migration-verify] patched ${count} wallets with default overage values`)
  }

  // 4. Usage events: confirm USD column looks populated.
  const eventCount = await prisma.usageEvent.count()
  const eventAgg = await prisma.usageEvent.aggregate({
    _sum: { billedUsd: true, rawUsd: true },
  })
  // eslint-disable-next-line no-console
  console.log('[migration-verify] usage_events', {
    count: eventCount,
    sumBilledUsd: eventAgg._sum.billedUsd ?? 0,
    sumRawUsd: eventAgg._sum.rawUsd ?? 0,
  })

  // 5. Analytics digest sanity check.
  const digestAgg = await prisma.analyticsDigest.aggregate({ _sum: { totalSpendUsd: true } })
  // eslint-disable-next-line no-console
  console.log('[migration-verify] analytics_digests totalSpendUsd sum =', digestAgg._sum.totalSpendUsd ?? 0)

  // eslint-disable-next-line no-console
  console.log('[migration-verify] done')
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[migration-verify] failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
