// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { prisma } from '../lib/prisma'
import { hasWorkspaceAccess } from './workspace.service'

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
        templateId: srcProject.templateId,
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

  try {
    copyWorkspaceFiles(listing.projectId, newProject.id)
  } catch (err) {
    await prisma.project.delete({ where: { id: newProject.id } }).catch(() => {})
    throw err
  }

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

export async function checkForUpdates(installId: string): Promise<{
  hasUpdate: boolean
  currentVersion: string
  installedVersion: string
  changelog?: string
}> {
  const install = await prisma.marketplaceInstall.findUnique({
    where: { id: installId },
    include: { listing: true },
  })
  if (!install) {
    throw new Error('install_not_found')
  }

  const currentVersion = install.listing.currentVersion
  const installedVersion = install.installedVersion

  if (install.installModel !== 'linked') {
    return { hasUpdate: false, currentVersion, installedVersion }
  }

  const hasUpdate = installedVersion !== currentVersion
  let changelog: string | undefined
  if (hasUpdate) {
    const ver = await prisma.marketplaceListingVersion.findFirst({
      where: { listingId: install.listingId, version: currentVersion },
      select: { changelog: true },
    })
    changelog = ver?.changelog ?? undefined
  }

  return { hasUpdate, currentVersion, installedVersion, changelog }
}

export async function applyUpdate(
  installId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const install = await prisma.marketplaceInstall.findUnique({
    where: { id: installId },
    include: { listing: true },
  })
  if (!install) return { ok: false, error: 'install_not_found' }
  if (install.installModel !== 'linked') return { ok: false, error: 'not_linked_install' }

  const targetVersion = install.listing.currentVersion
  if (install.installedVersion === targetVersion) {
    return { ok: true }
  }

  const versionRow = await prisma.marketplaceListingVersion.findFirst({
    where: { listingId: install.listingId, version: targetVersion },
  })
  if (!versionRow) return { ok: false, error: 'version_not_found' }

  try {
    if (versionRow.workspaceSnapshot != null) {
      applyWorkspaceSnapshot(install.projectId, versionRow.workspaceSnapshot)
    }
    await prisma.marketplaceInstall.update({
      where: { id: installId },
      data: { installedVersion: targetVersion },
    })
    return { ok: true }
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
