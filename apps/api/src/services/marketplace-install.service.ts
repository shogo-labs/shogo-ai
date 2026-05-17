// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { prisma } from '../lib/prisma'
import { hasWorkspaceAccess } from './workspace.service'
import {
  computeWorkspaceManifest,
  diffManifests,
  type ManifestDiff,
} from './marketplace-manifest.service'
import {
  extractSnapshotToProject,
} from './marketplace-snapshot-storage.service'

const PROJECT_ROOT = resolve(import.meta.dir, '../../../..')

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.cache',
  '.next',
  'build',
  '.turbo',
  '.expo',
])

export function getWorkspacesDir(): string {
  return process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
}

export function copyWorkspaceFiles(sourceProjectId: string, destProjectId: string): void {
  const root = getWorkspacesDir()
  const sourceDir = join(root, sourceProjectId)
  const destDir = join(root, destProjectId)
  mkdirSync(destDir, { recursive: true })
  if (!existsSync(sourceDir)) {
    return
  }
  cpSync(sourceDir, destDir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(sourceDir, src)
      if (!rel || rel === '.') return true
      for (const segment of rel.split(/[/\\]/)) {
        if (segment === '' || segment === '.') continue
        if (EXCLUDED_DIRS.has(segment)) return false
        if (segment.startsWith('.install-')) return false
      }
      return true
    },
  })
}

function defaultProjectSettings(): object {
  return {
    activeMode: 'none',
    canvasMode: 'code',
    canvasEnabled: false,
  }
}

function normalizeSettings(raw: unknown): object {
  if (raw == null) return defaultProjectSettings()
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as object
    } catch {
      return defaultProjectSettings()
    }
  }
  if (typeof raw === 'object') return raw as object
  return defaultProjectSettings()
}

function applyWorkspaceSnapshot(projectId: string, snapshot: unknown): void {
  if (snapshot == null) return
  if (typeof snapshot !== 'object' || Array.isArray(snapshot)) return

  const root = snapshot as Record<string, unknown>
  const fileMap =
    root.files != null && typeof root.files === 'object' && !Array.isArray(root.files)
      ? (root.files as Record<string, unknown>)
      : root

  const projectDir = join(getWorkspacesDir(), projectId)

  for (const [relPath, val] of Object.entries(fileMap)) {
    if (relPath === 'files') continue
    if (!relPath || relPath.includes('..') || relPath.startsWith('/')) continue

    let body: Buffer
    if (typeof val === 'string') {
      body = Buffer.from(val, 'utf8')
    } else if (val && typeof val === 'object' && typeof (val as { data?: unknown }).data === 'string') {
      const enc = (val as { encoding?: string }).encoding === 'base64' ? 'base64' : 'utf8'
      body = Buffer.from((val as { data: string }).data, enc)
    } else {
      continue
    }

    const destPath = join(projectDir, relPath)
    const parent = resolve(destPath, '..')
    mkdirSync(parent, { recursive: true })
    writeFileSync(destPath, body)
  }
}

export async function installAgent(params: {
  listingId: string
  userId: string
  workspaceId: string
}): Promise<{ projectId: string; installId: string }> {
  const { listingId, userId, workspaceId } = params

  const canInstall = await hasWorkspaceAccess(workspaceId, userId)
  if (!canInstall) {
    throw new Error('workspace_access_denied')
  }

  const listing = await prisma.marketplaceListing.findUnique({
    where: { id: listingId },
    include: {
      project: {
        include: { agentConfig: true },
      },
    },
  })

  if (!listing || !listing.project) {
    throw new Error('listing_not_found')
  }
  if (listing.status !== 'published') {
    throw new Error('listing_not_published')
  }

  const srcProject = listing.project
  const settingsJson = normalizeSettings(srcProject.settings)

  const newProject = await prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        name: listing.title,
        description: listing.shortDescription,
        workspaceId,
        createdBy: userId,
        tier: srcProject.tier,
        status: srcProject.status,
        schemas: srcProject.schemas ?? [],
        accessLevel: srcProject.accessLevel,
        category: srcProject.category,
        siteTitle: srcProject.siteTitle,
        siteDescription: srcProject.siteDescription,
        settings: settingsJson as object,
      },
    })

    const ac = srcProject.agentConfig
    await tx.agentConfig.create({
      data: {
        projectId: project.id,
        heartbeatInterval: ac?.heartbeatInterval ?? 1800,
        heartbeatEnabled: ac?.heartbeatEnabled ?? false,
        modelProvider: ac?.modelProvider ?? 'anthropic',
        modelName: ac?.modelName ?? 'claude-haiku-4-5',
        channels: (ac?.channels as object) ?? [],
        quietHoursStart: ac?.quietHoursStart ?? null,
        quietHoursEnd: ac?.quietHoursEnd ?? null,
        quietHoursTimezone: ac?.quietHoursTimezone ?? null,
      },
    })

    return project
  })

  // Materialize the install's workspace.
  //
  // S3 path (preferred): every published listing has a current
  // version row with a `workspaceSnapshotKey` pointing at the tarball
  // in S3. We extract that into the new project's workspace dir.
  // This decouples installs from the source-project-on-disk
  // dependency — creators can iterate on their source workspace
  // without affecting in-flight installs.
  //
  // Legacy path: rows that pre-date the S3 columns (or that were
  // created during a brief S3 outage) keep working via either
  // `applyWorkspaceSnapshot(json)` or a direct `copyWorkspaceFiles`
  // from the source project. The order is intentional — JSON
  // snapshots are the canonical legacy fallback; on-disk copy is the
  // ancient pre-versioning path that only matters until the boot
  // backfill runs everywhere.
  try {
    const versionRow = await prisma.marketplaceListingVersion.findFirst({
      where: { listingId: listing.id, version: listing.currentVersion },
      select: {
        workspaceSnapshot: true,
        workspaceSnapshotKey: true,
        workspaceSnapshotChecksum: true,
      },
    })
    if (versionRow?.workspaceSnapshotKey) {
      await extractSnapshotToProject(versionRow.workspaceSnapshotKey, newProject.id, {
        expectedChecksum: versionRow.workspaceSnapshotChecksum,
      })
    } else if (versionRow?.workspaceSnapshot != null) {
      mkdirSync(join(getWorkspacesDir(), newProject.id), { recursive: true })
      applyWorkspaceSnapshot(newProject.id, versionRow.workspaceSnapshot)
    } else {
      copyWorkspaceFiles(listing.projectId, newProject.id)
    }
  } catch (err) {
    await prisma.project.delete({ where: { id: newProject.id } }).catch(() => {})
    throw err
  }

  // Capture the on-disk manifest right after extraction. This is the
  // baseline applyUpdate diffs against to detect user drift before
  // overwriting files. Done outside the install-create transaction so
  // a failure here doesn't roll back the project / agentConfig that
  // already exist on disk.
  const baselineManifest = computeWorkspaceManifest(newProject.id)

  const install = await prisma.$transaction(async (tx) => {
    const row = await tx.marketplaceInstall.create({
      data: {
        listingId: listing.id,
        projectId: newProject.id,
        workspaceId,
        userId,
        installModel: listing.installModel,
        installedVersion: listing.currentVersion,
        status: 'active',
        baselineManifest: baselineManifest as object,
      },
    })
    await tx.marketplaceListing.update({
      where: { id: listing.id },
      data: { installCount: { increment: 1 } },
    })
    return row
  })

  return { projectId: newProject.id, installId: install.id }
}

export interface CheckForUpdatesResult {
  hasUpdate: boolean
  currentVersion: string
  installedVersion: string
  /** Populated when an update is available. */
  changelog?: string
  /** Drift detected vs the install's `baselineManifest`, if any. */
  drift?: ManifestDiff
}

/**
 * Report whether a newer version of the install's listing is available
 * (and how many local files have diverged from the baseline). After
 * the templates → marketplace consolidation this also covers
 * `installModel: 'fork'` — the previous `'linked'`-only early return
 * was removed because `fork` is now the dominant install path. The
 * caller can decide whether to surface "Update available" + a
 * "force" toggle based on `drift`.
 */
export async function checkForUpdates(installId: string): Promise<CheckForUpdatesResult> {
  const install = await prisma.marketplaceInstall.findUnique({
    where: { id: installId },
    include: { listing: true },
  })
  if (!install) {
    throw new Error('install_not_found')
  }

  const currentVersion = install.listing.currentVersion
  const installedVersion = install.installedVersion
  const hasUpdate = installedVersion !== currentVersion

  let changelog: string | undefined
  if (hasUpdate) {
    const ver = await prisma.marketplaceListingVersion.findFirst({
      where: { listingId: install.listingId, version: currentVersion },
      select: { changelog: true },
    })
    changelog = ver?.changelog ?? undefined
  }

  // Drift = on-disk content vs the baseline we captured at last
  // install/apply-update. We compute it even when no update is
  // available so the caller can decide whether to render a "you've
  // modified this agent" indicator separately from the update prompt.
  const baseline = (install.baselineManifest ?? null) as Record<string, string> | null
  let drift: ManifestDiff | undefined
  if (baseline) {
    const current = computeWorkspaceManifest(install.projectId)
    drift = diffManifests(baseline, current)
  }

  return { hasUpdate, currentVersion, installedVersion, changelog, drift }
}

export type ApplyUpdateResult =
  | { ok: true; alreadyOnLatest?: boolean; installedVersion: string }
  | {
      ok: false
      error:
        | 'install_not_found'
        | 'version_not_found'
        | 'drift_detected'
        | 'apply_failed'
      diverged?: ManifestDiff
    }

export interface ApplyUpdateOptions {
  /**
   * When true, overwrite diverged files with the new version's
   * snapshot bytes. The on-disk file listing is left intact otherwise
   * (no files are deleted by the force path — locally-added files
   * outside the snapshot survive).
   */
  force?: boolean
}

/**
 * Apply the listing's current version to an install. Drift detection
 * (Phase 6) — when the on-disk workspace differs from the install's
 * `baselineManifest` and `force` is not set, we return
 * `drift_detected` with the diverged file list so the caller can
 * confirm with the user before clobbering their changes.
 */
export async function applyUpdate(
  installId: string,
  opts: ApplyUpdateOptions = {},
): Promise<ApplyUpdateResult> {
  const { force = false } = opts

  const install = await prisma.marketplaceInstall.findUnique({
    where: { id: installId },
    include: { listing: true },
  })
  if (!install) return { ok: false, error: 'install_not_found' }

  const targetVersion = install.listing.currentVersion
  if (install.installedVersion === targetVersion) {
    return { ok: true, alreadyOnLatest: true, installedVersion: targetVersion }
  }

  // Drift gate — only meaningful when we have a baseline to compare
  // against. Installs that pre-date the manifest field skip the gate
  // (we have no signal to act on); the next apply will write a fresh
  // baseline so subsequent updates honor the gate.
  const baseline = (install.baselineManifest ?? null) as Record<string, string> | null
  if (baseline && !force) {
    const current = computeWorkspaceManifest(install.projectId)
    const diff = diffManifests(baseline, current)
    if (diff.modified.length + diff.added.length + diff.deleted.length > 0) {
      return { ok: false, error: 'drift_detected', diverged: diff }
    }
  }

  const versionRow = await prisma.marketplaceListingVersion.findFirst({
    where: { listingId: install.listingId, version: targetVersion },
  })
  if (!versionRow) return { ok: false, error: 'version_not_found' }

  try {
    // Same key-then-json fallback as installAgent — see that comment
    // for the full rationale. The shape of `versionRow` is wider than
    // we strictly need here (the type comes from the implicit Prisma
    // return), so we read each field defensively.
    const v = versionRow as unknown as {
      workspaceSnapshot?: unknown
      workspaceSnapshotKey?: string | null
      workspaceSnapshotChecksum?: string | null
    }
    if (v.workspaceSnapshotKey) {
      mkdirSync(join(getWorkspacesDir(), install.projectId), { recursive: true })
      await extractSnapshotToProject(v.workspaceSnapshotKey, install.projectId, {
        expectedChecksum: v.workspaceSnapshotChecksum ?? null,
      })
    } else if (v.workspaceSnapshot != null) {
      applyWorkspaceSnapshot(install.projectId, v.workspaceSnapshot)
    }
    // Refresh the baseline from the new on-disk state so the next
    // applyUpdate compares against the version we just shipped, not
    // the pre-update state. Done before the DB update so we never
    // record `installedVersion` advancing without a fresh baseline.
    const refreshed = computeWorkspaceManifest(install.projectId)
    await prisma.marketplaceInstall.update({
      where: { id: installId },
      data: {
        installedVersion: targetVersion,
        baselineManifest: refreshed as object,
      },
    })
    return { ok: true, installedVersion: targetVersion }
  } catch {
    return { ok: false, error: 'apply_failed' }
  }
}

export async function getInstallsForUser(userId: string) {
  return prisma.marketplaceInstall.findMany({
    where: { userId },
    include: {
      listing: {
        select: {
          id: true,
          slug: true,
          title: true,
          shortDescription: true,
          longDescription: true,
          category: true,
          tags: true,
          iconUrl: true,
          pricingModel: true,
          installModel: true,
          currentVersion: true,
          status: true,
          publishedAt: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })
}

export async function getInstallsForListing(listingId: string, page: number, limit: number) {
  const safeLimit = Math.min(Math.max(1, limit), 100)
  const safePage = Math.max(1, page)
  const skip = (safePage - 1) * safeLimit

  const [installs, total] = await Promise.all([
    prisma.marketplaceInstall.findMany({
      where: { listingId },
      skip,
      take: safeLimit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.marketplaceInstall.count({ where: { listingId } }),
  ])

  return { installs, total, page: safePage, limit: safeLimit }
}
