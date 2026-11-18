// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `storage` — the daily meter for S3 bytes above a tier's storage allowance
 * (SHO-423).
 *
 * Every 6h pass writes one `StorageUsageDaily` row per workspace holding the
 * day's peak total and billable bytes (see `services/storage.service.ts`). This
 * job takes each COMPLETED, unbilled day of that history and charges
 * `max(0, billableBytes − allowanceBytes)` as GB-months, prorated by the days in
 * the month, against the usage wallet — the same house pattern as `disk_addon`
 * and `published_hosting`, so there is no new Stripe price.
 *
 * Two properties matter:
 *
 *  - **Home-region partitioned.** The write set is the workspace's wallet and its
 *    `StorageUsageDaily` rows, all home-region rows, so each region only bills
 *    its own workspaces (`homeRegionWorkspaceWhere`). A global lock would
 *    double-run across regions (SHO-345); `claimRegionPeriod` serialises the
 *    pods inside one region.
 *  - **Idempotent per day.** `billedAt` is claimed with a conditional update
 *    BEFORE the debit, so a rerun charges nothing. If the debit is refused the
 *    claim is rolled back so the next tick retries.
 *
 * Rollout: `STORAGE_BILLING_MODE=shadow` (default) records `chargedUsd` and
 * closes the day without debiting. `enforce` debits the wallet once.
 *
 * Overhead categories (`quarantine`, `vm_snapshots`) are never billable — they
 * are already excluded from `billableBytes` by the measurement pass.
 */

import { prisma } from '../lib/prisma'
import { claimRegionPeriod } from '../lib/region-period-claim'
import { homeRegionWorkspaceWhere } from '../lib/region'
import { storageBillingMode, storageDailyUsd } from '../config/storage-pricing'

const DAY_MS = 24 * 60 * 60 * 1000

/** Rows per tick. A backlog drains over consecutive ticks rather than one huge run. */
const BATCH = 2000

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export interface StorageBillSummary {
  days: number
  billed: number
  shadowed: number
  skipped: number
  failed: number
  totalUsd: number
  mode: 'shadow' | 'enforce'
  claimed: boolean
}

export async function runStorageUsageBill(now: Date = new Date()): Promise<StorageBillSummary> {
  const mode = storageBillingMode()
  const summary: StorageBillSummary = {
    days: 0,
    billed: 0,
    shadowed: 0,
    skipped: 0,
    failed: 0,
    totalUsd: 0,
    mode,
    claimed: false,
  }
  // Local/desktop has no charge and no job (the "local is unlimited" rule).
  if (process.env.SHOGO_LOCAL_MODE === 'true') return summary

  // One run per region per day. The query below is home-region scoped, so the
  // two regions' write sets are disjoint and no global lock is needed.
  if (!(await claimRegionPeriod('storage-usage-bill', DAY_MS, now))) return summary
  summary.claimed = true

  const home = homeRegionWorkspaceWhere()
  const pending = (await prisma.storageUsageDaily.findMany({
    where: {
      billedAt: null,
      // Only days that are over: today's row keeps growing until midnight UTC.
      day: { lt: startOfUtcDay(now) },
      ...(home ? { workspace: home } : {}),
    },
    orderBy: { day: 'asc' },
    take: BATCH,
    select: {
      id: true,
      workspaceId: true,
      day: true,
      billableBytes: true,
      allowanceBytes: true,
    },
  })) as Array<{
    id: string
    workspaceId: string
    day: Date
    billableBytes: bigint
    allowanceBytes: bigint
  }>

  summary.days = pending.length
  if (pending.length === 0) return summary

  const { consumeUsage } = await import('../services/billing.service')

  for (const row of pending) {
    try {
      const usd = storageDailyUsd(Number(row.billableBytes), Number(row.allowanceBytes), new Date(row.day))

      // Claim the day first: a conditional update means only one pod closes a
      // row, so a rerun can never double-charge.
      const claimed = await prisma.storageUsageDaily.updateMany({
        where: { id: row.id, billedAt: null },
        data: { billedAt: now, chargedUsd: usd },
      })
      if (claimed.count === 0) {
        summary.skipped += 1
        continue
      }

      if (mode === 'shadow') {
        // Recorded, not charged: the day is closed so flipping to `enforce`
        // does not retroactively bill the whole shadow window.
        summary.shadowed += 1
        summary.totalUsd += usd
        continue
      }

      if (usd <= 0) {
        summary.skipped += 1
        continue
      }

      const result = await consumeUsage({
        workspaceId: row.workspaceId,
        projectId: null,
        memberId: 'system',
        actionType: 'storage',
        billedUsd: usd,
        actionMetadata: {
          day: new Date(row.day).toISOString().slice(0, 10),
          billableBytes: Number(row.billableBytes),
          allowanceBytes: Number(row.allowanceBytes),
          overageBytes: Math.max(0, Number(row.billableBytes) - Number(row.allowanceBytes)),
        },
      })

      if (!result.success) {
        // Never block storage on funds: leave the day unbilled so the next tick
        // retries, and report it.
        await prisma.storageUsageDaily
          .updateMany({
            where: { id: row.id, billedAt: now },
            data: { billedAt: null, chargedUsd: null },
          })
          .catch(() => {})
        summary.failed += 1
        console.warn(
          `[StorageBill] charge refused for ${row.workspaceId} (${result.reason ?? result.error ?? 'unknown'})`,
        )
        continue
      }

      summary.billed += 1
      summary.totalUsd += usd
    } catch (error: any) {
      summary.failed += 1
      console.error('[StorageBill] day failed', {
        workspaceId: row.workspaceId,
        day: row.day,
        error: error?.message ?? error,
      })
    }
  }

  summary.totalUsd = Math.round(summary.totalUsd * 1e6) / 1e6
  return summary
}

/** Daily tick. The `billedAt` claim makes every extra tick a no-op. */
export function startStorageUsageBillCron(intervalMs: number = DAY_MS) {
  if (process.env.SHOGO_STORAGE_BILLING === 'false') {
    console.log('[StorageBill] disabled via SHOGO_STORAGE_BILLING=false')
    return
  }
  const tick = () =>
    runStorageUsageBill().catch((err) => console.error('[StorageBill] run failed:', err))
  setTimeout(() => {
    void tick()
    setInterval(tick, intervalMs)
  }, 5 * 60_000)
  console.log(
    `[StorageBill] storage meter scheduled (every ${Math.round(intervalMs / 3_600_000)}h, mode=${storageBillingMode()})`,
  )
}
