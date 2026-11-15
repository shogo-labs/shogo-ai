// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `disk_addon` — the daily meter for workspace drive above a tier's included
 * GiB (SHO-401).
 *
 * A workspace's tier includes a fixed amount of workspace drive
 * (`workspaceDiskIncludedGiB`). Anything above that — on any project drive, and
 * on the bare `ws:<id>` workspace runtime drive — is a paid per-GiB-month
 * add-on. This job charges it once per UTC day against the usage wallet, the
 * same house pattern as `published_hosting` and `voice_number_monthly`, so
 * there is no new Stripe price. Proration falls out of daily accrual.
 *
 * Two properties matter:
 *
 *  - **Home-region partitioned.** The write set is the workspace's wallet and
 *    its `diskAddonBilledThrough` watermark, both home-region rows, so each
 *    region only touches its own workspaces (`homeRegionWorkspaceWhere`). A
 *    global lock would double-run across regions (SHO-345); `claimRegionPeriod`
 *    serialises the pods inside one region.
 *  - **Idempotent per day.** The watermark is advanced with a conditional
 *    update BEFORE the debit, so a rerun the same day is a no-op. If the debit
 *    is refused (empty wallet) the watermark is rolled back so the next day
 *    retries — the drive is never shrunk and data is never touched.
 */

import { prisma } from '../lib/prisma'
import { claimRegionPeriod } from '../lib/region-period-claim'
import { homeRegionWorkspaceWhere } from '../lib/region'
import { diskAddonDailyUsd, DISK_ADDON_USD_PER_GIB_MONTH } from '../config/disk-pricing'
import {
  resolveWorkspaceDiskMiB,
  workspaceDiskIncludedGiB,
  type InstanceSizeName,
} from '../config/instance-sizes'

const DAY_MS = 24 * 60 * 60 * 1000

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

export interface DiskAddonSummary {
  workspaces: number
  charged: number
  skipped: number
  failed: number
  totalUsd: number
  claimed: boolean
}

/**
 * The add-on GiB a workspace is billed for: every project drive above the
 * tier's included amount, plus the bare workspace-runtime drive.
 */
export function workspaceAddonGiB(args: {
  instanceSize: InstanceSizeName
  canBuyAddon: boolean
  projectDiskGiB: Array<number | null | undefined>
  runtimeDiskGiB: number | null | undefined
}): number {
  const included = workspaceDiskIncludedGiB(args.instanceSize)
  const effective = (requested: number | null | undefined) =>
    resolveWorkspaceDiskMiB(requested, args.instanceSize, { canBuyAddon: args.canBuyAddon }) / 1024
  let addon = 0
  for (const p of args.projectDiskGiB) addon += Math.max(0, effective(p) - included)
  addon += Math.max(0, effective(args.runtimeDiskGiB) - included)
  return Math.round(addon * 10) / 10
}

export async function runDiskAddonDaily(now: Date = new Date()): Promise<DiskAddonSummary> {
  const summary: DiskAddonSummary = { workspaces: 0, charged: 0, skipped: 0, failed: 0, totalUsd: 0, claimed: false }
  // Local/desktop has no charge and no job (the "local is unlimited" rule).
  if (process.env.SHOGO_LOCAL_MODE === 'true') return summary

  // One run per region per day. The query below is home-region scoped, so the
  // two regions' write sets are disjoint and no global lock is needed.
  if (!(await claimRegionPeriod('disk-addon-daily', DAY_MS, now))) return summary
  summary.claimed = true

  const today = startOfUtcDay(now)
  const home = homeRegionWorkspaceWhere()
  const workspaces = await prisma.workspace.findMany({
    where: { ...(home ?? {}), parentWorkspaceId: null },
    select: {
      id: true,
      instanceSize: true,
      runtimeDiskGiB: true,
      diskAddonBilledThrough: true,
      projects: { select: { workspaceDiskGiB: true } },
    },
  })
  summary.workspaces = workspaces.length

  const { consumeUsage } = await import('../services/billing.service')
  const { resolveDiskAddonEligibility } = await import('../services/project-disk.service')

  for (const ws of workspaces) {
    try {
      // Already billed for today (or a later day) — a rerun is a no-op.
      if (ws.diskAddonBilledThrough && startOfUtcDay(ws.diskAddonBilledThrough) >= today) {
        summary.skipped += 1
        continue
      }
      const eligibility = await resolveDiskAddonEligibility(ws.id)
      const addonGiB = workspaceAddonGiB({
        instanceSize: (ws.instanceSize ?? 'micro') as InstanceSizeName,
        canBuyAddon: eligibility.canBuyAddon,
        projectDiskGiB: ws.projects.map((p) => p.workspaceDiskGiB),
        runtimeDiskGiB: ws.runtimeDiskGiB,
      })
      if (addonGiB <= 0) {
        summary.skipped += 1
        continue
      }
      const billedUsd = diskAddonDailyUsd(addonGiB, now)
      if (billedUsd <= 0) {
        summary.skipped += 1
        continue
      }

      // Claim the day first: a conditional update means only one pod advances
      // the watermark, so a rerun can't double-charge.
      const claimed = await prisma.workspace.updateMany({
        where: {
          id: ws.id,
          OR: [{ diskAddonBilledThrough: null }, { diskAddonBilledThrough: { lt: today } }],
        },
        data: { diskAddonBilledThrough: today },
      })
      if (claimed.count === 0) {
        summary.skipped += 1
        continue
      }

      const result = await consumeUsage({
        workspaceId: ws.id,
        projectId: null,
        memberId: 'system',
        actionType: 'disk_addon',
        billedUsd,
        actionMetadata: {
          addonGiB,
          rate: DISK_ADDON_USD_PER_GIB_MONTH,
          drives: ws.projects.length + (ws.runtimeDiskGiB ? 1 : 0),
        },
      })

      if (!result.success) {
        // Out of funds: never shrink the drive, never touch data. Roll the
        // watermark back so the next day retries, and refuse further growth
        // (the PUT pre-flight already does that).
        await prisma.workspace
          .updateMany({ where: { id: ws.id, diskAddonBilledThrough: today }, data: { diskAddonBilledThrough: null } })
          .catch(() => {})
        summary.failed += 1
        console.warn(`[DiskAddon] charge refused for ${ws.id} (${result.reason ?? result.error ?? 'unknown'})`)
        continue
      }

      summary.charged += 1
      summary.totalUsd += billedUsd
    } catch (err: any) {
      summary.failed += 1
      console.error('[DiskAddon] workspace failed', { workspaceId: ws.id, error: err?.message ?? err })
    }
  }

  summary.totalUsd = Math.round(summary.totalUsd * 100) / 100
  return summary
}

/** Daily tick. The watermark makes every extra tick a no-op. */
export function startDiskAddonDailyCron(intervalMs: number = DAY_MS) {
  if (process.env.SHOGO_DISK_ADDON_BILLING === 'false') {
    console.log('[DiskAddon] disabled via SHOGO_DISK_ADDON_BILLING=false')
    return
  }
  const tick = () =>
    runDiskAddonDaily().catch((err) => console.error('[DiskAddon] run failed:', err))
  setTimeout(() => {
    void tick()
    setInterval(tick, intervalMs)
  }, 60_000)
  console.log(`[DiskAddon] disk add-on meter scheduled (every ${Math.round(intervalMs / 3_600_000)}h)`)
}
