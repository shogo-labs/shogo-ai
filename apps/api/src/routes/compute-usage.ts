// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Workspace compute usage (SHO-424).
 *
 * Two reads over the metered microVM time:
 *
 *   GET /api/workspaces/:id/compute-usage   the workspace's own bill
 *   GET /api/admin/compute                  the fleet's (super admin, in routes/admin.ts)
 *
 * The workspace view is deliberately asymmetric: an owner/admin sees the split
 * by project, machine size and state (what was billed, what idle time we chose
 * not to bill); a plain member sees the period total only. Compute is billed to
 * the workspace, and giving every member the per-project cost of their
 * teammates' work is a spending-visibility decision nobody asked for.
 *
 * Every number here is the same arithmetic the hourly biller uses
 * (`priceWorkspaceHour` in jobs/vm-usage-bill.ts → `computeVmCost` in
 * config/vm-pricing.ts), so the estimate a customer sees cannot drift from what
 * they are charged.
 */

import { Hono } from 'hono'
import { authMiddleware, requireAuth } from '../middleware/auth'
import { getAccess } from '../lib/authz'
import { prisma } from '../lib/prisma'
import { VM_PRICING, computeVmCost, roundUsd, vmBillingMode } from '../config/vm-pricing'
import { priceWorkspaceHour } from '../jobs/vm-usage-bill'

/** Days of daily history the chart shows. */
const HISTORY_DAYS = 30

interface UsageRow {
  workspaceId: string
  projectId: string
  hour: Date
  vcpus: number
  memMiB: number
  cause: string
  agentSeconds: number
  appSeconds: number
  idleSeconds: number
  chargedUsd: number | null
  billedAt: Date | null
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}

function startOfHour(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000)
}

/** Human size label from the machine the host booted. */
function sizeLabel(vcpus: number, memMiB: number): string {
  return `${vcpus} vCPU · ${Math.round((memMiB / 1024) * 10) / 10} GiB`
}

export function computeUsageRoutes(): Hono {
  const router = new Hono()

  router.use('*', authMiddleware)
  router.use('*', requireAuth)

  /**
   * One workspace's compute for the current billing period, plus a daily chart
   * and what is running right now.
   */
  router.get('/workspaces/:id/compute-usage', async (c) => {
    const workspaceId = c.req.param('id')
    const access = await getAccess(c, { workspaceId })
    if (!access.exists) return c.json({ error: { code: 'not_found', message: 'Workspace not found' } }, 404)
    if (!access.permissions.has('workspace:read')) {
      return c.json({ error: { code: 'forbidden', message: 'Access denied' } }, 403)
    }
    const detailed = access.permissions.has('workspace.settings:manage')

    const now = new Date()
    const periodStart = startOfMonth(now)
    const historyStart = startOfDay(new Date(now.getTime() - HISTORY_DAYS * 24 * 3_600_000))

    let rows: UsageRow[] = []
    try {
      rows = (await prisma.vmUsageHour.findMany({
        where: { workspaceId, hour: { gte: historyStart } },
        select: {
          workspaceId: true,
          projectId: true,
          hour: true,
          vcpus: true,
          memMiB: true,
          cause: true,
          agentSeconds: true,
          appSeconds: true,
          idleSeconds: true,
          chargedUsd: true,
          billedAt: true,
        },
        orderBy: { hour: 'asc' },
      })) as UsageRow[]
    } catch (err: any) {
      console.error('[compute-usage] read failed:', err?.message ?? err)
      return c.json({ error: { code: 'internal_error', message: 'Could not read compute usage' } }, 500)
    }

    const periodRows = rows.filter((r) => r.hour >= periodStart)
    const price = priceWorkspaceHour(
      periodRows.map((r) => ({
        id: '',
        workspaceId: r.workspaceId,
        projectId: r.projectId,
        hour: r.hour,
        vcpus: r.vcpus,
        memMiB: r.memMiB,
        cause: r.cause,
        agentSeconds: r.agentSeconds,
        appSeconds: r.appSeconds,
        idleSeconds: r.idleSeconds,
      })),
    )

    const totalVmSeconds = price.agentSeconds + price.appSeconds + price.idleSeconds
    const activeSeconds = price.agentSeconds + price.appSeconds

    // Daily series. Reuses the same pricing so the bars and the total agree.
    const byDay = new Map<string, { hours: number; activeHours: number; idleHours: number; usd: number }>()
    for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
      const day = startOfDay(new Date(now.getTime() - i * 24 * 3_600_000)).toISOString().slice(0, 10)
      byDay.set(day, { hours: 0, activeHours: 0, idleHours: 0, usd: 0 })
    }
    for (const row of rows) {
      const day = startOfDay(row.hour).toISOString().slice(0, 10)
      const bucket = byDay.get(day)
      if (!bucket) continue
      const cost = computeVmCost({
        vcpus: row.vcpus,
        memMiB: row.memMiB,
        agentSeconds: row.agentSeconds,
        appSeconds: row.appSeconds,
        idleSeconds: row.idleSeconds,
        cause: row.cause,
      })
      // VM-hours here means "wall-clock hours one VM of this size ran", which is
      // what a customer compares against a price per hour.
      bucket.hours += (row.agentSeconds + row.appSeconds + row.idleSeconds) / 3600
      bucket.activeHours += (row.agentSeconds + row.appSeconds) / 3600
      bucket.idleHours += row.idleSeconds / 3600
      bucket.usd += cost.totalUsd
    }

    const base = {
      mode: vmBillingMode(),
      currency: 'USD',
      periodStart: periodStart.toISOString(),
      periodEnd: now.toISOString(),
      rates: { vcpuHour: VM_PRICING.vcpuHour, gibHour: VM_PRICING.gibHour, idleBilling: VM_PRICING.idleBilling },
      totals: {
        // Per-account totals both roles get: what the workspace is running and
        // what it costs (or will cost) — the number a member's bill shows.
        activeVmHours: roundUsd(activeSeconds / 3600),
        totalVmHours: roundUsd(totalVmSeconds / 3600),
        vcpuHours: roundUsd(price.vcpuHours),
        gibHours: roundUsd(price.gibHours),
        estimatedUsd: price.chargedUsd,
        // Idle time we metered and deliberately did not bill (Russell: free).
        notBilledUsd: price.freeUsd,
      },
      daily: [...byDay.entries()].map(([day, v]) => ({
        day,
        vmHours: roundUsd(v.hours),
        activeVmHours: roundUsd(v.activeHours),
        idleVmHours: roundUsd(v.idleHours),
        estimatedUsd: roundUsd(v.usd),
      })),
    }

    if (!detailed) {
      // Members: the total, nothing about who or what.
      return c.json(base)
    }

    // Owners/admins: the split.
    const projectIds = [...new Set(periodRows.map((r) => r.projectId).filter(Boolean))]
    const projects = projectIds.length
      ? await prisma.project.findMany({
          where: { id: { in: projectIds } },
          select: { id: true, name: true },
        })
      : []
    const projectName = new Map(projects.map((p) => [p.id, p.name]))

    const byProject = Object.entries(price.byProject).map(([projectId, v]) => ({
      projectId: projectId || null,
      // '' is a workspace-session runtime: the shared VM the workspace itself
      // runs on, not any one project's canvas.
      name: projectId ? (projectName.get(projectId) ?? 'Deleted project') : 'Workspace runtime',
      activeVmHours: roundUsd((v.agentSeconds + v.appSeconds) / 3600),
      idleVmHours: roundUsd(v.idleSeconds / 3600),
      estimatedUsd: v.chargedUsd,
    }))

    const sizes = new Map<
      string,
      { vcpus: number; memMiB: number; activeVmHours: number; idleVmHours: number; usd: number }
    >()
    for (const row of periodRows) {
      const key = `${row.vcpus}:${row.memMiB}`
      const bucket = sizes.get(key) ?? { vcpus: row.vcpus, memMiB: row.memMiB, activeVmHours: 0, idleVmHours: 0, usd: 0 }
      bucket.activeVmHours += (row.agentSeconds + row.appSeconds) / 3600
      bucket.idleVmHours += row.idleSeconds / 3600
      bucket.usd += computeVmCost({
        vcpus: row.vcpus,
        memMiB: row.memMiB,
        agentSeconds: row.agentSeconds,
        appSeconds: row.appSeconds,
        idleSeconds: row.idleSeconds,
        cause: row.cause,
      }).totalUsd
      sizes.set(key, bucket)
    }

    const runningNow = await runningRuntimes(workspaceId, projectName)

    return c.json({
      ...base,
      byProject: byProject.sort((a, b) => b.estimatedUsd - a.estimatedUsd),
      bySize: [...sizes.values()]
        .map((s) => ({
          label: sizeLabel(s.vcpus, s.memMiB),
          vcpus: s.vcpus,
          memMiB: s.memMiB,
          activeVmHours: roundUsd(s.activeVmHours),
          idleVmHours: roundUsd(s.idleVmHours),
          estimatedUsd: roundUsd(s.usd),
        }))
        .sort((a, b) => b.estimatedUsd - a.estimatedUsd),
      byState: [
        { state: 'active', label: 'Agent + app time', billed: true, vmHours: roundUsd(activeSeconds / 3600), estimatedUsd: price.byState.activeBilledUsd },
        {
          state: 'idle',
          label: 'Idle tail (not billed)',
          billed: false,
          vmHours: roundUsd(price.idleSeconds / 3600),
          estimatedUsd: price.byState.idleNotBilledUsd,
        },
      ],
      // Cause split: what the platform paid for on the workspace's behalf.
      byCause: summarizeCauses(periodRows),
      runningNow,
    })
  })

  return router
}

/**
 * What this workspace has running right now, from the shared run registry. A
 * workspace-session runtime and each project canvas are separate entries, which
 * is exactly how they are billed.
 */
async function runningRuntimes(
  workspaceId: string,
  projectName: Map<string, string>,
): Promise<Array<{ runtimeKey: string; name: string; memMiB: number; runningSinceMs: number | null }>> {
  try {
    const { getMetalPlacementRegistry } = await import('../lib/metal-placement-registry')
    const runs = await getMetalPlacementRegistry().listWorkspaceRuns(workspaceId)
    return runs.map((r) => {
      const key = r.runtimeKey
      const projectId = key.startsWith('ws:proj:') ? key.slice('ws:proj:'.length) : key.startsWith('ws:') ? '' : key
      return {
        runtimeKey: key,
        name: projectId ? (projectName.get(projectId) ?? 'Project runtime') : 'Workspace runtime',
        memMiB: r.memMiB ?? 0,
        runningSinceMs: r.openedAt ? Date.now() - r.openedAt : null,
      }
    })
  } catch {
    // The registry is Redis-backed and best-effort: an unreachable cache must
    // not take down the usage page.
    return []
  }
}

function summarizeCauses(rows: UsageRow[]): Array<{ cause: string; vmHours: number; billed: boolean; estimatedUsd: number }> {
  const byCause = new Map<string, { vmHours: number; billed: boolean; usd: number }>()
  for (const row of rows) {
    const bucket = byCause.get(row.cause) ?? { vmHours: 0, billed: false, usd: 0 }
    const cost = computeVmCost({
      vcpus: row.vcpus,
      memMiB: row.memMiB,
      agentSeconds: row.agentSeconds,
      appSeconds: row.appSeconds,
      idleSeconds: row.idleSeconds,
      cause: row.cause,
    })
    bucket.vmHours += (row.agentSeconds + row.appSeconds + row.idleSeconds) / 3600
    bucket.billed = bucket.billed || !cost.freeCause
    bucket.usd += cost.totalUsd
    byCause.set(row.cause, bucket)
  }
  return [...byCause.entries()]
    .map(([cause, v]) => ({ cause, vmHours: roundUsd(v.vmHours), billed: v.billed, estimatedUsd: roundUsd(v.usd) }))
    .sort((a, b) => b.vmHours - a.vmHours)
}

/**
 * Fleet-wide compute for super admin: hours by state and cause, billable vs
 * platform overhead, the top workspaces, month-to-date revenue (shadow or real)
 * against the host bill, and a reconciliation line.
 *
 * The reconciliation is the point of this panel: ingested VM-hours must track
 * the `metal.host.assigned` gauge integral for the same window. A gap means the
 * meter is blind somewhere (a host on an old agent, a resolver miss), and every
 * number below it is then wrong by that much.
 */
export async function adminComputeSummary(params: { now?: Date; hostMonthlyUsd?: number } = {}) {
  const now = params.now ?? new Date()
  const hostMonthlyUsd = params.hostMonthlyUsd ?? Number(process.env.METAL_HOST_MONTHLY_USD ?? 500)
  const monthStart = startOfMonth(now)
  const historyStart = new Date(now.getTime() - 14 * 24 * 3_600_000)

  const rows = (await prisma.vmUsageHour.findMany({
    where: { hour: { gte: historyStart } },
    select: {
      workspaceId: true,
      projectId: true,
      hour: true,
      vcpus: true,
      memMiB: true,
      cause: true,
      agentSeconds: true,
      appSeconds: true,
      idleSeconds: true,
      chargedUsd: true,
      billedAt: true,
    },
    orderBy: { hour: 'asc' },
  })) as UsageRow[]

  const monthRows = rows.filter((r) => r.hour >= monthStart)
  const byCause = new Map<string, { seconds: number; usd: number; freeUsd: number }>()
  const byWorkspace = new Map<string, { seconds: number; activeSeconds: number; usd: number; freeUsd: number }>()
  let billableUsd = 0
  let overheadUsd = 0
  let totalSeconds = 0
  let activeSeconds = 0
  let idleSeconds = 0

  for (const row of monthRows) {
    const cost = computeVmCost({
      vcpus: row.vcpus,
      memMiB: row.memMiB,
      agentSeconds: row.agentSeconds,
      appSeconds: row.appSeconds,
      idleSeconds: row.idleSeconds,
      cause: row.cause,
    })
    // What the SAME machine time would cost if every second were billed and no
    // cause were exempt — the ceiling a customer would pay under a naive meter.
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
    const seconds = row.agentSeconds + row.appSeconds + row.idleSeconds
    totalSeconds += seconds
    activeSeconds += row.agentSeconds + row.appSeconds
    idleSeconds += row.idleSeconds
    billableUsd += cost.totalUsd
    overheadUsd += Math.max(0, full.totalUsd - cost.totalUsd)

    const cause = byCause.get(row.cause) ?? { seconds: 0, usd: 0, freeUsd: 0 }
    cause.seconds += seconds
    cause.usd += cost.totalUsd
    cause.freeUsd += Math.max(0, full.totalUsd - cost.totalUsd)
    byCause.set(row.cause, cause)

    const ws = byWorkspace.get(row.workspaceId) ?? { seconds: 0, activeSeconds: 0, usd: 0, freeUsd: 0 }
    ws.seconds += seconds
    ws.activeSeconds += row.agentSeconds + row.appSeconds
    ws.usd += cost.totalUsd
    ws.freeUsd += Math.max(0, full.totalUsd - cost.totalUsd)
    byWorkspace.set(row.workspaceId, ws)
  }

  // Billed (or shadow-priced) revenue from the rows the biller has stamped.
  const stamped = monthRows.filter((r) => r.billedAt !== null)
  const stampedUsd = stamped.reduce((sum, r) => sum + Number(r.chargedUsd ?? 0), 0)

  let hosts = 0
  let assignedNow = 0
  let liveness: { appActive: number; agentActive: number; idleTail: number } | null = null
  try {
    const { getMetalWarmPoolController } = await import('../lib/metal-warm-pool-controller')
    const fleet = await getMetalWarmPoolController().getFleetStatus()
    hosts = fleet.hosts.length
    const acc = { appActive: 0, agentActive: 0, idleTail: 0 }
    for (const h of fleet.hosts) {
      assignedNow += h.load?.assigned ?? 0
      acc.appActive += h.load?.liveness?.appActive ?? 0
      acc.agentActive += h.load?.liveness?.agentActive ?? 0
      acc.idleTail += h.load?.liveness?.idleTail ?? 0
    }
    liveness = acc
  } catch {
    // fleet view is advisory here
  }

  const topWorkspaces = [...byWorkspace.entries()]
    .sort((a, b) => b[1].seconds - a[1].seconds)
    .slice(0, 50)
  const names = topWorkspaces.length
    ? await prisma.workspace.findMany({
        where: { id: { in: topWorkspaces.map(([id]) => id) } },
        select: { id: true, name: true },
      })
    : []
  const nameById = new Map(names.map((w) => [w.id, w.name]))

  const hostCostUsd = roundUsd(hosts * hostMonthlyUsd)

  return {
    mode: vmBillingMode(),
    windowStart: monthStart.toISOString(),
    generatedAt: now.toISOString(),
    rates: { vcpuHour: VM_PRICING.vcpuHour, gibHour: VM_PRICING.gibHour, idleBilling: VM_PRICING.idleBilling },
    fleet: {
      hosts,
      hostMonthlyUsd,
      hostCostUsd,
      // Cost the platform pays this month vs what the meter says it could bill.
      marginUsd: roundUsd(billableUsd - hostCostUsd),
      assignedNow,
      livenessNow: liveness,
    },
    totals: {
      vmHours: roundUsd(totalSeconds / 3600),
      activeVmHours: roundUsd(activeSeconds / 3600),
      idleVmHours: roundUsd(idleSeconds / 3600),
      billableUsd: roundUsd(billableUsd),
      // Everything the pricing chose not to charge: the free idle tail plus the
      // rewarm/prewarm/published causes.
      platformOverheadUsd: roundUsd(overheadUsd),
      stampedUsd: roundUsd(stampedUsd),
      stampedRows: stamped.length,
    },
    byCause: [...byCause.entries()]
      .map(([cause, v]) => ({
        cause,
        vmHours: roundUsd(v.seconds / 3600),
        estimatedUsd: roundUsd(v.usd),
        notBilledUsd: roundUsd(v.freeUsd),
      }))
      .sort((a, b) => b.vmHours - a.vmHours),
    topWorkspaces: topWorkspaces.map(([workspaceId, v]) => ({
      workspaceId,
      name: nameById.get(workspaceId) ?? workspaceId,
      vmHours: roundUsd(v.seconds / 3600),
      activeVmHours: roundUsd(v.activeSeconds / 3600),
      estimatedUsd: roundUsd(v.usd),
      notBilledUsd: roundUsd(v.freeUsd),
    })),
    // `reconcile()` reads the fleet view, so it must be awaited — an un-awaited
    // promise serialises to `{}` and the panel then throws on
    // `reconciliation.hostsMissingMeter.length`, taking the whole admin
    // analytics screen down with it.
    reconciliation: await reconcile(),
  }
}

/**
 * Ingested VM-hours vs the fleet's own view of what is running.
 *
 * The SigNoz integral of `metal.host.assigned` is not readable from here, so the
 * panel shows what CAN be compared within the API: the sum of per-host
 * `load.assigned` (what the hosts say they are running right now) against the
 * host count, plus the meter's own coverage — how many distinct hosts reported
 * usage this month. A host that is running VMs but has never reported a meter
 * row is invisible to the bill, and that is the failure this line exists to
 * catch.
 */
async function reconcile(): Promise<{
  hostsReportingUsage: number
  hostsMissingMeter: string[]
}> {
  try {
    const since = new Date(Date.now() - 72 * 3_600_000)
    const seen = await prisma.vmUsageHour.findMany({
      where: { hour: { gte: since } },
      select: { hostId: true },
      distinct: ['hostId'],
    })
    const reporting = new Set(seen.map((r) => r.hostId))
    const { getMetalWarmPoolController } = await import('../lib/metal-warm-pool-controller')
    const fleet = await getMetalWarmPoolController().getFleetStatus()
    const missing = fleet.hosts
      .filter((h) => (h.load?.assigned ?? 0) > 0 && !reporting.has(h.hostId))
      .map((h) => h.hostId)
    return { hostsReportingUsage: reporting.size, hostsMissingMeter: missing }
  } catch {
    return { hostsReportingUsage: 0, hostsMissingMeter: [] }
  }
}
