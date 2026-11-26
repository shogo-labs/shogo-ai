// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One-off backfill: copy every unexpired signup promo balance into a
 * `ShogoCreditGrant` row (SHO-572).
 *
 * Why a script and not a migration step
 * -------------------------------------
 * The schema change (CREATE TABLE) is DDL, which logical replication does not
 * carry, so it runs in every region's `migrate deploy`. The *data* copy is DML,
 * which IS replicated: `usage_wallets` and `shogo_credit_grants` are published
 * tables, so writing the rows inside the migration would mint the same grants in
 * every region — the SHO-344 outage shape, and `bun run check:migration-ids`
 * rejects it (RUNBOOK §3). The desktop SQLite tree is a single writer per
 * machine, so its migration carries the copy directly.
 *
 * So: run this ONCE against the US primary. The grants then replicate out.
 *
 * What it copies
 * --------------
 *   * wallets with `promoCreditUsd > 0` and an `promoCreditExpiresAt` in the
 *     future → one `signup` grant for exactly that balance, with the same
 *     expiry. Nothing else changes: the money is the same money, it is simply
 *     called Shogo credit now and can pay for Hoshi calls only.
 *   * expired or zero balances get nothing (they were unspendable anyway).
 *
 * Idempotent: the grant ref is `signup:<workspaceId>:migrated` and
 * `grantShogoCredit` is idempotent on `(source, sourceRef)`, so a re-run is a
 * no-op and a partially-failed run can simply be run again.
 *
 * Run it as part of the deploy: until it has, an existing balance is not
 * spendable, and a user with live signup credit is blocked once their windows
 * are spent.
 *
 * Usage:
 *   bun scripts/backfill-shogo-credit-grants.ts            # dry run (default)
 *   bun scripts/backfill-shogo-credit-grants.ts --apply    # execute
 *   bun scripts/backfill-shogo-credit-grants.ts --apply --force  # skip region guard
 */

import { prisma } from '../apps/api/src/lib/prisma'
import { grantShogoCredit } from '../apps/api/src/services/shogo-credit.service'

const PRIMARY_REGION = 'us-ashburn-1'
const BATCH = 500

const args = new Set(process.argv.slice(2))
const APPLY = args.has('--apply')
const FORCE = args.has('--force')

/** Every wallet that still holds unexpired signup credit. */
function dueWallets(now: Date, cursor: string | null) {
  return prisma.usageWallet.findMany({
    where: { promoCreditUsd: { gt: 0 }, promoCreditExpiresAt: { gt: now } },
    select: { workspaceId: true, promoCreditUsd: true, promoCreditExpiresAt: true },
    orderBy: { workspaceId: 'asc' },
    take: BATCH,
    ...(cursor ? { cursor: { workspaceId: cursor }, skip: 1 } : {}),
  })
}

function grantRef(workspaceId: string): string {
  return `signup:${workspaceId}:migrated`
}

async function main() {
  const region = process.env.REGION_ID || null
  if (APPLY && region && region !== PRIMARY_REGION && !FORCE) {
    console.error(
      `[shogo-credit-backfill] Refusing to apply: REGION_ID=${region} is not the primary ${PRIMARY_REGION}.\n` +
        `Run this once against the US primary (its writes replicate to EU), or pass --force if you really mean to.`,
    )
    process.exit(1)
  }

  const now = new Date()
  console.log(`[shogo-credit-backfill] mode=${APPLY ? 'apply' : 'dry-run'}`)

  let cursor: string | null = null
  let scanned = 0
  let granted = 0
  let skipped = 0
  let totalUsd = 0

  for (;;) {
    const wallets = await dueWallets(now, cursor)
    if (wallets.length === 0) break
    for (const wallet of wallets) {
      scanned += 1
      const amountUsd = Math.max(0, wallet.promoCreditUsd)
      if (amountUsd <= 0 || !wallet.promoCreditExpiresAt) {
        skipped += 1
        continue
      }
      totalUsd += amountUsd
      if (!APPLY) {
        granted += 1
        continue
      }
      await grantShogoCredit({
        workspaceId: wallet.workspaceId,
        amountUsd,
        source: 'signup',
        sourceRef: grantRef(wallet.workspaceId),
        expiresAt: wallet.promoCreditExpiresAt,
      })
      granted += 1
    }
    cursor = wallets[wallets.length - 1].workspaceId
    if (wallets.length < BATCH) break
  }

  console.log(`  wallets scanned:  ${scanned}`)
  console.log(`  grants ${APPLY ? 'written' : 'to write'}: ${granted}`)
  console.log(`  credit migrated:  $${totalUsd.toFixed(2)}`)
  if (skipped > 0) console.log(`  skipped (no live amount): ${skipped}`)

  if (!APPLY && granted > 0) {
    console.log('\n[shogo-credit-backfill] dry run — re-run with --apply to write these grants.')
  } else if (granted === 0) {
    console.log('[shogo-credit-backfill] nothing to do.')
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('[shogo-credit-backfill] failed:', err)
  process.exit(1)
})
