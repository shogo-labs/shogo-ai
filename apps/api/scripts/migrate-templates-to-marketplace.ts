// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * migrate-templates-to-marketplace.ts
 *
 * One-shot data migration from the legacy filesystem-template subsystem
 * (`packages/agent-runtime/templates/<id>/`) to the marketplace listings
 * model. After this script runs:
 *
 *   - There is one official `User` (shogo-official@shogo.ai) + a paired
 *     `CreatorProfile` ("Shogo") + a `Workspace` ("shogo-official") that
 *     hosts every official template's source project. These are upserted
 *     by stable email/slug so re-runs are no-ops.
 *
 *   - For every `templates/<id>/` directory, there is:
 *       1. A source `Project` keyed by id `template-<id>` whose
 *          `workspaces/template-<id>/` directory contains the merged
 *          runtime-template + template overlay (src/, prisma/, dist/,
 *          .shogo/, canvas/, .canvas-state.json, …) — i.e. the exact
 *          on-disk shape `seedWorkspaceFromTemplate` produced before
 *          this consolidation.
 *       2. A `MarketplaceListing` keyed by `slug = id` (free, fork
 *          install, status = published, owned by the Shogo creator).
 *       3. A `MarketplaceListingVersion` row at `version = '1.0.0'`
 *          carrying a `workspaceSnapshot` derived from the source
 *          workspace via `snapshotProjectWorkspace`. The snapshot is the
 *          source of truth for fork installs that need to apply later
 *          updates without drift.
 *
 *   - Every existing `Project` row with `templateId = X` has a backfilled
 *     `MarketplaceInstall` row pointing at the listing for `X`, with
 *     `installedVersion = '1.0.0'` and a `baselineManifest` snapshotted
 *     from the project's current on-disk workspace. Skipped projects:
 *     listing missing (e.g. seed-marketplace synthetic markers like
 *     `seed-marketplace:foo`), install row already present, project
 *     missing `createdBy`.
 *
 * Idempotency: every write is upsert-shaped, so re-running is safe and
 * a no-op past the first run. The script is invoked at API boot
 * (`server.ts`) and as a standalone bun script for desktop installs that
 * run their own DB. Both paths share the same `runMigration` entrypoint.
 *
 * Usage:
 *   bun apps/api/scripts/migrate-templates-to-marketplace.ts
 *   bun apps/api/scripts/migrate-templates-to-marketplace.ts --dry-run
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { prisma } from '../src/lib/prisma'
import {
  computeWorkspaceManifest,
  snapshotProjectWorkspace,
} from '../src/services/marketplace-manifest.service'

// ─── Constants ────────────────────────────────────────────────────────────

const OFFICIAL_USER_EMAIL = 'shogo-official@shogo.ai'
const OFFICIAL_WORKSPACE_SLUG = 'shogo-official'
const OFFICIAL_DISPLAY_NAME = 'Shogo'
const SEED_VERSION = '1.0.0'

/**
 * Listings featured in the "Built for Shogo" rail on first boot.
 * Mirrors the `POPULAR_IDS` set in
 * `apps/mobile/components/templates/agent-template-card.tsx` so the
 * editorial signal that existed in the old templates UI carries over to
 * marketplace browse.
 */
const FEATURED_TEMPLATE_IDS = new Set([
  'marketing-command-center',
  'devops-hub',
  'personal-assistant',
  'sales-revenue',
])

interface TemplateMeta {
  id: string
  name: string
  description: string
  category?: string
  icon?: string
  tags?: string[]
  settings?: {
    heartbeatInterval?: number
    heartbeatEnabled?: boolean
    modelProvider?: string
    modelName?: string
    quietHours?: { start: string; end: string; timezone: string }
    [key: string]: unknown
  }
  techStack?: string
  integrations?: unknown
}

// ─── Path helpers ─────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dir, '..', '..', '..')

function getTemplatesBaseDir(): string {
  return process.env.TEMPLATES_DIR
    ?? resolve(PROJECT_ROOT, 'packages', 'agent-runtime', 'templates')
}

function getRuntimeTemplateDir(): string | null {
  const candidates = [
    process.env.RUNTIME_TEMPLATE_DIR,
    resolve(PROJECT_ROOT, 'templates', 'runtime-template'),
    resolve(PROJECT_ROOT, 'packages', 'agent-runtime', 'templates', 'runtime-template'),
  ].filter((c): c is string => !!c)
  for (const c of candidates) {
    if (existsSync(join(c, 'package.json'))) return c
  }
  return null
}

function getWorkspacesRoot(): string {
  return process.env.WORKSPACES_DIR ?? resolve(PROJECT_ROOT, 'workspaces')
}

function listTemplateDirs(base: string): string[] {
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(base, d.name, 'template.json')))
    .map(d => d.name)
    .sort()
}

function loadTemplateMeta(templateDir: string): TemplateMeta {
  const raw = JSON.parse(readFileSync(join(templateDir, 'template.json'), 'utf-8'))
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    category: raw.category,
    icon: raw.icon,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    settings: raw.settings ?? {},
    techStack: raw.techStack,
    integrations: raw.integrations,
  }
}

/**
 * Load the project-level UI settings from the template's
 * `.shogo/config.json`. These fields drive the studio canvas:
 *
 *   - `activeMode`  — selects which top tab the studio opens to
 *                    ('canvas' / 'app' / 'none'). Defaults to 'canvas'.
 *   - `canvasMode`  — selects the renderer inside the canvas tab.
 *                    'code' loads the runtime's `dist/index.html` in an
 *                    iframe (used by every first-party template that
 *                    ships a pre-built bundle); 'json' renders the
 *                    surfaces UI from the agent's JSON state.
 *
 * If we omit `canvasMode` from the source project's `Project.settings`,
 * the studio falls back to 'json', which renders the empty surfaces
 * placeholder ("Connected" with no preview). This was the staging
 * incident where every newly installed marketplace template appeared
 * blank — the workspace had `dist/index.html` and the runtime was
 * serving it, but the studio never asked for it.
 */
function loadShogoProjectSettings(
  templateDir: string,
): { activeMode?: string; canvasMode?: string } {
  const path = join(templateDir, '.shogo', 'config.json')
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    const out: { activeMode?: string; canvasMode?: string } = {}
    if (typeof raw.activeMode === 'string') out.activeMode = raw.activeMode
    if (typeof raw.canvasMode === 'string') out.canvasMode = raw.canvasMode
    return out
  } catch {
    return {}
  }
}

// ─── Workspace materialization ────────────────────────────────────────────

const COPY_FILTER_SKIP = new Set(['node_modules', '.git', '.shogo', 'src/generated'])

/**
 * Materialize a source workspace at `workspaces/template-<id>/` by
 * applying the same overlays that `seedWorkspaceFromTemplate` +
 * `seedRuntimeTemplate` + `overlayAgentTemplateCodeDirs` would produce
 * for a fresh install. Steps mirror those functions exactly so that the
 * snapshot we write later is byte-equivalent to what users have in
 * their existing template-seeded workspaces.
 */
function materializeSourceWorkspace(
  templateId: string,
  templateDir: string,
  destDir: string,
): { didCreate: boolean } {
  const alreadyMaterialized = existsSync(join(destDir, 'package.json'))
  if (alreadyMaterialized) {
    return { didCreate: false }
  }

  mkdirSync(destDir, { recursive: true })

  // 1. Runtime template (Vite/React/Tailwind starter).
  const runtimeDir = getRuntimeTemplateDir()
  if (runtimeDir) {
    cpSync(runtimeDir, destDir, {
      recursive: true,
      filter: (src) => {
        const rel = src.slice(runtimeDir.length + 1)
        if (!rel) return true
        const top = rel.split(/[/\\]/)[0]
        return !COPY_FILTER_SKIP.has(top) && !COPY_FILTER_SKIP.has(rel)
          && !rel.endsWith('bun.lock') && !rel.endsWith('bun.lockb')
      },
    })
  }

  // 2. Template overlays: src/, prisma/, dist/, canvas/, .canvas-state.json.
  const srcOverlay = join(templateDir, 'src')
  if (existsSync(srcOverlay)) {
    cpSync(srcOverlay, join(destDir, 'src'), { recursive: true, force: true })
  }
  const prismaOverlay = join(templateDir, 'prisma')
  if (existsSync(prismaOverlay)) {
    cpSync(prismaOverlay, join(destDir, 'prisma'), { recursive: true, force: true })
  }
  const distOverlay = join(templateDir, 'dist')
  if (existsSync(distOverlay) && existsSync(join(distOverlay, 'index.html'))) {
    const destDist = join(destDir, 'dist')
    rmSync(destDist, { recursive: true, force: true })
    cpSync(distOverlay, destDist, { recursive: true })
  }
  const canvasOverlay = join(templateDir, 'canvas')
  if (existsSync(canvasOverlay)) {
    cpSync(canvasOverlay, join(destDir, 'canvas'), { recursive: true })
  }
  const canvasState = join(templateDir, '.canvas-state.json')
  if (existsSync(canvasState)) {
    cpSync(canvasState, join(destDir, '.canvas-state.json'))
  }

  // 3. .shogo overlay (AGENTS.md / HEARTBEAT.md / config.json / skills/).
  const shogoOverlay = join(templateDir, '.shogo')
  if (existsSync(shogoOverlay)) {
    cpSync(shogoOverlay, join(destDir, '.shogo'), { recursive: true })
  }

  // 4. Marker files used by the runtime to know which template this is
  //    and which tech stack to seed. Match the runtime's existing markers
  //    so future installAgent → copyWorkspaceFiles installs inherit them.
  writeFileSync(join(destDir, '.template'), templateId, 'utf-8')

  return { didCreate: true }
}

// ─── Idempotent upserts ──────────────────────────────────────────────────

interface OfficialIds {
  userId: string
  workspaceId: string
  creatorProfileId: string
}

async function ensureOfficialEntities(): Promise<OfficialIds> {
  const user = await prisma.user.upsert({
    where: { email: OFFICIAL_USER_EMAIL },
    update: { name: OFFICIAL_DISPLAY_NAME },
    create: {
      email: OFFICIAL_USER_EMAIL,
      name: OFFICIAL_DISPLAY_NAME,
      emailVerified: true,
    },
  })

  const existingWorkspace = await prisma.workspace.findUnique({
    where: { slug: OFFICIAL_WORKSPACE_SLUG },
  })
  const workspace = existingWorkspace
    ? existingWorkspace
    : await prisma.workspace.create({
      data: {
        slug: OFFICIAL_WORKSPACE_SLUG,
        name: 'Shogo Official Templates',
        description: 'Source projects for first-party agent listings.',
      },
    })
  const existingMember = await prisma.member
    .findFirst({ where: { userId: user.id, workspaceId: workspace.id } })
    .catch(() => null)
  if (!existingMember) {
    await prisma.member
      .create({ data: { userId: user.id, workspaceId: workspace.id, role: 'owner' } })
      .catch(() => undefined)
  }

  const existingProfile = await prisma.creatorProfile.findUnique({
    where: { userId: user.id },
  })
  const profile = existingProfile
    ? existingProfile
    : await prisma.creatorProfile.create({
      data: {
        userId: user.id,
        displayName: OFFICIAL_DISPLAY_NAME,
        bio: 'First-party agents built and maintained by the Shogo team.',
        verified: true,
        creatorTier: 'master',
        reputationScore: 10_000,
        payoutStatus: 'verified',
      },
    })

  return {
    userId: user.id,
    workspaceId: workspace.id,
    creatorProfileId: profile.id,
  }
}

interface TemplateUpsertResult {
  templateId: string
  listingId: string
  projectId: string
  versionId: string
  workspaceCreated: boolean
}

async function upsertTemplateListing(
  templateId: string,
  templateDir: string,
  meta: TemplateMeta,
  ids: OfficialIds,
  dryRun: boolean,
): Promise<TemplateUpsertResult> {
  const projectId = `template-${templateId}`
  const listingSlug = templateId
  const workspaceDir = join(getWorkspacesRoot(), projectId)

  // The studio reads `activeMode` + `canvasMode` from the project's
  // settings to decide whether to render the canvas iframe (`code`)
  // or the surfaces placeholder (`json`). The first-party templates
  // declare these in `.shogo/config.json`; we lift them into the DB
  // here so installs inherit them automatically (the install service
  // copies `srcProject.settings` verbatim onto the fork).
  const shogoSettings = loadShogoProjectSettings(templateDir)
  const desiredSettings = {
    techStackId: meta.techStack ?? 'react-app',
    ...shogoSettings,
  } as object

  // 1. Source project + agent config. Stable id keeps re-runs idempotent.
  const existingProject = await prisma.project.findUnique({ where: { id: projectId } })
  if (!existingProject && !dryRun) {
    await prisma.project.create({
      data: {
        id: projectId,
        name: meta.name,
        description: meta.description,
        workspaceId: ids.workspaceId,
        createdBy: ids.userId,
        status: 'active',
        settings: desiredSettings,
      },
    })
    await prisma.agentConfig.create({
      data: {
        projectId,
        heartbeatInterval: meta.settings?.heartbeatInterval ?? 1800,
        heartbeatEnabled: meta.settings?.heartbeatEnabled ?? false,
        modelProvider: meta.settings?.modelProvider ?? 'anthropic',
        modelName: meta.settings?.modelName ?? 'claude-haiku-4-5',
        channels: [] as object,
        quietHoursStart: meta.settings?.quietHours?.start ?? null,
        quietHoursEnd: meta.settings?.quietHours?.end ?? null,
        quietHoursTimezone: meta.settings?.quietHours?.timezone ?? null,
      },
    })
  } else if (existingProject && !dryRun) {
    // Re-run path: existing source project from a prior migration that
    // ran before we lifted `.shogo/config.json` into the DB. Merge the
    // desired keys into whatever's already there, preserving any other
    // settings a future migration adds. Without this, every existing
    // staging/prod source project would be permanently stuck without
    // `canvasMode`, and every fresh install of those templates would
    // render the empty surfaces placeholder ("Connected" with no
    // preview).
    const merged = {
      ...((existingProject.settings as Record<string, unknown> | null) ?? {}),
      ...desiredSettings,
    }
    await prisma.project.update({
      where: { id: projectId },
      data: { settings: merged as object },
    })
  }

  // 2. Materialize the workspace (idempotent — bails if already done).
  let workspaceCreated = false
  if (!dryRun) {
    const result = materializeSourceWorkspace(templateId, templateDir, workspaceDir)
    workspaceCreated = result.didCreate
  }

  // 3. Capture a snapshot for version 1.0.0. Done after materialization so
  //    the snapshot reflects every overlay we just applied.
  const snapshot = dryRun ? {} : snapshotProjectWorkspace(projectId)

  // 4. Listing + first version. Use Prisma's `where: { slug }` for upsert
  //    so the same listing always gets the latest copy of the meta.
  const featured = FEATURED_TEMPLATE_IDS.has(templateId)
  const listingData = {
    title: meta.name,
    shortDescription: meta.description.slice(0, 280),
    longDescription: meta.description,
    category: meta.category ?? null,
    tags: meta.tags ?? [],
    pricingModel: 'free' as const,
    installModel: 'fork' as const,
    status: 'published' as const,
    publishedAt: new Date(),
    featuredAt: featured ? new Date() : null,
    currentVersion: SEED_VERSION,
  }

  let listing = await prisma.marketplaceListing.findUnique({ where: { slug: listingSlug } })
  if (!listing && !dryRun) {
    listing = await prisma.marketplaceListing.create({
      data: {
        slug: listingSlug,
        projectId,
        creatorId: ids.creatorProfileId,
        ...listingData,
      },
    })
  } else if (listing && !dryRun) {
    listing = await prisma.marketplaceListing.update({
      where: { slug: listingSlug },
      data: { ...listingData, projectId },
    })
  }

  // 5. Version row (snapshot lives here, not on the listing).
  let version = listing
    ? await prisma.marketplaceListingVersion.findFirst({
      where: { listingId: listing.id, version: SEED_VERSION },
    })
    : null
  if (!version && listing && !dryRun) {
    version = await prisma.marketplaceListingVersion.create({
      data: {
        listingId: listing.id,
        version: SEED_VERSION,
        changelog: 'Initial release.',
        workspaceSnapshot: snapshot as object,
        auditStatus: 'passed',
        auditedBy: 'migration-script',
        auditedAt: new Date(),
        auditModel: 'none',
      },
    })
  } else if (version && !dryRun && (!version.workspaceSnapshot || workspaceCreated)) {
    // Re-run path: refresh the snapshot if we just materialized the
    // workspace, so a desktop install that runs after the cloud schema
    // bump catches up to the latest template content.
    version = await prisma.marketplaceListingVersion.update({
      where: { id: version.id },
      data: { workspaceSnapshot: snapshot as object },
    })
  }

  return {
    templateId,
    listingId: listing?.id ?? '',
    projectId,
    versionId: version?.id ?? '',
    workspaceCreated,
  }
}

interface BackfillStats {
  inspected: number
  created: number
  skippedNoListing: number
  skippedAlreadyInstalled: number
  skippedNoOwner: number
  skippedSeedMarker: number
}

/**
 * For every `Project` whose `templateId` matches a real listing slug,
 * create a `MarketplaceInstall` row capturing the current on-disk
 * baseline. Existing installs are left alone so updates never silently
 * regress the baseline manifest.
 */
async function backfillInstalls(
  templateIdToListing: Map<string, string>,
  dryRun: boolean,
): Promise<BackfillStats> {
  const stats: BackfillStats = {
    inspected: 0,
    created: 0,
    skippedNoListing: 0,
    skippedAlreadyInstalled: 0,
    skippedNoOwner: 0,
    skippedSeedMarker: 0,
  }

  // Pull projects with non-null templateId. SELECTed columns kept narrow
  // for memory; large tenants can have tens of thousands of projects.
  const projects = await prisma.project.findMany({
    where: { templateId: { not: null } } as any,
    select: {
      id: true,
      workspaceId: true,
      createdBy: true,
      templateId: true,
    } as any,
  }) as Array<{
    id: string
    workspaceId: string
    createdBy: string | null
    templateId: string | null
  }>

  for (const project of projects) {
    stats.inspected++
    const tid = project.templateId
    if (!tid) continue

    // The seed-marketplace script abuses `templateId` as a stable lookup
    // marker (see scripts/seed-marketplace.ts). Skip those — they don't
    // map to a real listing.
    if (tid.startsWith('seed-marketplace:')) {
      stats.skippedSeedMarker++
      continue
    }

    const listingId = templateIdToListing.get(tid)
    if (!listingId) {
      stats.skippedNoListing++
      continue
    }

    if (!project.createdBy) {
      stats.skippedNoOwner++
      continue
    }

    const existing = await prisma.marketplaceInstall.findFirst({
      where: { listingId, projectId: project.id },
    })
    if (existing) {
      stats.skippedAlreadyInstalled++
      continue
    }

    const baselineManifest = computeWorkspaceManifest(project.id)

    if (!dryRun) {
      await prisma.marketplaceInstall.create({
        data: {
          listingId,
          projectId: project.id,
          workspaceId: project.workspaceId,
          userId: project.createdBy,
          installModel: 'fork',
          installedVersion: SEED_VERSION,
          status: 'active',
          baselineManifest: baselineManifest as object,
        },
      })
    }
    stats.created++
  }

  return stats
}

// ─── Entrypoints ─────────────────────────────────────────────────────────

export interface RunMigrationOptions {
  /** Skip every DB write — log what would happen. */
  dryRun?: boolean
  /** Override `templates/` base dir (used by tests). */
  templatesDir?: string
  /** Suppress progress logs. */
  quiet?: boolean
}

export interface RunMigrationResult {
  templates: TemplateUpsertResult[]
  backfill: BackfillStats
  ranAt: Date
}

export async function runMigration(opts: RunMigrationOptions = {}): Promise<RunMigrationResult> {
  const { dryRun = false, quiet = false } = opts
  const templatesBase = opts.templatesDir ?? getTemplatesBaseDir()
  const log = (msg: string) => {
    if (!quiet) console.log(`[migrate-templates] ${msg}`)
  }

  const tplDirs = listTemplateDirs(templatesBase)
  if (tplDirs.length === 0) {
    log(`no templates found under ${templatesBase} — nothing to do`)
    return { templates: [], backfill: emptyBackfill(), ranAt: new Date() }
  }

  log(`found ${tplDirs.length} template(s); ${dryRun ? 'dry-run mode' : 'applying writes'}`)

  const ids = dryRun
    ? { userId: '<dry>', workspaceId: '<dry>', creatorProfileId: '<dry>' }
    : await ensureOfficialEntities()
  if (!dryRun) {
    log(`official creator userId=${ids.userId} workspaceId=${ids.workspaceId}`)
  }

  const results: TemplateUpsertResult[] = []
  const templateIdToListing = new Map<string, string>()
  for (const dir of tplDirs) {
    const templateDir = join(templatesBase, dir)
    let meta: TemplateMeta
    try {
      meta = loadTemplateMeta(templateDir)
    } catch (err) {
      log(`skipping ${dir}: failed to parse template.json (${(err as Error).message})`)
      continue
    }
    if (!meta.id || !meta.name || !meta.description) {
      log(`skipping ${dir}: template.json missing id/name/description`)
      continue
    }

    const result = await upsertTemplateListing(meta.id, templateDir, meta, ids, dryRun)
    results.push(result)
    if (result.listingId) templateIdToListing.set(meta.id, result.listingId)
    log(`upserted ${meta.id} (workspaceCreated=${result.workspaceCreated})`)
  }

  log(`backfilling marketplace_installs from existing Project.templateId values...`)
  const backfill = await backfillInstalls(templateIdToListing, dryRun)
  log(
    `backfill: inspected=${backfill.inspected} ` +
    `created=${backfill.created} ` +
    `skippedNoListing=${backfill.skippedNoListing} ` +
    `skippedAlreadyInstalled=${backfill.skippedAlreadyInstalled} ` +
    `skippedNoOwner=${backfill.skippedNoOwner} ` +
    `skippedSeedMarker=${backfill.skippedSeedMarker}`,
  )

  log(`backfilling Project.settings (canvasMode/activeMode) on existing installs...`)
  const settingsBackfill = await backfillInstallSettings(dryRun)
  log(
    `settings backfill: inspected=${settingsBackfill.inspected} ` +
    `updated=${settingsBackfill.updated} ` +
    `skippedComplete=${settingsBackfill.skippedComplete} ` +
    `skippedNoSource=${settingsBackfill.skippedNoSource}`,
  )

  return { templates: results, backfill, ranAt: new Date() }
}

interface SettingsBackfillStats {
  inspected: number
  updated: number
  skippedComplete: number
  skippedNoSource: number
}

/**
 * Walk every `MarketplaceInstall` row and copy missing UI-mode keys
 * (`canvasMode`, `activeMode`) from the listing's source project
 * settings down to the installed project's settings. Idempotent: rows
 * that already have both keys are left alone.
 *
 * Why this exists: the migration script's first run on staging/prod
 * created source projects without `canvasMode` (the value lived in
 * `.shogo/config.json`, not in the DB). Every install made before
 * we lifted that field into `Project.settings` rendered the empty
 * surfaces placeholder ("Connected" with no preview) instead of the
 * canvas iframe. This backfill repairs them in place.
 */
async function backfillInstallSettings(
  dryRun: boolean,
): Promise<SettingsBackfillStats> {
  const stats: SettingsBackfillStats = {
    inspected: 0,
    updated: 0,
    skippedComplete: 0,
    skippedNoSource: 0,
  }

  const PAGE = 200
  let cursor: string | null = null
  while (true) {
    const installs: Array<{
      id: string
      projectId: string
      project: { id: string; settings: unknown } | null
      listing: { project: { settings: unknown } | null } | null
    }> = await prisma.marketplaceInstall.findMany({
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        projectId: true,
        project: { select: { id: true, settings: true } },
        listing: { select: { project: { select: { settings: true } } } },
      },
    })
    if (installs.length === 0) break

    for (const inst of installs) {
      stats.inspected++
      if (!inst.project) continue
      const projSettings =
        (inst.project.settings as Record<string, unknown> | null) ?? {}
      const srcSettings =
        (inst.listing?.project?.settings as Record<string, unknown> | null) ?? null

      const needsCanvas = projSettings.canvasMode == null
      const needsActive = projSettings.activeMode == null
      if (!needsCanvas && !needsActive) {
        stats.skippedComplete++
        continue
      }
      if (!srcSettings) {
        stats.skippedNoSource++
        continue
      }

      const patch: Record<string, unknown> = {}
      if (needsCanvas && typeof srcSettings.canvasMode === 'string') {
        patch.canvasMode = srcSettings.canvasMode
      }
      if (needsActive && typeof srcSettings.activeMode === 'string') {
        patch.activeMode = srcSettings.activeMode
      }
      if (Object.keys(patch).length === 0) {
        stats.skippedNoSource++
        continue
      }

      const merged = { ...projSettings, ...patch }
      if (!dryRun) {
        await prisma.project.update({
          where: { id: inst.project.id },
          data: { settings: merged as object },
        })
      }
      stats.updated++
    }

    cursor = installs[installs.length - 1].id
    if (installs.length < PAGE) break
  }

  return stats
}

function emptyBackfill(): BackfillStats {
  return {
    inspected: 0,
    created: 0,
    skippedNoListing: 0,
    skippedAlreadyInstalled: 0,
    skippedNoOwner: 0,
    skippedSeedMarker: 0,
  }
}

// CLI usage: `bun apps/api/scripts/migrate-templates-to-marketplace.ts [--dry-run]`
if (import.meta.main) {
  const dryRun = process.argv.includes('--dry-run')
  runMigration({ dryRun })
    .then(() => prisma.$disconnect())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('[migrate-templates] failed:', err)
      await prisma.$disconnect().catch(() => undefined)
      process.exit(1)
    })
}
