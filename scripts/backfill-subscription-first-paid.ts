// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One-off backfill for `subscriptions.firstPaidAt` (SHO-409).
 *
 * Why a script and not a migration step
 * -------------------------------------
 * The schema change (ADD COLUMN) is DDL, which logical replication does NOT
 * carry, so it runs in every region's `migrate deploy`. The *data* backfill is
 * DML (UPDATE), which IS replicated. `subscriptions` is a published table, so
 * backfilling inside the migration would write the same logical rows in every
 * region — the SHO-344 outage shape, and `bun run check:migration-ids` rejects
 * it (RUNBOOK §3).
 *
 * So: run this ONCE against the US primary. The `firstPaidAt` values then
 * replicate out to EU like any other subscription column.
 *
 * What it sets
 * ------------
 *   * active / past_due subscriptions have been charged → `currentPeriodStart`.
 *   * a workspace whose wallet has paid overage blocks has demonstrably paid,
 *     even if its subscription status is not active/past_due.
 * Trialing and cancelled-trial rows stay NULL: their card has never been
 * charged, which is exactly the state the overage gate is meant to catch.
 *
 * Idempotent: only touches rows where `firstPaidAt IS NULL`, so re-runs are
 * safe no-ops.
 *
 * Usage:
 *   bun scripts/backfill-subscription-first-paid.ts            # dry run (default)
 *   bun scripts/backfill-subscription-first-paid.ts --apply    # execute the UPDATEs
 *   bun scripts/backfill-subscription-first-paid.ts --apply --force  # skip region guard
 */

import { prisma } from '../apps/api/src/lib/prisma'

const PRIMARY_REGION = 'us-ashburn-1'

const args = new Set(process.argv.slice(2))
const APPLY = args.has('--apply')
const FORCE = args.has('--force')

/** Non-trialing subscriptions have been charged. */
const BACKFILL_STATUS_SQL = `
UPDATE "subscriptions"
SET "firstPaidAt" = "currentPeriodStart"
WHERE "status" IN ('active', 'past_due')
  AND "firstPaidAt" IS NULL`

/** A workspace that has paid overage blocks has demonstrably paid. */
const BACKFILL_WALLET_SQL = `
UPDATE "subscriptions" s
SET "firstPaidAt" = s."currentPeriodStart"
FROM "usage_wallets" w
WHERE w."workspaceId" = s."workspaceId"
  AND w."overagePaidBlocks" > 0
  AND s."firstPaidAt" IS NULL
  AND s."status" <> 'trialing'`

const COUNT_STATUS_SQL = `
SELECT COUNT(*)::bigint AS count
FROM "subscriptions"
WHERE "status" IN ('active', 'past_due')
  AND "firstPaidAt" IS NULL`

const COUNT_WALLET_SQL = `
SELECT COUNT(*)::bigint AS count
FROM "subscriptions" s
JOIN "usage_wallets" w ON w."workspaceId" = s."workspaceId"
WHERE w."overagePaidBlocks" > 0
  AND s."firstPaidAt" IS NULL
  AND s."status" <> 'trialing'`

async function count(sql: string): Promise<number> {
  const [row] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(sql)
  return Number(row?.count ?? 0)
}

async function main() {
  // Region guard: this must run in the US primary so the UPDATE replicates out
  // from a single writer. Running it elsewhere would write the same rows in a
  // non-primary region and conflict with the US writes.
  const region = process.env.REGION_ID || null
  if (APPLY && region && region !== PRIMARY_REGION && !FORCE) {
    console.error(
      `[first-paid-backfill] Refusing to apply: REGION_ID=${region} is not the primary ${PRIMARY_REGION}.\n` +
        `Run this once against the US primary (its writes replicate to EU), or pass --force if you really mean to.`,
    )
    process.exit(1)
  }

  const byStatus = await count(COUNT_STATUS_SQL)
  const byWallet = await count(COUNT_WALLET_SQL)
  console.log(`[first-paid-backfill] mode=${APPLY ? 'apply' : 'dry-run'}`)
  console.log(`  active/past_due with firstPaidAt IS NULL: ${byStatus}`)
  console.log(`  paid-overage wallets with firstPaidAt IS NULL: ${byWallet}`)

  if (byStatus === 0 && byWallet === 0) {
    console.log('[first-paid-backfill] nothing to do.')
    process.exit(0)
  }

  if (!APPLY) {
    console.log('\n[first-paid-backfill] dry run — re-run with --apply to write these values.')
    process.exit(0)
  }

  const statusRows = await prisma.$executeRawUnsafe(BACKFILL_STATUS_SQL)
  const walletRows = await prisma.$executeRawUnsafe(BACKFILL_WALLET_SQL)
  console.log(
    `[first-paid-backfill] applied. rows updated: ${statusRows} (status), ${walletRows} (paid overage)`,
  )
  process.exit(0)
}

main().catch((err) => {
  console.error('[first-paid-backfill] failed:', err)
  process.exit(1)
})
