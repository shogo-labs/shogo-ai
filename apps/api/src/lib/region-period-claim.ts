// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "One run per region per period" claim for in-process crons.
 *
 * `withGlobalJobLock` is a `pg_advisory_lock` on THIS region's database, so all
 * it buys a once-a-minute job is mutual exclusion: every pod in a region boots
 * the same `setInterval` at its own offset, so pod A takes the lock, runs, and
 * releases it; pod B then takes it 3 s later and runs the same work again. The
 * cost is one full query per pod per tick (SHO-347: the team-chat sweeps ran
 * ~7.8 times a minute in US, not once).
 *
 * This claim is a per-region, per-period marker on `platform_settings`, written
 * by the region that owns the key. A pod that loses the claim skips the whole
 * tick, so a job runs once per region per period no matter how many pods boot.
 *
 * Two properties matter:
 *
 *  - It is region-scoped, never global. The keys embed `REGION_ID`, so US and EU
 *    claim independently and neither can block the other. That is only correct
 *    for a job whose query is already partition-scoped (`homeRegionWorkspaceWhere()`
 *    or equivalent), which is what makes each region's slice disjoint.
 *  - The conditional `UPDATE … WHERE value < bucket` is the authority. Postgres
 *    (and SQLite) take a row lock, so of N concurrent pods exactly one sees its
 *    bucket win. The `create` path is only for the first tick a key ever runs.
 *
 * On the desktop `platform_settings` is a plain SQLite table with one writer, so
 * the same code just works.
 */

import { prisma } from './prisma'
import { REGION_ID } from './region'

/** The period bucket `now` falls in, as a sortable ISO string. */
export function periodBucket(now: Date, periodMs: number): string {
  return new Date(Math.floor(now.getTime() / periodMs) * periodMs).toISOString()
}

/**
 * True when this caller should run the body for the current period. False means
 * another pod in this region already did.
 *
 * `regionId` is only for tests: in production it is always `REGION_ID`.
 */
export async function claimRegionPeriod(
  jobName: string,
  periodMs: number,
  now: Date = new Date(),
  regionId: string = REGION_ID,
): Promise<boolean> {
  const key = `${jobName}:last-claimed:${regionId}`
  const bucket = periodBucket(now, periodMs)
  try {
    // Steady state: the row exists, and exactly one caller can move it forward.
    const moved = await prisma.platformSetting.updateMany({
      where: { key, value: { lt: bucket } },
      data: { value: bucket },
    })
    if (moved.count > 0) return true
    // Either a peer already claimed this bucket, or this key has never run in
    // this region. Let the insert decide: one pod creates the row, the rest
    // collide on the primary key and lose.
    await prisma.platformSetting.create({ data: { key, value: bucket } })
    return true
  } catch (err: any) {
    // A primary-key collision on the create is a lost race, not an error: the
    // pod that inserted it owns the bucket.
    if (String(err?.code ?? '') === 'P2002') return false
    console.warn(`[RegionPeriodClaim] ${jobName} claim failed (running anyway):`, err?.message ?? err)
    // Never let the claim itself stop a job: a broken marker degrades to the
    // pre-claim behaviour, which is merely wasteful, not wrong.
    return true
  }
}
