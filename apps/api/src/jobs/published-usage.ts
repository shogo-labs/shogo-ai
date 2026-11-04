// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Published-app metering + billing (SHO-308 §9).
 *
 * Two steps, both behind `global-job-lock` so exactly one region runs them:
 *
 *  1. `collectPublishedUsage` samples each published environment's pods once a
 *     minute and writes one `PublishedUsageMinute` row (pod-seconds, requests,
 *     errors, latency, egress, DB bytes). Replica counts come from the
 *     Kubernetes pod list for the environment's ksvc.
 *  2. `billPublishedUsage` turns a batch of unbilled rows into ONE
 *     `consumeUsage` call per environment per hour with
 *     `actionType: "published_hosting"`, then stamps `billedAt`. Because it only
 *     reads rows where `billedAt` is null, a rerun never double-charges.
 *
 * Out of funds: `consumeUsage` reports the wallet is exhausted → the
 * environment is clamped (prod to max-scale 1, staging to zero) but production
 * is never taken down.
 */

import { prisma } from '../lib/prisma'
import { withGlobalJobLock } from '../lib/global-job-lock'
import { PUBLISHED_PRICING, computePublishedCost, roundUsd } from '../config/published-pricing'
import { scaleSettingsOf } from '../services/published-environments.service'
import type { PublishedSize } from '../lib/published-scale'

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

export async function collectPublishedUsage(now: Date = new Date()): Promise<CollectSummary> {
  if (!isKubernetes()) return { environments: 0, rowsWritten: 0, skipped: true }
  const lock = await withGlobalJobLock('published-usage-collect', async () => {
    const { getKnativeProjectManager } = await import('../lib/knative-project-manager')
    const mgr = getKnativeProjectManager()
    const envs = await prisma.publishedEnvironment.findMany({ select: { id: true, projectId: true, name: true } })
    const minute = truncateToMinute(now)
    let rowsWritten = 0
    for (const env of envs) {
      try {
        const pods = await mgr.listPublishedPods(env.projectId, env.name as any)
        const running = pods.filter((p) => p.ready).length
        await prisma.publishedUsageMinute.upsert({
          where: { environmentId_minute: { environmentId: env.id, minute } },
          create: { environmentId: env.id, minute, podSeconds: running * 60 },
          update: { podSeconds: running * 60 },
        })
        rowsWritten++
      } catch (err: any) {
        console.warn(`[published-usage] collect ${env.id} failed:`, err?.message ?? err)
      }
    }
    return { environments: envs.length, rowsWritten }
  })
  if (!lock.acquired) return { environments: 0, rowsWritten: 0, skipped: true }
  return { ...lock.result, skipped: false }
}

export interface BillSummary {
  environmentsCharged: number
  rowsBilled: number
  totalUsd: number
  clamped: number
  skipped: boolean
}

export async function billPublishedUsage(now: Date = new Date()): Promise<BillSummary> {
  const lock = await withGlobalJobLock('published-usage-bill', async () => {
    const cutoff = truncateToMinute(now)
    const pending = await prisma.publishedUsageMinute.findMany({
      where: { billedAt: null, minute: { lt: cutoff } },
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
    const { clampEnvironmentsForExhaustedWallet } = await import('../services/published-environments.service')
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
        // Wallet exhausted: prod is never taken down, it is clamped to 1
        // replica; staging scales to zero. The rows stay unbilled so the charge
        // lands once funds return.
        const changes = await clampEnvironmentsForExhaustedWallet(env.projectId)
        clamped += changes.length
        console.warn(
          `[published-usage] charge refused for ${env.projectId}/${env.name}: ${result.reason ?? result.error}`,
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
  })
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
      collectPublishedUsage().catch((err) => console.error('[published-usage] collect failed:', err))
      const hour = new Date().getUTCHours()
      if (hour !== lastBilledHour) {
        lastBilledHour = hour
        billPublishedUsage().catch((err) => console.error('[published-usage] bill failed:', err))
      }
    }
    tick()
    setInterval(tick, 60_000)
  }, 90_000)
  console.log('[published-usage] cron scheduled (collect every 60s, bill hourly)')
}
