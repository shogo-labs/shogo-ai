// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Storage Service — S3 workspace storage tracking.
 *
 * Calculates and caches per-workspace S3 usage by summing object sizes
 * across all projects in the workspace. Excludes shared deps cache.
 */

import { prisma } from '../lib/prisma'
import { listAllObjectsInS3 } from '../lib/s3'
import { INSTANCE_SIZES, type InstanceSizeName } from '../config/instance-sizes'
import { withGlobalJobLock } from '../lib/global-job-lock'

const S3_WORKSPACES_BUCKET = process.env.S3_WORKSPACES_BUCKET || 'shogo-workspaces'

/**
 * Minimum gap between two fleet-wide recalculation passes.
 *
 * Every API pod schedules the pass (boot + every 6h) and the global advisory
 * lock only stops passes that *overlap*, so pods that boot at different times
 * each ran a full sweep — ~61 passes/day against 4 intended (PERF-1).
 *
 * 5h, not 5.5h: `lastCalculatedAt` is written per workspace as it *finishes*,
 * so the max marks the END of a pass that may have started tens of minutes
 * earlier. A 5.5h gate would make the next 6h tick (only 5h20m after a
 * 40-minute pass) skip a whole cycle; staggered pods tick often, so 5h still
 * lands roughly one pass every 5–6h.
 */
export const STORAGE_RECALC_MIN_GAP_MS = 5 * 60 * 60 * 1000

export type StorageRecalcStatus = 'ran' | 'fresh' | 'locked'

export interface StorageRecalcOutcome {
  /** `fresh` = a pass finished recently, `locked` = another pod held the lock. */
  status: StorageRecalcStatus
  /** Workspaces scanned. Only present when `status === 'ran'`. */
  workspaces?: number
}

export interface StorageBreakdown {
  totalBytes: number
  limitBytes: number
  projectCount: number
  percentUsed: number
  isOverLimit: boolean
  projects: Array<{
    projectId: string
    projectName: string
    bytes: number
  }>
  lastCalculatedAt: Date | null
}

export async function getStorageUsage(workspaceId: string): Promise<StorageBreakdown | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      instanceSize: true,
      storageUsage: true,
    },
  })
  if (!workspace) return null

  const size = workspace.instanceSize as InstanceSizeName
  const limitBytes = INSTANCE_SIZES[size].storageLimitBytes
  const totalBytes = workspace.storageUsage ? Number(workspace.storageUsage.totalBytes) : 0

  // `hidden: false` — this feeds `projects[].projectName` in the UI storage
  // breakdown, so hidden (companion builder-delegate) project names must not
  // leak here. `calculateWorkspaceStorageUsage` below deliberately does NOT
  // filter hidden projects: hidden projects still consume real S3 bytes and
  // must still count against the workspace's storage quota.
  const projects = await prisma.project.findMany({
    where: { workspaceId, hidden: false },
    select: { id: true, name: true },
  })

  return {
    totalBytes,
    limitBytes,
    projectCount: projects.length,
    percentUsed: limitBytes > 0 ? Math.min((totalBytes / limitBytes) * 100, 100) : 0,
    isOverLimit: totalBytes > limitBytes,
    projects: projects.map((p) => ({
      projectId: p.id,
      projectName: p.name,
      bytes: 0, // Per-project breakdown is populated by calculateWorkspaceStorageUsage
    })),
    lastCalculatedAt: workspace.storageUsage?.lastCalculatedAt ?? null,
  }
}

/**
 * Calculate actual S3 storage usage for a workspace by listing objects
 * for each project. Updates the StorageUsage row in the database.
 */
export async function calculateWorkspaceStorageUsage(workspaceId: string): Promise<{
  totalBytes: number
  projectCount: number
  perProject: Array<{ projectId: string; bytes: number }>
}> {
  // Intentionally includes hidden projects: this computes the actual S3
  // bytes backing the workspace's storage quota, and hidden projects
  // consume real storage regardless of whether they're user-visible.
  const projects = await prisma.project.findMany({
    where: { workspaceId },
    select: { id: true },
  })

  let totalBytes = 0
  const perProject: Array<{ projectId: string; bytes: number }> = []

  for (const project of projects) {
    try {
      const objects = await listAllObjectsInS3(`${project.id}/`, S3_WORKSPACES_BUCKET)
      const projectBytes = objects.reduce((sum, obj) => sum + (obj.size || 0), 0)

      // Also check postgres backups
      let backupBytes = 0
      try {
        const backups = await listAllObjectsInS3(`postgres-backups/${project.id}/`, S3_WORKSPACES_BUCKET)
        backupBytes = backups.reduce((sum, obj) => sum + (obj.size || 0), 0)
      } catch {
        // Backup prefix may not exist
      }

      const total = projectBytes + backupBytes
      totalBytes += total
      perProject.push({ projectId: project.id, bytes: total })
    } catch (err: any) {
      console.error(`[Storage] Failed to calculate storage for project ${project.id}:`, err.message)
      perProject.push({ projectId: project.id, bytes: 0 })
    }
  }

  const now = new Date()

  await prisma.storageUsage.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      totalBytes: BigInt(totalBytes),
      projectCount: projects.length,
      lastCalculatedAt: now,
    },
    update: {
      totalBytes: BigInt(totalBytes),
      projectCount: projects.length,
      lastCalculatedAt: now,
    },
  })

  return { totalBytes, projectCount: projects.length, perProject }
}

export async function isOverStorageLimit(workspaceId: string): Promise<boolean> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      instanceSize: true,
      storageUsage: { select: { totalBytes: true } },
    },
  })

  if (!workspace?.storageUsage) return false

  const size = workspace.instanceSize as InstanceSizeName
  const limit = INSTANCE_SIZES[size].storageLimitBytes
  return Number(workspace.storageUsage.totalBytes) > limit
}

/**
 * Recalculate storage for all workspaces. Intended to be called
 * periodically (e.g., every 6 hours) from a cron/timer.
 *
 * Multi-region safety: wrapped in `withGlobalJobLock('storage-recalculate-all')`
 * so that across all API replicas in US/EU/India exactly one writer
 * runs per tick. Without this, every region's 6h tick concurrently
 * upserts on `storage_usage.workspaceId` (a non-PK unique index),
 * which logical replication's `last_update_wins` cannot resolve and
 * which would poison the apply worker until manually unwedged — same
 * failure class as the 2026-05-21 `analytics_digests` incident. See
 * `apps/api/src/lib/global-job-lock.ts` for the lock contract.
 *
 * The advisory lock only stops *overlapping* passes, and every pod schedules
 * its own (boot + 6h), so pods booting at different times each ran a full
 * sweep — ~61 passes/day against 4 intended (PERF-1). The freshness gate below
 * skips the sweep when `storage_usage.lastCalculatedAt` shows one finished
 * within `STORAGE_RECALC_MIN_GAP_MS`. `calculateWorkspaceStorageUsage` has
 * exactly one caller (this pass), so that timestamp already means "the fleet
 * pass touched this workspace". No new table, no schema change, and because
 * `storage_usage` is replicated an EU pod sees a US pass too.
 */
export async function recalculateAllStorageUsage(): Promise<StorageRecalcOutcome> {
  const lock = await withGlobalJobLock<StorageRecalcOutcome>(
    'storage-recalculate-all',
    async () => {
      const { _max } = await prisma.storageUsage.aggregate({
        _max: { lastCalculatedAt: true },
      })
      const lastCalculatedAt = _max.lastCalculatedAt ?? null

      if (lastCalculatedAt) {
        // `null` max (empty table) means a fresh environment: always run.
        const ageMs = Date.now() - new Date(lastCalculatedAt).getTime()
        if (ageMs < STORAGE_RECALC_MIN_GAP_MS) {
          console.log(
            `[Storage] Skipping recalculation: last pass finished ${Math.round(ageMs / 60_000)}m ago`,
          )
          return { status: 'fresh' as const }
        }
      }

      const workspaces = await prisma.workspace.findMany({
        select: { id: true },
      })

      console.log(`[Storage] Recalculating storage for ${workspaces.length} workspaces`)

      for (const ws of workspaces) {
        try {
          await calculateWorkspaceStorageUsage(ws.id)
        } catch (err: any) {
          console.error(`[Storage] Failed to recalculate for workspace ${ws.id}:`, err.message)
        }
      }

      console.log(`[Storage] Recalculation complete`)

      return { status: 'ran' as const, workspaces: workspaces.length }
    },
  )

  if (!lock.acquired) return { status: 'locked' }
  return lock.result
}
