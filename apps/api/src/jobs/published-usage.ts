// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Published-app metering + billing (SHO-308 §9, fixed by SHO-345).
 *
 * Two steps, both **home-region partitioned** (see `homeRegionWorkspaceWhere`)
 * and behind a region-local claim so a minute is collected once:
 *
 *  1. `runPublishedUsageCollect` samples the pods of each published
 *     environment once a minute and writes one `PublishedUsageMinute` row
 *     (pod-seconds). Only environments whose project's workspace is homed in
 *     this region are sampled — published traffic is pinned to the home region
 *     (`pinPublishedToHomeRegion`), so the home region's ksvc is the serving
 *     copy and the only one that can see the real replica count.
 *  2. `runPublishedUsageBill` turns a batch of unbilled rows into ONE
 *     `consumeUsage` call per environment per hour with
 *     `actionType: "published_hosting"`, then stamps `billedAt`. Because it only
 *     reads rows where `billedAt` is null, a rerun never double-charges.
 *
 * Why the old shape broke replication (SHO-345): `withGlobalJobLock` takes a
 * `pg_try_advisory_lock` on the *local* database, so it only serialises pods
 * inside a region — US and EU each held their own lock and both ran the job.
 * Both then inserted the same `(environmentId, minute)` unique key with
 * different ids, which is an `insert_exists` conflict on apply: logical
 * replication disabled both directions (same outage class as SHO-344).
 * Partitioning by workspace home region makes the two regions' write sets
 * disjoint, so no global lock is needed. The advisory lock is kept only as a
 * region-local serialiser against the several pods in one region.
 *
 * Out of funds: `consumeUsage` reports the wallet is exhausted → the
 * environment is clamped (prod to max-scale 1, staging to zero) but production
 * is never taken down.
 */

import { prisma } from '../lib/prisma'
import { withGlobalJobLock } from '../lib/global-job-lock'
import { claimRegionPeriod } from '../lib/region-period-claim'
import { homeRegionWorkspaceWhere } from '../lib/region'
import { PUBLISHED_PRICING, computePublishedCost, roundUsd } from '../config/published-pricing'
import { scaleSettingsOf } from '../services/published-environments.service'
import type { PublishedEnvironmentName, PublishedSize } from '../lib/published-scale'

function isKubernetes(): boolean {
  return !!process.env.KUBERNETES_SERVICE_HOST
}

function truncateToMinute(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 60_000) * 60_000)
}

export interface CollectSummary {
  environments: number
  rowsWritten: number
  skipped: boolean
}

/**
 * The published environments this region owns: those whose project's workspace
 * is homed here (`homeRegionWorkspaceWhere()`), i.e. the ones whose Knative
 * service actually runs in this region (published traffic is pinned to the home
 * region). Returns every environment in single-region / local mode.
 *
 * `PublishedEnvironment` has no relation to `Project`, so the ownership filter
 * is applied one hop out: resolve the distinct projects in the home partition
 * and keep the environments that belong to them.
 */
async function ownedEnvironments(): Promise<
  Array<{ id: string; projectId: string; name: string }>
> {
  const envs = await prisma.publishedEnvironment.findMany({
    select: { id: true, projectId: true, name: true },
  })
  const home = homeRegionWorkspaceWhere()
  if (!home || envs.length === 0) return envs
  const projectIds = Array.from(new Set(envs.map((e) => e.projectId)))
  const owned = await prisma.project.findMany({
    where: { id: { in: projectIds }, workspace: home },
    select: { id: true },
  })
  const ownedIds = new Set(owned.map((p) => p.id))
  return envs.filter((e) => ownedIds.has(e.projectId))
}

interface CollectBody {
  environments: number
  rowsWritten: number
  claimed: boolean
}

export async function runPublishedUsageCollect(now: Date = new Date()): Promise<CollectSummary> {
  if (!isKubernetes()) return { environments: 0, rowsWritten: 0, skipped: true }
  const lock = await withGlobalJobLock<CollectBody>('published-usage-collect', async () => {
    const minute = truncateToMinute(now)
    // One collection per region-minute: `claimRegionPeriod` writes this
    // region's own `PlatformSetting` row, so the PK survives logical
    // replication as `last_update_wins` and the two regions never touch each
    // other's key. Taken before the pod list, so a pod that dies mid-tick
    // loses that single minute rather than letting the next pod re-write it.
    if (!(await claimRegionPeriod('published-usage-collect', 60_000, now))) {
      return { environments: 0, rowsWritten: 0, claimed: false }
    }

    const envs = await ownedEnvironments()
    if (envs.length === 0) return { environments: 0, rowsWritten: 0, claimed: true }

    const { getKnativeProjectManager } = await import('../lib/knative-project-manager')
    const { publishedServiceName } = await import('../lib/published-scale')

    let readyByService: Map<string, number>
    try {
      // One namespace-wide pod list for the whole tick, not one call per
      // environment.
      readyByService = await getKnativeProjectManager().listPublishedPodCounts()
    } catch (err: any) {
      console.warn('[published-usage] pod list failed:', err?.message ?? err)
      return { environments: envs.length, rowsWritten: 0, claimed: true }
    }

    const rows: Array<{ environmentId: string; minute: Date; podSeconds: number }> = []
    for (const env of envs) {
      const service = publishedServiceName(env.projectId, env.name as PublishedEnvironmentName)
      const running = readyByService.get(service) ?? 0
      // A scaled-to-zero environment contributes nothing to compute or egress;
      // writing a 0 row costs a replicated row and bills nothing.
      if (running <= 0) continue
      rows.push({ environmentId: env.id, minute, podSeconds: running * 60 })
    }
    if (rows.length > 0) {
      await prisma.publishedUsageMinute.createMany({ data: rows, skipDuplicates: true })
    }
    return { environments: envs.length, rowsWritten: rows.length, claimed: true }
  })
  if (!lock.acquired) return { environments: 0, rowsWritten: 0, skipped: true }
  return {
    environments: lock.result.environments,
    rowsWritten: lock.result.rowsWritten,
    skipped: !lock.result.claimed,
  }
}

export interface BillSummary {
  environmentsCharged: number
  rowsBilled: number
  totalUsd: number
  clamped: number
  skipped: boolean
}

export async function runPublishedUsageBill(now: Date = new Date()): Promise<BillSummary> {
  const lock = await withGlobalJobLock<Omit<BillSummary, 'skipped'>>(
    'published-usage-bill',
    async () => {
      const home = homeRegionWorkspaceWhere()
      // Only bill environments this region collected: the write sets are
      // disjoint, so the peer's rows stay unbilled until its own hour tick.
      const ownedEnvIds = home ? (await ownedEnvironments()).map((e) => e.id) : null

      const pending = await prisma.publishedUsageMinute.findMany({
        where: {
          billedAt: null,
          minute: { lt: truncateToMinute(now) },
          ...(ownedEnvIds ? { environmentId: { in: ownedEnvIds } } : {}),
        },
        orderBy: { minute: 'asc' },
      })
      if (pending.length === 0) {
        return { environmentsCharged: 0, rowsBilled: 0, totalUsd: 0, clamped: 0 }
      }

      const byEnv = new Map<string, typeof pending>()
      for (const row of pending) {
        const list = byEnv.get(row.environmentId) ?? []
        list.push(row)
        byEnv.set(row.environmentId, list)
      }

      const { consumeUsage } = await import('../services/billing.service')
      const { applyExhaustedWalletClamp } = await import('../services/published-ops.service')
      const { getProjectOwnerUserId } = await import('../lib/project-user-context')

      let environmentsCharged = 0
      let rowsBilled = 0
      let totalUsd = 0
      let clamped = 0

      for (const [environmentId, rows] of byEnv) {
        const env = await prisma.publishedEnvironment.findUnique({ where: { id: environmentId } })
        if (!env) continue
        const project = await prisma.project.findUnique({
          where: { id: env.projectId },
          select: { workspaceId: true },
        })
        if (!project?.workspaceId) continue

        const size = scaleSettingsOf(env as any).size
        const podSecondsBySize: Partial<Record<PublishedSize, number>> = {}
        let egressBytes = 0
        let dbStorageBytes = 0
        for (const row of rows) {
          podSecondsBySize[size] = (podSecondsBySize[size] ?? 0) + row.podSeconds
          egressBytes += Number(row.egressBytes ?? 0)
          dbStorageBytes = Math.max(dbStorageBytes, Number(row.dbStorageBytes ?? 0))
        }
        const cost = computePublishedCost({ podSeconds: podSecondsBySize, egressBytes, dbStorageBytes, monthFraction: 0 })
        // Only per-second compute + egress are charged from a minute window; DB
        // storage is charged by the daily rollup so a 60s slice isn't billed as a
        // month of storage.
        const billedUsd = roundUsd(cost.podUsd + cost.egressUsd)
        if (billedUsd <= 0) {
          await prisma.publishedUsageMinute.updateMany({
            where: { id: { in: rows.map((r) => r.id) } },
            data: { billedAt: now },
          })
          rowsBilled += rows.length
          continue
        }

        const memberId = await getProjectOwnerUserId(env.projectId).catch(() => 'system')
        const result = await consumeUsage({
          workspaceId: project.workspaceId,
          projectId: env.projectId,
          memberId,
          actionType: 'published_hosting',
          billedUsd,
          actionMetadata: {
            environment: env.name,
            podSeconds: podSecondsBySize,
            egressGB: egressBytes / 1024 ** 3,
            dbGB: dbStorageBytes / 1024 ** 3,
            rates: PUBLISHED_PRICING,
          },
        })

        if (!result.success) {
          // Only a genuinely empty wallet clamps. A transient failure (peer call,
          // DB hiccup, unknown reason) must leave the site at full scale and the
          // rows unbilled so the next tick retries the charge.
          const exhausted =
            result.reason === 'usage_limit_reached' || result.reason === 'overage_cap_reached'
          if (exhausted) {
            // Prod is never taken down: it is held at max-scale 1, staging drops
            // to zero. `applyExhaustedWalletClamp` also pushes the new scale to
            // Knative, so the clamp actually reaches the running service.
            const changes = await applyExhaustedWalletClamp(env.projectId)
            clamped += changes.filter((c) => c.applied).length
            const notApplied = changes.filter((c) => !c.applied)
            if (notApplied.length > 0) {
              console.error(
                `[published-usage] clamp persisted but NOT applied for ${env.projectId}: ` +
                  notApplied.map((c) => c.environment.name).join(', '),
              )
            }
          }
          console.warn(
            `[published-usage] charge refused for ${env.projectId}/${env.name} ` +
              `(${result.reason ?? result.error ?? 'unknown'}): ${result.error ?? ''}`,
          )
          continue
        }

        await prisma.publishedUsageMinute.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: { billedAt: now },
        })
        environmentsCharged++
        rowsBilled += rows.length
        totalUsd += billedUsd
      }

      return { environmentsCharged, rowsBilled, totalUsd: roundUsd(totalUsd), clamped }
    },
  )
  if (!lock.acquired) {
    return { environmentsCharged: 0, rowsBilled: 0, totalUsd: 0, clamped: 0, skipped: true }
  }
  return { ...lock.result, skipped: false }
}

/** Hourly: collect every minute, bill the completed rows once an hour. */
export function startPublishedUsageCron() {
  if (process.env.SHOGO_PUBLISHED_BILLING === 'false') {
    console.log('[published-usage] disabled via SHOGO_PUBLISHED_BILLING=false')
    return
  }
  let lastBilledHour = -1
  setTimeout(() => {
    const tick = () => {
      runPublishedUsageCollect().catch((err) => console.error('[published-usage] collect failed:', err))
      const hour = new Date().getUTCHours()
      if (hour !== lastBilledHour) {
        lastBilledHour = hour
        runPublishedUsageBill().catch((err) => console.error('[published-usage] bill failed:', err))
      }
    }
    tick()
    setInterval(tick, 60_000)
  }, 90_000)
  console.log('[published-usage] cron scheduled (collect every 60s, bill hourly)')
}
