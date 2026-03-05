/**
 * Infrastructure Metrics Collector
 *
 * Periodically snapshots cluster and warm pool state into the database,
 * giving the admin dashboard historical infrastructure data instead of
 * live-only views that are lost on page refresh or API restart.
 *
 * Runs in-process via setInterval (same pattern as the warm pool reconciler
 * and billing session cleanup). Only active in Kubernetes environments
 * where the warm pool controller and Knative manager are available.
 */

import type { PrismaClient } from '../generated/prisma/client'

const SNAPSHOT_INTERVAL_MS = 60_000
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000
const RETENTION_DAYS = 90

let snapshotTimer: ReturnType<typeof setInterval> | null = null
let pruneTimer: ReturnType<typeof setInterval> | null = null

async function collectSnapshot(prisma: PrismaClient): Promise<void> {
  try {
    const { getWarmPoolController } = await import('./warm-pool-controller')
    const controller = getWarmPoolController()
    const extended = await controller.getExtendedStatus()

    if (!extended.cluster) {
      console.warn('[InfraCollector] cluster data is null — getCapacitySummary() likely failed (check RBAC: pods list permission)')
    }

    let projectStats = { total: 0, ready: 0, running: 0, scaled_to_zero: 0 }
    try {
      const { getKnativeProjectManager } = await import('./knative-project-manager')
      const manager = getKnativeProjectManager()
      const allServices = await manager.listAllServices()
      projectStats = {
        total: allServices.length,
        ready: allServices.filter((s: any) => s.status.ready).length,
        running: allServices.filter((s: any) => s.status.replicas > 0).length,
        scaled_to_zero: allServices.filter((s: any) => s.status.replicas === 0).length,
      }
    } catch (err: any) {
      console.warn('[InfraCollector] Failed to list Knative services:', err.message)
    }

    const warmAvail =
      (extended.available?.project ?? 0) + (extended.available?.agent ?? 0)
    const warmTgt =
      (extended.targetSize?.project ?? 0) + (extended.targetSize?.agent ?? 0)

    await prisma.infraSnapshot.create({
      data: {
        totalNodes: extended.cluster?.totalNodes ?? 0,
        asgDesired: extended.cluster?.asgDesired ?? 0,
        asgMax: extended.cluster?.asgMax ?? 0,
        totalPodSlots: extended.cluster?.totalPodSlots ?? 0,
        usedPodSlots: extended.cluster?.usedPodSlots ?? 0,
        totalCpuMillis: extended.cluster?.totalCpuMillis ?? 0,
        usedCpuMillis: extended.cluster?.usedCpuMillis ?? 0,
        limitCpuMillis: extended.cluster?.limitCpuMillis ?? 0,
        warmAvailable: warmAvail,
        warmTarget: warmTgt,
        warmAssigned: extended.assigned ?? 0,
        coldStarts: 0,
        totalProjects: projectStats.total,
        readyProjects: projectStats.ready,
        runningProjects: projectStats.running,
        scaledToZero: projectStats.scaled_to_zero,
        orphansDeleted: extended.gcStats?.orphansDeleted ?? 0,
        idleEvictions: extended.gcStats?.idleEvictions ?? 0,
      },
    })
  } catch (err: any) {
    console.error('[InfraCollector] Snapshot failed:', err.message)
  }
}

async function pruneOldSnapshots(prisma: PrismaClient): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
    const { count } = await prisma.infraSnapshot.deleteMany({
      where: { timestamp: { lt: cutoff } },
    })
    if (count > 0) {
      console.log(`[InfraCollector] Pruned ${count} snapshots older than ${RETENTION_DAYS}d`)
    }
  } catch (err: any) {
    console.error('[InfraCollector] Prune failed:', err.message)
  }
}

export function startInfraMetricsCollector(prisma: PrismaClient): void {
  if (snapshotTimer) return

  console.log('[InfraCollector] Starting infrastructure metrics collector (60s interval)')

  collectSnapshot(prisma)
  snapshotTimer = setInterval(() => collectSnapshot(prisma), SNAPSHOT_INTERVAL_MS)

  pruneOldSnapshots(prisma)
  pruneTimer = setInterval(() => pruneOldSnapshots(prisma), PRUNE_INTERVAL_MS)
}

export function stopInfraMetricsCollector(): void {
  if (snapshotTimer) {
    clearInterval(snapshotTimer)
    snapshotTimer = null
  }
  if (pruneTimer) {
    clearInterval(pruneTimer)
    pruneTimer = null
  }
}
