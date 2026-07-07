// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One-off backfill for `users.homeRegion` (added in migration
 * 20260625150000_add_user_home_region).
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
 * replicate out to EU like any other user column.
 *
 * Assignment
 * ----------
 * Co-locate each user with their identity's "natural" region by reusing the
 * `homeRegion` of their earliest workspace (typically the personal workspace
 * created at signup). Users with no workspace (or whose workspaces are all
 * still NULL) fall back to a deterministic, even split keyed on the user
 * id, and finally to the primary, `us-ashburn-1`.
 *
 * Idempotent: only touches rows where `homeRegion IS NULL`, so re-runs are
 * safe no-ops. Run AFTER the workspace backfill so the co-location source is
 * populated.
 *
 * Usage:
 *   bun scripts/backfill-user-home-region.ts            # dry run (default)
 *   bun scripts/backfill-user-home-region.ts --apply    # execute the UPDATE
 *   bun scripts/backfill-user-home-region.ts --apply --force  # skip region guard
 */

import { prisma } from '../apps/api/src/lib/prisma'

const PRIMARY_REGION = 'us-ashburn-1'
const REGIONS = [PRIMARY_REGION, 'eu-frankfurt-1'] as const

const args = new Set(process.argv.slice(2))
const APPLY = args.has('--apply')
const FORCE = args.has('--force')

// Deterministic, even 2-way split keyed on the user id (fallback only).
// `bit(32)::bigint` is unsigned (0..2^32-1) so the modulo is always 0/1.
const BUCKET_SQL = `(('x' || substr(md5(id), 1, 8))::bit(32)::bigint % 2)`
const HASH_ASSIGN_SQL = `CASE ${BUCKET_SQL}
    WHEN 0 THEN '${REGIONS[0]}'
    WHEN 1 THEN '${REGIONS[1]}'
    ELSE '${PRIMARY_REGION}'
  END`

// Earliest workspace the user belongs to whose homeRegion is known. Correlated
// on the outer `users.id` — must be qualified as `"users"."id"` because the
// subquery's own `members`/`workspaces` both expose an `id` column, so a bare
// `id` here is ambiguous (the outer target is unaliased in both the UPDATE and
// the dry-run SELECT).
const WORKSPACE_HOME_SQL = `(
    SELECT w."homeRegion"
    FROM "members" m
    JOIN "workspaces" w ON w."id" = m."workspaceId"
    WHERE m."userId" = "users"."id" AND w."homeRegion" IS NOT NULL
    ORDER BY w."createdAt" ASC
    LIMIT 1
  )`

// Co-locate with the user's earliest workspace; fall back to a stable hash,
// then the primary.
const ASSIGN_SQL = `COALESCE(${WORKSPACE_HOME_SQL}, ${HASH_ASSIGN_SQL}, '${PRIMARY_REGION}')`

async function main() {
  // Region guard: this must run in the US primary so the UPDATE replicates out
  // from a single writer. Running it elsewhere would write the same rows in a
  // non-home region and conflict with the US writes.
  const region = process.env.REGION_ID || null
  if (APPLY && region && region !== PRIMARY_REGION && !FORCE) {
    console.error(
      `[user-home-region-backfill] Refusing to apply: REGION_ID=${region} is not the primary ${PRIMARY_REGION}.\n` +
        `Run this once against the US primary (its writes replicate to EU), or pass --force if you really mean to.`,
    )
    process.exit(1)
  }

  const [{ count: pending }] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM "users" WHERE "homeRegion" IS NULL`,
  )
  const pendingNum = Number(pending)

  const projection = await prisma.$queryRawUnsafe<Array<{ region: string; count: bigint }>>(
    `SELECT ${ASSIGN_SQL} AS region, COUNT(*)::bigint AS count
     FROM "users"
     WHERE "homeRegion" IS NULL
     GROUP BY 1
     ORDER BY 1`,
  )

  console.log(`[user-home-region-backfill] users needing assignment: ${pendingNum}`)
  for (const row of projection) {
    console.log(`  ${row.region}: ${Number(row.count)}`)
  }

  if (pendingNum === 0) {
    console.log('[user-home-region-backfill] nothing to do.')
    process.exit(0)
  }

  if (!APPLY) {
    console.log('\n[user-home-region-backfill] dry run — re-run with --apply to write these assignments.')
    process.exit(0)
  }

  const updated = await prisma.$executeRawUnsafe(
    `UPDATE "users" SET "homeRegion" = ${ASSIGN_SQL} WHERE "homeRegion" IS NULL`,
  )
  console.log(`[user-home-region-backfill] applied. rows updated: ${updated}`)
  process.exit(0)
}

main().catch((err) => {
  console.error('[user-home-region-backfill] failed:', err)
  process.exit(1)
})
