// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One-off backfill for `workspaces.homeRegion` (added in migration
 * 20260624140000_add_workspace_home_region).
 *
 * Why a script and not a migration step
 * -------------------------------------
 * The schema change (ADD COLUMN) is DDL, which logical replication does NOT
 * carry, so it runs in every region's `migrate deploy`. The *data* backfill is
 * DML (UPDATE), which IS replicated. If we backfilled inside the migration it
 * would run in all regions and update the same rows multiple times — the
 * exact cross-region write conflict this whole feature exists to prevent.
 *
 * So: run this ONCE against the US primary. The `homeRegion` values then
 * replicate out to EU like any other workspace column.
 *
 * Assignment
 * ----------
 * The originating region of pre-existing workspaces is unrecoverable after the
 * replication convergence, so we assign deterministically by a stable hash of
 * the workspace id, evenly across the regions. This is an initial
 * placement that can be re-tuned later (see the "Future" section of the plan).
 * Anything we somehow can't hash falls back to the primary, `us-ashburn-1`.
 *
 * Idempotent: only touches rows where `homeRegion IS NULL`, so re-runs are
 * safe no-ops.
 *
 * Usage:
 *   bun scripts/backfill-workspace-home-region.ts            # dry run (default)
 *   bun scripts/backfill-workspace-home-region.ts --apply    # execute the UPDATE
 *   bun scripts/backfill-workspace-home-region.ts --apply --force  # skip region guard
 */

import { prisma } from '../apps/api/src/lib/prisma'

const PRIMARY_REGION = 'us-ashburn-1'
const REGIONS = [PRIMARY_REGION, 'eu-frankfurt-1'] as const

const args = new Set(process.argv.slice(2))
const APPLY = args.has('--apply')
const FORCE = args.has('--force')

// Deterministic, even 2-way split keyed on the workspace id. `bit(32)::bigint`
// is unsigned (0..2^32-1) so the modulo is always 0/1. Mirrors the CASE used
// below; kept here only for the dry-run projection.
const BUCKET_SQL = `(('x' || substr(md5(id), 1, 8))::bit(32)::bigint % 2)`
const ASSIGN_SQL = `CASE ${BUCKET_SQL}
    WHEN 0 THEN '${REGIONS[0]}'
    WHEN 1 THEN '${REGIONS[1]}'
    ELSE '${PRIMARY_REGION}'
  END`

async function main() {
  // Region guard: this must run in the US primary so the UPDATE replicates out
  // from a single writer. Running it elsewhere would write the same rows in a
  // non-home region and conflict with the US writes.
  const region = process.env.REGION_ID || null
  if (APPLY && region && region !== PRIMARY_REGION && !FORCE) {
    console.error(
      `[home-region-backfill] Refusing to apply: REGION_ID=${region} is not the primary ${PRIMARY_REGION}.\n` +
        `Run this once against the US primary (its writes replicate to EU), or pass --force if you really mean to.`,
    )
    process.exit(1)
  }

  const [{ count: pending }] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM "workspaces" WHERE "homeRegion" IS NULL`,
  )
  const pendingNum = Number(pending)

  const projection = await prisma.$queryRawUnsafe<Array<{ region: string; count: bigint }>>(
    `SELECT ${ASSIGN_SQL} AS region, COUNT(*)::bigint AS count
     FROM "workspaces"
     WHERE "homeRegion" IS NULL
     GROUP BY 1
     ORDER BY 1`,
  )

  console.log(`[home-region-backfill] workspaces needing assignment: ${pendingNum}`)
  for (const row of projection) {
    console.log(`  ${row.region}: ${Number(row.count)}`)
  }

  if (pendingNum === 0) {
    console.log('[home-region-backfill] nothing to do.')
    process.exit(0)
  }

  if (!APPLY) {
    console.log('\n[home-region-backfill] dry run — re-run with --apply to write these assignments.')
    process.exit(0)
  }

  const updated = await prisma.$executeRawUnsafe(
    `UPDATE "workspaces" SET "homeRegion" = ${ASSIGN_SQL} WHERE "homeRegion" IS NULL`,
  )
  console.log(`[home-region-backfill] applied. rows updated: ${updated}`)
  process.exit(0)
}

main().catch((err) => {
  console.error('[home-region-backfill] failed:', err)
  process.exit(1)
})
