// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Workspace compute billing (SHO-424).
 *
 * Hourly: take every CLOSED hour of `VmUsageHour` rows that has not been
 * charged, price it with `computeVmCost`, and make exactly one `consumeUsage`
 * call per workspace-hour with `actionType: "vm_compute"`. Rows are then
 * stamped `billedAt`, and because the job only reads rows where that is null a
 * rerun charges nothing.
 *
 * Shadow first (`VM_BILLING_MODE=shadow`, the default): the same arithmetic
 * runs, `chargedUsd` is filled so the dashboard's estimate and the eventual real
 * charge are one number, and the total is logged — but `consumeUsage` is never
 * called. Flipping to `enforce` starts charging from the next hour; hours
 * already priced in shadow stay billed-at, so the switch cannot retro-bill.
 *
 * Region safety follows `published-usage` (SHO-345): the job only bills
 * workspaces homed in this region, behind a region-local claim. Two regions
 * therefore never charge the same workspace, and — because a metal host
 * heartbeats to exactly one region — their write sets are disjoint.
 *
 * Local mode: no-op, like published usage. There is no wallet to draw from and
 * the whole point is cloud compute.
 */

import { prisma } from '../lib/prisma'
import { withGlobalJobLock } from '../lib/global-job-lock'
import { claimRegionPeriod } from '../lib/region-period-claim'
import { homeWorkspaceIds } from '../lib/region'
import { VM_PRICING, computeVmCost, roundUsd, vmBillingMode } from '../config/vm-pricing'
import { truncateToHour } from '../lib/vm-metering/ingest'

function isKubernetes(): boolean {
  return !!process.env.KUBERNETES_SERVICE_HOST
}

export interface VmBillSummary {
  mode: 'shadow' | 'enforce'
  workspacesCharged: number
  rowsBilled: number
  /** USD that was charged (enforce) or would have been (shadow). */
  totalUsd: number
  /** USD the pricing deliberately did not charge (idle tail, rewarm/prewarm/published). */
  freeUsd: number
  skipped: boolean
}

const EMPTY: Omit<VmBillSummary, 'mode' | 'skipped'> = {
  workspacesCharged: 0,
  rowsBilled: 0,
  totalUsd: 0,
  freeUsd: 0,
}

interface HourRow {
  id: string
  workspaceId: string
  projectId: string
  hour: Date
  vcpus: number
  memMiB: number
  cause: string
  agentSeconds: number
  appSeconds: number
  idleSeconds: number
}

/** Bucket rows by workspace+hour: one `consumeUsage` per workspace per hour. */
export function groupByWorkspaceHour(rows: HourRow[]): Map<string, HourRow[]> {
  const out = new Map<string, HourRow[]>()
  for (const row of rows) {
    const key = `${row.workspaceId}|${row.hour.getTime()}`
    const list = out.get(key) ?? []
    list.push(row)
    out.set(key, list)
  }
  return out
}

/**
 * Price one workspace-hour from its rows. Pure, so the estimate endpoint and
 * the job agree by construction.
 */
export function priceWorkspaceHour(rows: HourRow[]): {
  chargedUsd: number
  freeUsd: number
  vcpuHours: number
  gibHours: number
  agentSeconds: number
  appSeconds: number
  idleSeconds: number
  byProject: Record<string, { chargedUsd: number; agentSeconds: number; appSeconds: number; idleSeconds: number }>
  byState: { activeBilledUsd: number; idleNotBilledUsd: number }
} {
  let chargedUsd = 0
  let freeUsd = 0
  let vcpuHours = 0
  let gibHours = 0
  let agentSeconds = 0
  let appSeconds = 0
  let idleSeconds = 0
  let idleNotBilledUsd = 0
  const byProject: Record<string, { chargedUsd: number; agentSeconds: number; appSeconds: number; idleSeconds: number }> = {}

  for (const row of rows) {
    const cost = computeVmCost({
      vcpus: row.vcpus,
      memMiB: row.memMiB,
      agentSeconds: row.agentSeconds,
      appSeconds: row.appSeconds,
      idleSeconds: row.idleSeconds,
      cause: row.cause,
    })
    chargedUsd += cost.totalUsd
    vcpuHours += cost.vcpuHours
    gibHours += cost.gibHours
    agentSeconds += row.agentSeconds
    appSeconds += row.appSeconds
    idleSeconds += row.idleSeconds

    // What the untouched parts of the row WOULD have cost, so super admin can
    // show platform overhead rather than a number that silently absorbed it.
    const full = computeVmCost(
      {
        vcpus: row.vcpus,
        memMiB: row.memMiB,
        agentSeconds: row.agentSeconds,
        appSeconds: row.appSeconds,
        idleSeconds: row.idleSeconds,
        cause: 'user_open',
      },
      { ...VM_PRICING, idleBilling: 'full' },
    )
    freeUsd += Math.max(0, full.totalUsd - cost.totalUsd)
    idleNotBilledUsd += Math.max(
      0,
      full.totalUsd -
        computeVmCost(
          {
            vcpus: row.vcpus,
            memMiB: row.memMiB,
            agentSeconds: row.agentSeconds,
            appSeconds: row.appSeconds,
            idleSeconds: row.idleSeconds,
            cause: 'user_open',
          },
          { ...VM_PRICING, idleBilling: 'none' },
        ).totalUsd,
    )

    const bucket = (byProject[row.projectId || ''] ??= {
      chargedUsd: 0,
      agentSeconds: 0,
      appSeconds: 0,
      idleSeconds: 0,
    })
    bucket.chargedUsd += cost.totalUsd
    bucket.agentSeconds += row.agentSeconds
    bucket.appSeconds += row.appSeconds
    bucket.idleSeconds += row.idleSeconds
  }

  for (const key of Object.keys(byProject)) byProject[key].chargedUsd = roundUsd(byProject[key].chargedUsd)

  return {
    chargedUsd: roundUsd(chargedUsd),
    freeUsd: roundUsd(freeUsd),
    vcpuHours,
    gibHours,
    agentSeconds,
    appSeconds,
    idleSeconds,
    byProject,
    byState: { activeBilledUsd: roundUsd(chargedUsd), idleNotBilledUsd: roundUsd(idleNotBilledUsd) },
  }
}

/**
 * Charge every closed, unbilled hour. `now` is injectable so the tests (and a
 * backfill) can price a specific window without waiting for the clock.
 */
export async function runVmUsageBill(now: Date = new Date()): Promise<VmBillSummary> {
  const mode = vmBillingMode()
  if (!isKubernetes() || process.env.SHOGO_LOCAL_MODE === 'true') {
    return { mode, ...EMPTY, skipped: true }
  }
  if (process.env.VM_BILLING === 'false') {
    return { mode, ...EMPTY, skipped: true }
  }

  const lock = await withGlobalJobLock<Omit<VmBillSummary, 'mode' | 'skipped'>>('vm-usage-bill', async () => {
    // One bill run per region-hour. The claim is a region-local PlatformSetting
    // row, so the PK survives replication as last_update_wins.
    if (!(await claimRegionPeriod('vm-usage-bill', 3_600_000, now))) {
      return { ...EMPTY }
    }

    const cutoff = truncateToHour(now)
    const pending = (await prisma.vmUsageHour.findMany({
      where: { billedAt: null, hour: { lt: cutoff } },
      select: {
        id: true,
        workspaceId: true,
        projectId: true,
        hour: true,
        vcpus: true,
        memMiB: true,
        cause: true,
        agentSeconds: true,
        appSeconds: true,
        idleSeconds: true,
      },
    })) as HourRow[]
    if (pending.length === 0) return { ...EMPTY }

    // Only workspaces homed in this region: the peer region's rows (a VM on ITS
    // host, or its own copy of a replicated row) are billed by its own run.
    // `null` means single-region/local → every workspace is ours.
    const home = await homeWorkspaceIds([...new Set(pending.map((r) => r.workspaceId))])
    const rows = home ? pending.filter((r) => home.has(r.workspaceId)) : pending
    if (rows.length === 0) return { ...EMPTY }

    const groups = groupByWorkspaceHour(rows)
    const { consumeUsage } = await import('../services/billing.service')
    const { getWorkspaceOwnerUserId } = await import('../lib/project-user-context')

    let workspacesCharged = 0
    let rowsBilled = 0
    let totalUsd = 0
    let freeUsd = 0

    for (const [key, hourRows] of groups) {
      const [workspaceId, hourMs] = key.split('|')
      const priced = priceWorkspaceHour(hourRows)
      const rowIds = hourRows.map((r) => r.id)
      const usd = priced.chargedUsd

      if (usd > 0 && mode === 'enforce') {
        const memberId = await getWorkspaceOwnerUserId(workspaceId).catch(() => 'system')
        // One project's runtime? Attribute the event to it, else workspace-level.
        const onlyProject = new Set(hourRows.map((r) => r.projectId)).size === 1 ? hourRows[0].projectId : ''
        const result = await consumeUsage({
          workspaceId,
          projectId: onlyProject || null,
          memberId,
          actionType: 'vm_compute',
          billedUsd: usd,
          actionMetadata: {
            hour: new Date(Number(hourMs)).toISOString(),
            vcpuHours: roundUsd(priced.vcpuHours),
            gibHours: roundUsd(priced.gibHours),
            agentSeconds: priced.agentSeconds,
            appSeconds: priced.appSeconds,
            idleSeconds: priced.idleSeconds,
            byProject: priced.byProject,
            byState: priced.byState,
            rates: VM_PRICING,
          },
        })
        if (!result.success) {
          // Leave the rows unbilled so the next run retries. Never stamp a
          // charge that did not happen.
          console.warn(
            `[vm-usage-bill] charge refused for ${workspaceId} @ ${new Date(Number(hourMs)).toISOString()} ` +
              `(${result.reason ?? result.error ?? 'unknown'}): ${result.error ?? ''}`,
          )
          continue
        }
      }

      // Shadow stamps the row too: the hour is priced and will never be
      // retro-charged when enforce turns on.
      await prisma.vmUsageHour.updateMany({
        where: { id: { in: rowIds } },
        data: { billedAt: now, chargedUsd: priced.chargedUsd },
      })
      workspacesCharged++
      rowsBilled += rowIds.length
      totalUsd += usd
      freeUsd += priced.freeUsd
    }

    if (mode === 'shadow' && totalUsd > 0) {
      console.log(
        `[vm-usage-bill] shadow: ${rowsBilled} row(s) across ${workspacesCharged} workspace-hour(s) would bill $${roundUsd(totalUsd).toFixed(4)}`,
      )
    }

    return {
      workspacesCharged,
      rowsBilled,
      totalUsd: roundUsd(totalUsd),
      freeUsd: roundUsd(freeUsd),
    }
  })

  if (!lock.acquired) return { mode, ...EMPTY, skipped: true }
  return { mode, ...lock.result, skipped: false }
}

/** Hourly tick. Runs once shortly after boot, then on the hour boundary. */
export function startVmUsageBillCron(): void {
  if (process.env.VM_BILLING === 'false') {
    console.log('[vm-usage-bill] disabled via VM_BILLING=false')
    return
  }
  let lastBilledHour = -1
  setTimeout(() => {
    const tick = () => {
      const hour = new Date().getUTCHours()
      if (hour === lastBilledHour) return
      lastBilledHour = hour
      runVmUsageBill().catch((err) => console.error('[vm-usage-bill] failed:', err))
    }
    tick()
    setInterval(tick, 60_000)
  }, 120_000)
  console.log(`[vm-usage-bill] cron scheduled (hourly, mode=${vmBillingMode()})`)
}
