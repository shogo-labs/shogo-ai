// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Storage Service — S3 metering for billing (SHO-423).
 *
 * Measures every byte a workspace owns in object storage, by category and by
 * project, keeps a per-day history, and exposes it to the workspace settings and
 * the super-admin views. `jobs/storage-usage-bill.ts` turns the history into
 * GB-month charges above the tier allowance.
 *
 * ## Categories
 *
 * | category         | where it lives                                                        | billed |
 * |------------------|-----------------------------------------------------------------------|--------|
 * | `project_files`  | `<projectId>/` — the live project files                                | yes    |
 * | `repo`           | `<projectId>/repo*`, `<projectId>/lfs/objects/…`, a separate LFS bucket | yes    |
 * | `assets`         | `<projectId>/assets/`                                                  | yes    |
 * | `backups`        | `<projectId>/project-data*`, `postgres-backups/<projectId>/`          | yes    |
 * | `quarantine`     | `conflict/<projectId>/` — sync-conflict archives we created           | **no** |
 * | `chat_files`     | `artifacts/chat-attachments/<session>/`, `artifacts/conversations/<ws>/`, `artifacts/avatars/<user>/` | yes |
 * | `workspace_root` | `workspace-root/<workspaceId>/` — the durable workspace drive root     | yes    |
 * | `published`      | `PUBLISH_BUCKET/<subdomain>/`, `PUBLISH_DATA_BUCKET/<subdomain>/`      | yes    |
 * | `vm_snapshots`   | `METAL_SNAP_BUCKET/metal-snapshots/<projectId>/snapshot/`              | **no** |
 *
 * The two overhead categories are ours, not the customer's: they are measured
 * and shown, and excluded from `billableBytes`.
 *
 * ## One listing per shared namespace, not one per workspace
 *
 * `conflict/`, `postgres-backups/`, `workspace-root/`, the artifact bucket and
 * the publish buckets are keyed by something we can resolve to a workspace, so a
 * pass lists each of them ONCE and attributes every object — see
 * `measureStorageForWorkspaces`. Only the project prefixes are listed per
 * project. A bucket whose env var is unset is *unmeasured*, never 0.
 *
 * Hidden projects still count: they consume real S3 bytes and must count against
 * the workspace's storage, even though their names never reach a member's UI.
 */

import { prisma } from '../lib/prisma'
import { listAllArtifactObjects, listAllObjectsInS3, type ListedObject } from '../lib/s3'
import { INSTANCE_SIZES, type InstanceSizeName } from '../config/instance-sizes'
import { withGlobalJobLock } from '../lib/global-job-lock'
import { homeRegionWorkspaceWhere } from '../lib/region'
import {
  STORAGE_USD_PER_GB_MONTH,
  bytesToGb,
  storageBillingMode,
  storageDayGbMonths,
} from '../config/storage-pricing'

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

/** How many days of `StorageUsageDaily` the settings/admin views show. */
export const STORAGE_HISTORY_DAYS = 30

export type StorageRecalcStatus = 'ran' | 'fresh' | 'locked'

export interface StorageRecalcOutcome {
  /** `fresh` = a pass finished recently, `locked` = another pod held the lock. */
  status: StorageRecalcStatus
  /** Workspaces scanned. Only present when `status === 'ran'`. */
  workspaces?: number
}

export const STORAGE_CATEGORIES = [
  'project_files',
  'repo',
  'assets',
  'backups',
  'quarantine',
  'chat_files',
  'workspace_root',
  'published',
  'vm_snapshots',
] as const

export type StorageCategory = (typeof STORAGE_CATEGORIES)[number]

/**
 * Platform overhead: bytes we created on the customer's behalf (conflict
 * quarantine, VM snapshots). Measured and reported, never billed.
 */
export const OVERHEAD_STORAGE_CATEGORIES: readonly StorageCategory[] = ['quarantine', 'vm_snapshots']

const OVERHEAD = new Set<StorageCategory>(OVERHEAD_STORAGE_CATEGORIES)

export type StorageCategoryBytes = Record<StorageCategory, number>

export function emptyCategoryBytes(): StorageCategoryBytes {
  const out = {} as StorageCategoryBytes
  for (const category of STORAGE_CATEGORIES) out[category] = 0
  return out
}

export function sumCategories(categories: StorageCategoryBytes): number {
  let total = 0
  for (const category of STORAGE_CATEGORIES) total += categories[category] || 0
  return total
}

/** Total minus the overhead categories — what a customer is charged for. */
export function billableCategories(categories: StorageCategoryBytes): number {
  let total = 0
  for (const category of STORAGE_CATEGORIES) {
    if (OVERHEAD.has(category)) continue
    total += categories[category] || 0
  }
  return total
}

/** The `StorageUsage.breakdown` / `StorageUsageDaily.breakdown` shape. */
export interface StorageBreakdownRecord {
  categories: StorageCategoryBytes
  projects: Array<{ projectId: string; bytes: number; categories: Partial<StorageCategoryBytes> }>
  /** Namespaces this pass could not read (bucket env unset, list failed). */
  unmeasured: string[]
}

export interface StorageMeasurement {
  workspaceId: string
  totalBytes: number
  billableBytes: number
  projectCount: number
  categories: StorageCategoryBytes
  projects: Array<{ projectId: string; bytes: number; categories: Partial<StorageCategoryBytes> }>
  unmeasured: string[]
}

function workspacesBucket(): string {
  const configured = (process.env.S3_WORKSPACES_BUCKET || '').trim()
  return configured || 'shogo-workspaces'
}

function envBucket(...names: string[]): string | null {
  for (const name of names) {
    const value = (process.env[name] || '').trim()
    if (value) return value
  }
  return null
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+/, '')
}

/**
 * Which category an object under `<projectId>/` belongs to. Everything not
 * matched explicitly is a project file — the live working copy.
 */
export function classifyProjectObject(relativePath: string): StorageCategory {
  const first = relativePath.split('/')[0] ?? ''
  // `repo.git.tar.gz` (accepted repo archive), `repo/…` (bare repo + manifest)
  // and, on a shared bucket, `lfs/objects/…`. Matched exactly — a directory like
  // `reports/` merely shares the prefix and is a project file.
  if (first === 'repo' || first.startsWith('repo.git') || first === 'lfs') return 'repo'
  if (first === 'assets') return 'assets'
  // `project-data.tar.gz` (the SQLite/db/uploads archive) and
  // `project-data/daily/<date>.tar.gz` restore points.
  if (first.startsWith('project-data')) return 'backups'
  return 'project_files'
}

interface Accumulator {
  workspaceId: string
  categories: StorageCategoryBytes
  projects: Map<string, StorageCategoryBytes>
  unmeasured: Set<string>
}

function newAccumulator(workspaceId: string): Accumulator {
  return { workspaceId, categories: emptyCategoryBytes(), projects: new Map(), unmeasured: new Set() }
}

function addObject(
  acc: Accumulator | undefined,
  category: StorageCategory,
  bytes: number,
  projectId?: string,
): void {
  if (!acc || !(bytes > 0)) return
  acc.categories[category] += bytes
  if (!projectId) return
  let project = acc.projects.get(projectId)
  if (!project) {
    project = emptyCategoryBytes()
    acc.projects.set(projectId, project)
  }
  project[category] += bytes
}

/**
 * Measure one workspace, or the whole (home-region) fleet.
 *
 * `workspaceIds === null` means "every workspace this region is home to"; the
 * 6h pass uses that so each shared namespace is listed exactly once.
 */
export async function measureStorageForWorkspaces(
  workspaceIds: string[] | null,
): Promise<Map<string, StorageMeasurement>> {
  const home = homeRegionWorkspaceWhere()
  const where: Record<string, unknown> = { ...(home ?? {}) }
  if (workspaceIds) where.id = { in: workspaceIds }

  const workspaces = (await prisma.workspace.findMany({
    where,
    select: { id: true, instanceSize: true, personalOwnerId: true },
  })) as Array<{ id: string; instanceSize: string | null; personalOwnerId: string | null }>
  if (workspaces.length === 0) return new Map()

  const accumulators = new Map<string, Accumulator>()
  for (const ws of workspaces) accumulators.set(ws.id, newAccumulator(ws.id))

  /** Namespaces missing configuration, applied to every workspace's breakdown. */
  const unmeasuredGlobally = new Set<string>()

  const projects = (await prisma.project.findMany({
    where: { workspaceId: { in: workspaces.map((w) => w.id) } },
    select: { id: true, workspaceId: true },
  })) as Array<{ id: string; workspaceId: string }>
  const projectWorkspace = new Map(projects.map((p) => [p.id, p.workspaceId]))

  const bucket = workspacesBucket()

  // 1) Per-project bytes. One listing per project prefix: bounded memory, and
  //    this is the only namespace we can't key without the id we already have.
  for (const project of projects) {
    const acc = accumulators.get(project.workspaceId)
    if (!acc) continue
    try {
      const objects = await listAllObjectsInS3(`${project.id}/`, bucket)
      for (const object of objects) {
        addObject(acc, classifyProjectObject(object.relativePath), object.size || 0, project.id)
      }
    } catch (error: any) {
      console.error(`[Storage] Failed to calculate storage for project ${project.id}:`, error?.message ?? error)
      acc.unmeasured.add(`projects/${project.id}`)
    }
  }

  // 2) A separate LFS bucket, when one is configured: its objects are keyed
  //    `<projectId>/lfs/objects/…`, so they are repo bytes for that project.
  const lfsBucket = envBucket('S3_LFS_BUCKET')
  if (lfsBucket && lfsBucket !== bucket) {
    for (const project of projects) {
      const acc = accumulators.get(project.workspaceId)
      if (!acc) continue
      try {
        const objects = await listAllObjectsInS3(`${project.id}/`, lfsBucket)
        for (const object of objects) {
          addObject(acc, 'repo', object.size || 0, project.id)
        }
      } catch (error: any) {
        console.error(`[Storage] Failed to list LFS objects for project ${project.id}:`, error?.message ?? error)
        acc.unmeasured.add(`lfs/${project.id}`)
      }
    }
  }

  // 3) Shared namespaces on the workspaces bucket, one listing each:
  //    `conflict/<projectId>/`, `postgres-backups/<projectId>/` and
  //    `workspace-root/<workspaceId>/`.
  const sharedNamespaces: Array<{ prefix: string; category: StorageCategory }> = [
    { prefix: 'conflict/', category: 'quarantine' },
    { prefix: 'postgres-backups/', category: 'backups' },
    { prefix: 'workspace-root/', category: 'workspace_root' },
  ]
  for (const { prefix, category } of sharedNamespaces) {
    try {
      const objects = await listAllObjectsInS3(prefix, bucket)
      for (const object of objects) {
        const key = object.relativePath.split('/')[0]
        if (!key) continue
        if (category === 'workspace_root') {
          const acc = accumulators.get(key)
          if (acc) addObject(acc, category, object.size || 0)
          continue
        }
        const workspaceId = projectWorkspace.get(key)
        if (!workspaceId) continue
        addObject(accumulators.get(workspaceId), category, object.size || 0, key)
      }
    } catch (error: any) {
      console.error(`[Storage] Failed to list s3://${bucket}/${prefix}:`, error?.message ?? error)
      unmeasuredGlobally.add(prefix)
    }
  }

  // 4) The artifact bucket: chat attachments, conversation files and avatars.
  //    `getArtifactBucket()` falls back to the schema bucket, so a deployment
  //    without split artifact storage still lands here.
  const artifactBucketConfigured = !!envBucket('S3_ARTIFACT_BUCKET', 'S3_SCHEMA_BUCKET')
  if (!artifactBucketConfigured) {
    unmeasuredGlobally.add('artifacts')
  } else {
    const sessionWorkspace = await loadSessionWorkspaces(
      workspaces.map((w) => w.id),
      projectWorkspace,
    )
    const personalWorkspaceByUser = new Map<string, string>()
    for (const ws of workspaces) {
      if (ws.personalOwnerId) personalWorkspaceByUser.set(ws.personalOwnerId, ws.id)
    }

    // Chat attachments: `artifacts/chat-attachments/<sessionId>/<digest>.<ext>`
    try {
      const objects = await listAllArtifactObjects('artifacts/chat-attachments/')
      for (const object of objects) {
        const sessionId = object.relativePath.split('/')[0]
        const workspaceId = sessionId ? sessionWorkspace.get(sessionId) : undefined
        if (!workspaceId) continue
        addObject(accumulators.get(workspaceId), 'chat_files', object.size || 0)
      }
    } catch (error: any) {
      console.error('[Storage] Failed to list chat attachments:', error?.message ?? error)
      unmeasuredGlobally.add('artifacts/chat-attachments/')
    }

    // Conversation (channel) files: `artifacts/conversations/<workspaceId>/…`
    try {
      const objects = await listAllArtifactObjects('artifacts/conversations/')
      for (const object of objects) {
        const workspaceId = object.relativePath.split('/')[0]
        const acc = workspaceId ? accumulators.get(workspaceId) : undefined
        addObject(acc, 'chat_files', object.size || 0)
      }
    } catch (error: any) {
      console.error('[Storage] Failed to list conversation files:', error?.message || error)
      unmeasuredGlobally.add('artifacts/conversations/')
    }

    // Avatars: `artifacts/avatars/<userId>/<contentKey>`. An avatar is
    // user-owned, so it is attributed to that user's personal workspace — the
    // one workspace every account has exactly one of.
    try {
      const objects = await listAllArtifactObjects('artifacts/avatars/')
      for (const object of objects) {
        const userId = object.relativePath.split('/')[0]
        const workspaceId = userId ? personalWorkspaceByUser.get(userId) : undefined
        addObject(workspaceId ? accumulators.get(workspaceId) : undefined, 'chat_files', object.size || 0)
      }
    } catch (error: any) {
      console.error('[Storage] Failed to list avatars:', error?.message ?? error)
      unmeasuredGlobally.add('artifacts/avatars/')
    }
  }

  // 5) Published sites: `PUBLISH_BUCKET/<subdomain>/` (static bundle) and
  //    `PUBLISH_DATA_BUCKET/<subdomain>/data.tar.gz` (writable state).
  const publishBucket = envBucket('PUBLISH_BUCKET')
  const publishDataBucket = envBucket('PUBLISH_DATA_BUCKET', 'S3_PUBLISHED_DATA_BUCKET')
  if (!publishBucket) unmeasuredGlobally.add('PUBLISH_BUCKET')
  if (!publishDataBucket) unmeasuredGlobally.add('PUBLISH_DATA_BUCKET')
  if (publishBucket || publishDataBucket) {
    const projectIds = projects.map((p) => p.id)
    const environments = (await prisma.publishedEnvironment.findMany({
      where: { projectId: { in: projectIds } },
      select: { subdomain: true, projectId: true },
    })) as Array<{ subdomain: string; projectId: string }>
    const subdomainWorkspace = new Map<string, string>()
    for (const environment of environments) {
      const workspaceId = projectWorkspace.get(environment.projectId)
      if (workspaceId) subdomainWorkspace.set(environment.subdomain, workspaceId)
    }

    const buckets: Array<{ id: string; bucket: string }> = []
    if (publishBucket) buckets.push({ id: 'PUBLISH_BUCKET', bucket: publishBucket })
    // Same bucket for both roles: the one listing already counted the data
    // archive, so listing it twice would double-count.
    if (publishDataBucket && publishDataBucket !== publishBucket) {
      buckets.push({ id: 'PUBLISH_DATA_BUCKET', bucket: publishDataBucket })
    }
    for (const { id, bucket: publishTarget } of buckets) {
      try {
        const objects = await listAllObjectsInS3('', publishTarget)
        for (const object of objects) {
          const subdomain = object.relativePath.split('/')[0]
          const workspaceId = subdomain ? subdomainWorkspace.get(subdomain) : undefined
          addObject(accumulators.get(workspaceId ?? ''), 'published', object.size || 0)
        }
      } catch (error: any) {
        console.error(`[Storage] Failed to list ${id}:`, error?.message ?? error)
        unmeasuredGlobally.add(id)
      }
    }
  }

  // 6) Metal VM snapshots: `metal-snapshots/<projectId>/snapshot/…`. Platform
  //    overhead — we created them, so they are reported but never billed.
  const metalBucket = envBucket('METAL_SNAP_BUCKET')
  if (!metalBucket) {
    unmeasuredGlobally.add('METAL_SNAP_BUCKET')
  } else {
    const metalPrefix = normalizePrefix(envBucket('METAL_FLEET_S3_PREFIX') || 'metal-snapshots/')
    try {
      const objects: ListedObject[] = await listAllObjectsInS3(metalPrefix, metalBucket)
      for (const object of objects) {
        const projectId = object.relativePath.split('/')[0]
        const workspaceId = projectId ? projectWorkspace.get(projectId) : undefined
        if (!workspaceId) continue
        addObject(accumulators.get(workspaceId), 'vm_snapshots', object.size || 0, projectId)
      }
    } catch (error: any) {
      console.error(`[Storage] Failed to list s3://${metalBucket}/${metalPrefix}:`, error?.message ?? error)
      unmeasuredGlobally.add('METAL_SNAP_BUCKET')
    }
  }

  const measurements = new Map<string, StorageMeasurement>()
  for (const ws of workspaces) {
    const acc = accumulators.get(ws.id)!
    const categories = acc.categories
    const projectList = Array.from(acc.projects.entries())
      .map(([projectId, projectCategories]) => ({
        projectId,
        bytes: sumCategories(projectCategories),
        categories: projectCategories,
      }))
      .sort((a, b) => b.bytes - a.bytes)
    measurements.set(ws.id, {
      workspaceId: ws.id,
      totalBytes: sumCategories(categories),
      billableBytes: billableCategories(categories),
      projectCount: projects.filter((p) => p.workspaceId === ws.id).length,
      categories,
      projects: projectList,
      unmeasured: Array.from(new Set([...unmeasuredGlobally, ...acc.unmeasured])).sort(),
    })
  }

  return measurements
}

/**
 * Map a chat session to its workspace. Sessions for a project chat carry the
 * project in `contextId`, not a workspace, so they are resolved through the
 * project map we already loaded.
 */
async function loadSessionWorkspaces(
  workspaceIds: string[],
  projectWorkspace: Map<string, string>,
): Promise<Map<string, string>> {
  const sessions = (await prisma.chatSession.findMany({
    where: {
      OR: [
        { workspaceId: { in: workspaceIds } },
        { contextType: 'project', contextId: { in: Array.from(projectWorkspace.keys()) } },
      ],
    },
    select: { id: true, workspaceId: true, contextType: true, contextId: true },
  })) as Array<{ id: string; workspaceId: string | null; contextType: string | null; contextId: string | null }>

  const map = new Map<string, string>()
  for (const session of sessions) {
    const workspaceId =
      session.workspaceId ??
      (session.contextId ? projectWorkspace.get(session.contextId) : undefined)
    if (workspaceId) map.set(session.id, workspaceId)
  }
  return map
}

function startOfUtcDay(date: Date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function allowanceBytesFor(instanceSize: string | null | undefined): number {
  const spec = INSTANCE_SIZES[(instanceSize ?? 'micro') as InstanceSizeName]
  return spec?.storageLimitBytes ?? 0
}

/** Parse `breakdown` from either a Json column (PG) or a JSON string (SQLite). */
export function parseBreakdown(value: unknown): StorageBreakdownRecord | null {
  if (!value) return null
  let raw: any = value
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!raw || typeof raw !== 'object') return null
  const categories = emptyCategoryBytes()
  for (const category of STORAGE_CATEGORIES) {
    const bytes = Number(raw.categories?.[category] ?? 0)
    categories[category] = Number.isFinite(bytes) ? bytes : 0
  }
  const projects = Array.isArray(raw.projects)
    ? raw.projects.map((project: any) => ({
        projectId: String(project?.projectId ?? ''),
        bytes: Number(project?.bytes ?? 0) || 0,
        categories: (project?.categories ?? {}) as Partial<StorageCategoryBytes>,
      }))
    : []
  const unmeasured = Array.isArray(raw.unmeasured) ? raw.unmeasured.map((id: any) => String(id)) : []
  return { categories, projects, unmeasured }
}

/**
 * Measure one workspace and persist the result: the current row in
 * `storage_usage`, plus today's row in `storage_usage_daily` (max bytes win, so
 * several passes in one UTC day leave one row holding the day's peak).
 */
export async function calculateWorkspaceStorageUsage(workspaceId: string): Promise<StorageMeasurement> {
  const measurement = (await measureStorageForWorkspaces([workspaceId])).get(workspaceId)
  if (!measurement) {
    // The workspace row is gone (deleted mid-pass). Report zeros and write
    // nothing: the cascade already dropped its usage rows.
    return {
      workspaceId,
      totalBytes: 0,
      billableBytes: 0,
      projectCount: 0,
      categories: emptyCategoryBytes(),
      projects: [],
      unmeasured: [],
    }
  }
  await persistMeasurement(measurement)
  return measurement
}

/** Write one workspace's measurement to the current row and today's daily row. */
export async function persistMeasurement(
  measurement: StorageMeasurement,
  now: Date = new Date(),
): Promise<void> {
  const workspace = (await prisma.workspace.findUnique({
    where: { id: measurement.workspaceId },
    select: { instanceSize: true },
  })) as { instanceSize: string | null } | null
  if (!workspace) return

  const breakdown: StorageBreakdownRecord = {
    categories: measurement.categories,
    projects: measurement.projects,
    unmeasured: measurement.unmeasured,
  }

  await prisma.storageUsage.upsert({
    where: { workspaceId: measurement.workspaceId },
    create: {
      workspaceId: measurement.workspaceId,
      totalBytes: BigInt(measurement.totalBytes),
      billableBytes: BigInt(measurement.billableBytes),
      projectCount: measurement.projectCount,
      breakdown: breakdown as any,
      lastCalculatedAt: now,
    },
    update: {
      totalBytes: BigInt(measurement.totalBytes),
      billableBytes: BigInt(measurement.billableBytes),
      projectCount: measurement.projectCount,
      breakdown: breakdown as any,
      lastCalculatedAt: now,
    },
  })

  await upsertDailyRow(measurement, workspace.instanceSize, now)
}

/**
 * Today's row keeps the MAXIMUM bytes seen that day: a workspace that shrinks
 * mid-day still pays for the peak, exactly like a daily storage invoice.
 */
async function upsertDailyRow(
  measurement: StorageMeasurement,
  instanceSize: string | null,
  now: Date,
): Promise<void> {
  const day = startOfUtcDay(now)
  const allowanceBytes = allowanceBytesFor(instanceSize)
  const existing = await prisma.storageUsageDaily.findUnique({
    where: { workspaceId_day: { workspaceId: measurement.workspaceId, day } },
    select: { id: true, totalBytes: true },
  })

  if (!existing) {
    await prisma.storageUsageDaily
      .create({
        data: {
          workspaceId: measurement.workspaceId,
          day,
          totalBytes: BigInt(measurement.totalBytes),
          billableBytes: BigInt(measurement.billableBytes),
          allowanceBytes: BigInt(allowanceBytes),
          breakdown: {
            categories: measurement.categories,
            projects: measurement.projects,
            unmeasured: measurement.unmeasured,
          } as any,
        },
      })
      .catch((error: any) => {
        // Another pod created today's row between the read and the insert.
        if (error?.code === 'P2002') return
        throw error
      })
    return
  }

  if (Number(existing.totalBytes) >= measurement.totalBytes) return

  await prisma.storageUsageDaily.update({
    where: { id: existing.id },
    data: {
      totalBytes: BigInt(measurement.totalBytes),
      billableBytes: BigInt(measurement.billableBytes),
      allowanceBytes: BigInt(allowanceBytes),
      breakdown: {
        categories: measurement.categories,
        projects: measurement.projects,
        unmeasured: measurement.unmeasured,
      } as any,
    },
  })
}

// ============================================================================
// Read paths
// ============================================================================

export interface StorageHistoryDay {
  /** `YYYY-MM-DD` (UTC). */
  day: string
  totalBytes: number
  billableBytes: number
  allowanceBytes: number
  chargedUsd: number | null
  billedAt: Date | null
}

export interface StorageMonthEstimate {
  /** GB-months accrued this calendar month (UTC), prorated per day. */
  billableGbMonths: number
  /** USD those GB-months come to at the configured rate. */
  estimatedUsd: number
  /** `shadow` = recorded, not charged. */
  mode: 'shadow' | 'enforce'
}

export interface StorageUsageDetail {
  totalBytes: number
  billableBytes: number
  limitBytes: number
  projectCount: number
  percentUsed: number
  isOverLimit: boolean
  categories?: StorageCategoryBytes
  projects?: Array<{ projectId: string; projectName: string | null; hidden: boolean; bytes: number }>
  unmeasured?: string[]
  history?: StorageHistoryDay[]
  month?: StorageMonthEstimate
  lastCalculatedAt: Date | null
}

export interface GetStorageUsageOptions {
  /**
   * Owner/admin view: category breakdown, real per-project bytes, 30-day
   * history and the month-to-date estimate. Plain members get the totals only.
   */
  detail?: boolean
  historyDays?: number
  now?: Date
}

export async function getStorageUsage(
  workspaceId: string,
  options: GetStorageUsageOptions = {},
): Promise<StorageUsageDetail | null> {
  const { detail = false, historyDays = STORAGE_HISTORY_DAYS, now = new Date() } = options

  const workspace = (await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      instanceSize: true,
      storageUsage: true,
    },
  })) as { instanceSize: string | null; storageUsage: any } | null
  if (!workspace) return null

  const limitBytes = allowanceBytesFor(workspace.instanceSize)
  const totalBytes = workspace.storageUsage ? Number(workspace.storageUsage.totalBytes) : 0
  const billableBytes = workspace.storageUsage
    ? Number(workspace.storageUsage.billableBytes ?? workspace.storageUsage.totalBytes)
    : 0

  // `hidden: false` filters the *names* below, not the bytes: hidden
  // (companion builder-delegate) projects consume real S3 bytes and still count
  // against the workspace, but their names must not leak into a member's UI.
  const projects = (await prisma.project.findMany({
    where: { workspaceId },
    select: { id: true, name: true, hidden: true },
  })) as Array<{ id: string; name: string; hidden: boolean }>

  const result: StorageUsageDetail = {
    totalBytes,
    billableBytes,
    limitBytes,
    projectCount: projects.length,
    percentUsed: limitBytes > 0 ? Math.min((totalBytes / limitBytes) * 100, 100) : 0,
    isOverLimit: totalBytes > limitBytes,
    lastCalculatedAt: workspace.storageUsage?.lastCalculatedAt ?? null,
  }

  if (!detail) return result

  const breakdown = parseBreakdown(workspace.storageUsage?.breakdown)
  const bytesByProject = new Map<string, number>()
  for (const project of breakdown?.projects ?? []) bytesByProject.set(project.projectId, project.bytes)

  result.categories = breakdown?.categories ?? emptyCategoryBytes()
  result.unmeasured = breakdown?.unmeasured ?? []
  result.projects = projects
    .map((project) => ({
      projectId: project.id,
      projectName: project.hidden ? null : project.name,
      hidden: project.hidden,
      bytes: bytesByProject.get(project.id) ?? 0,
    }))
    .sort((a, b) => b.bytes - a.bytes)

  // A rolling window, not a month-to-date one: on the 3rd of the month this
  // still reaches back 30 days into the previous month. `Date.UTC` rolls a
  // negative day-of-month back through the earlier month for us.
  const since = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (historyDays - 1)),
  )
  const rows = (await prisma.storageUsageDaily.findMany({
    where: { workspaceId, day: { gte: since } },
    orderBy: { day: 'asc' },
    select: {
      day: true,
      totalBytes: true,
      billableBytes: true,
      allowanceBytes: true,
      chargedUsd: true,
      billedAt: true,
    },
  })) as Array<{
    day: Date
    totalBytes: bigint
    billableBytes: bigint
    allowanceBytes: bigint
    chargedUsd: number | null
    billedAt: Date | null
  }>

  result.history = rows.map((row) => ({
    day: new Date(row.day).toISOString().slice(0, 10),
    totalBytes: Number(row.totalBytes),
    billableBytes: Number(row.billableBytes),
    allowanceBytes: Number(row.allowanceBytes),
    chargedUsd: row.chargedUsd ?? null,
    billedAt: row.billedAt ?? null,
  }))

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  let gbMonths = 0
  for (const row of rows) {
    if (new Date(row.day) < monthStart) continue
    gbMonths += storageDayGbMonths(Number(row.billableBytes), Number(row.allowanceBytes), new Date(row.day))
  }
  result.month = {
    billableGbMonths: Math.round(gbMonths * 1e6) / 1e6,
    estimatedUsd: Math.round(gbMonths * STORAGE_USD_PER_GB_MONTH * 1e6) / 1e6,
    mode: storageBillingMode(),
  }

  return result
}

export async function isOverStorageLimit(workspaceId: string): Promise<boolean> {
  const workspace = (await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      instanceSize: true,
      storageUsage: { select: { totalBytes: true } },
    },
  })) as { instanceSize: string | null; storageUsage: { totalBytes: bigint } | null } | null

  if (!workspace?.storageUsage) return false

  const limit = allowanceBytesFor(workspace.instanceSize)
  return Number(workspace.storageUsage.totalBytes) > limit
}

// ============================================================================
// Fleet pass
// ============================================================================

/**
 * Recalculate storage for every workspace this region is home to. Called
 * periodically (every 6h) plus once on boot.
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
 * within `STORAGE_RECALC_MIN_GAP_MS`. No new table and no schema change are
 * needed for that, and because `storage_usage` is region-local each region
 * judges freshness on its own slice.
 */
export async function recalculateAllStorageUsage(now: Date = new Date()): Promise<StorageRecalcOutcome> {
  const lock = await withGlobalJobLock<StorageRecalcOutcome>(
    'storage-recalculate-all',
    async () => {
      // The advisory lock is per database, so it never stopped US and EU from
      // each sweeping every workspace (PERF-8). Each region recalculates only
      // the workspaces it is home for, and judges freshness on those alone:
      // a peer's pass over its own slice says nothing about ours.
      const home = homeRegionWorkspaceWhere()
      const { _max } = (await prisma.storageUsage.aggregate({
        ...(home ? { where: { workspace: home } } : {}),
        _max: { lastCalculatedAt: true },
      } as any)) as { _max: { lastCalculatedAt: Date | null } }
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

      // ONE measurement for the whole fleet: every shared namespace (artifacts,
      // publish buckets, conflict/, backups, workspace-root/, VM snapshots) is
      // listed once per pass instead of once per workspace.
      const measurements = await measureStorageForWorkspaces(null)

      console.log(`[Storage] Recalculating storage for ${measurements.size} workspaces`)

      for (const [workspaceId, measurement] of measurements) {
        try {
          await persistMeasurement(measurement, now)
        } catch (err: any) {
          console.error(`[Storage] Failed to recalculate for workspace ${workspaceId}:`, err.message)
        }
      }

      console.log(`[Storage] Recalculation complete`)

      return { status: 'ran' as const, workspaces: measurements.size }
    },
  )

  if (!lock.acquired) return { status: 'locked' }
  return lock.result
}

/**
 * Measure one workspace right now, on demand (super-admin "recalculate").
 *
 * Takes the same advisory lock as the fleet pass — so it can never interleave
 * with a pass that is mid-write on the same `storage_usage` row — but skips the
 * freshness gate, which is the whole point of a manual recalculation.
 */
export async function recalculateWorkspaceStorageNow(
  workspaceId: string,
): Promise<{ status: 'measured'; measurement: StorageMeasurement } | { status: 'locked' }> {
  const lock = await withGlobalJobLock<StorageMeasurement>('storage-recalculate-all', () =>
    calculateWorkspaceStorageUsage(workspaceId),
  )
  if (!lock.acquired) return { status: 'locked' }
  return { status: 'measured', measurement: lock.result }
}

// ============================================================================
// Super-admin views
// ============================================================================

export interface PlatformStorageSummary {
  lastPassAt: Date | null
  buckets: { measuredBytes: number; workspaces: number }
  categories: StorageCategoryBytes
  billableBytes: number
  overheadBytes: number
  unmeasured: string[]
  /** Month-to-date, from `StorageUsageDaily`. */
  month: { gbMonths: number; shadowUsd: number; chargedUsd: number; mode: 'shadow' | 'enforce' }
  topByBytes: Array<{ workspaceId: string; name: string; totalBytes: number; billableBytes: number; allowanceBytes: number }>
  topByOverage: Array<{ workspaceId: string; name: string; totalBytes: number; overageBytes: number; allowanceBytes: number }>
}

/**
 * Platform totals by category, biggest workspaces by bytes and by
 * over-allowance bytes, and month-to-date shadow/real revenue.
 *
 * `limit` bounds each top list. Everything is read from the current
 * `storage_usage` rows plus this month's `storage_usage_daily` rows — no S3
 * calls, so the admin page never triggers a sweep.
 */
export async function getPlatformStorageSummary(limit = 50, now: Date = new Date()): Promise<PlatformStorageSummary> {
  const home = homeRegionWorkspaceWhere()
  const workspaceWhere = { ...(home ?? {}) }

  const [rows, lastPass, monthRows] = await Promise.all([
    prisma.storageUsage.findMany({
      where: home ? { workspace: home } : {},
      select: {
        workspaceId: true,
        totalBytes: true,
        billableBytes: true,
        breakdown: true,
        lastCalculatedAt: true,
        workspace: { select: { name: true, instanceSize: true } },
      },
    }) as Promise<any[]>,
    prisma.storageUsage.aggregate({
      ...(home ? { where: { workspace: home } } : {}),
      _max: { lastCalculatedAt: true },
    } as any) as Promise<{ _max: { lastCalculatedAt: Date | null } }>,
    prisma.storageUsageDaily.findMany({
      where: { day: { gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) }, workspace: workspaceWhere },
      select: { billableBytes: true, allowanceBytes: true, chargedUsd: true, billedAt: true, day: true },
    }) as Promise<any[]>,
  ])

  const categories = emptyCategoryBytes()
  const unmeasured = new Set<string>()
  let billableBytes = 0

  const workspaceRows = rows.map((row) => {
    const breakdown = parseBreakdown(row.breakdown)
    if (breakdown) {
      for (const category of STORAGE_CATEGORIES) categories[category] += breakdown.categories[category] || 0
      for (const id of breakdown.unmeasured) unmeasured.add(id)
    } else {
      // Measured before `breakdown` existed: all we know is the total, and the
      // historical total was all billable (no overhead categories were counted).
      categories.project_files += Number(row.totalBytes)
    }
    const billable = Number(row.billableBytes ?? row.totalBytes)
    billableBytes += billable
    const allowance = allowanceBytesFor(row.workspace?.instanceSize)
    return {
      workspaceId: row.workspaceId,
      name: row.workspace?.name ?? row.workspaceId,
      totalBytes: Number(row.totalBytes),
      billableBytes: billable,
      allowanceBytes: allowance,
    }
  })

  const totalBytes = workspaceRows.reduce((sum, row) => sum + row.totalBytes, 0)

  let monthGbMonths = 0
  let shadowUsd = 0
  let chargedUsd = 0
  for (const row of monthRows) {
    monthGbMonths += storageDayGbMonths(Number(row.billableBytes), Number(row.allowanceBytes), new Date(row.day))
    const usd = Number(row.chargedUsd ?? 0)
    shadowUsd += usd
    if (row.billedAt && Number(row.chargedUsd ?? 0) > 0) chargedUsd += usd
  }

  const topByBytes = [...workspaceRows].sort((a, b) => b.totalBytes - a.totalBytes).slice(0, limit)
  const topByOverage = workspaceRows
    .map((row) => ({ ...row, overageBytes: Math.max(0, row.billableBytes - row.allowanceBytes) }))
    .filter((row) => row.overageBytes > 0)
    .sort((a, b) => b.overageBytes - a.overageBytes)
    .slice(0, limit)
    .map((row) => ({
      workspaceId: row.workspaceId,
      name: row.name,
      totalBytes: row.totalBytes,
      overageBytes: row.overageBytes,
      allowanceBytes: row.allowanceBytes,
    }))

  return {
    lastPassAt: lastPass._max.lastCalculatedAt ?? null,
    buckets: { measuredBytes: totalBytes, workspaces: workspaceRows.length },
    categories,
    billableBytes,
    overheadBytes: Math.max(0, totalBytes - billableBytes),
    unmeasured: Array.from(unmeasured).sort(),
    month: {
      gbMonths: Math.round(monthGbMonths * 1e6) / 1e6,
      shadowUsd: Math.round(shadowUsd * 1e6) / 1e6,
      chargedUsd: Math.round(chargedUsd * 1e6) / 1e6,
      mode: storageBillingMode(),
    },
    topByBytes,
    topByOverage,
  }
}

export interface WorkspaceStorageRow {
  workspaceId: string
  name: string
  slug: string
  instanceSize: string
  createdAt: Date
  counts: { members: number; projects: number; subscriptions: number }
  storage: { totalBytes: number; billableBytes: number; allowanceBytes: number; percentUsed: number }
}

/**
 * One page of workspaces with their storage numbers, for the super-admin
 * workspace directory. Sortable by `bytes` (default) or `name`, searchable by
 * name/slug, and filterable by instance size — the directory's own list can't
 * order by a related row's column, so this is the storage-aware sibling.
 */
export async function listWorkspaceStorage(
  options: {
    page?: number
    limit?: number
    search?: string
    instanceSize?: string
    sort?: 'bytes' | 'overage' | 'name' | 'created'
    order?: 'asc' | 'desc'
  } = {},
): Promise<{ workspaces: WorkspaceStorageRow[]; total: number; page: number; limit: number }> {
  const page = Math.max(1, options.page ?? 1)
  const limit = Math.min(Math.max(1, options.limit ?? 20), 100)
  const sort = options.sort ?? 'bytes'
  const order = options.order ?? 'desc'

  const where: Record<string, unknown> = {}
  if (options.search) {
    where.OR = [
      { name: { contains: options.search, mode: 'insensitive' as const } },
      { slug: { contains: options.search, mode: 'insensitive' as const } },
    ]
  }
  if (options.instanceSize) where.instanceSize = options.instanceSize

  const [rows, total] = await Promise.all([
    prisma.workspace.findMany({
      where,
      orderBy:
        sort === 'name' ? { name: order } : sort === 'created' ? { createdAt: order } : { createdAt: 'desc' },
      // Storage ordering is applied below: `orderBy` on a to-one relation with
      // nulls is dialect-sensitive (SQLite vs Postgres place NULLs differently),
      // and the fleet is small enough to sort the page's siblings in one pass.
      skip: sort === 'bytes' || sort === 'overage' ? 0 : (page - 1) * limit,
      take: sort === 'bytes' || sort === 'overage' ? undefined : limit,
      select: {
        id: true,
        name: true,
        slug: true,
        instanceSize: true,
        createdAt: true,
        storageUsage: { select: { totalBytes: true, billableBytes: true } },
        _count: { select: { members: true, projects: true, subscriptions: true } },
      },
    }) as Promise<any[]>,
    prisma.workspace.count({ where }),
  ])

  let mapped: WorkspaceStorageRow[] = rows.map((row: any) => {
    const totalBytes = Number(row.storageUsage?.totalBytes ?? 0)
    const billableBytes = Number(row.storageUsage?.billableBytes ?? row.storageUsage?.totalBytes ?? 0)
    const allowanceBytes = allowanceBytesFor(row.instanceSize)
    return {
      workspaceId: row.id,
      name: row.name,
      slug: row.slug,
      instanceSize: row.instanceSize,
      createdAt: row.createdAt,
      counts: {
        members: row._count?.members ?? 0,
        projects: row._count?.projects ?? 0,
        subscriptions: row._count?.subscriptions ?? 0,
      },
      storage: {
        totalBytes,
        billableBytes,
        allowanceBytes,
        percentUsed: allowanceBytes > 0 ? Math.min((totalBytes / allowanceBytes) * 100, 100) : 0,
      },
    }
  })

  if (sort === 'bytes' || sort === 'overage') {
    const value = (row: WorkspaceStorageRow) =>
      sort === 'bytes'
        ? row.storage.totalBytes
        : Math.max(0, row.storage.billableBytes - row.storage.allowanceBytes)
    mapped = mapped
      .sort((a, b) => (order === 'asc' ? value(a) - value(b) : value(b) - value(a)))
      .slice((page - 1) * limit, page * limit)
  }

  return { workspaces: mapped, total, page, limit }
}

/** GB helper re-exported so the UI/server layers agree on one conversion. */
export { bytesToGb }
