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

const S3_WORKSPACES_BUCKET = process.env.S3_WORKSPACES_BUCKET || 'shogo-workspaces'

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

  const projects = await prisma.project.findMany({
    where: { workspaceId },
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
 */
export async function recalculateAllStorageUsage() {
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
}
