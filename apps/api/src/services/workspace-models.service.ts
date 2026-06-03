// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace model visibility service.
 *
 * Lets a workspace owner/admin curate which models their members can see and
 * use, as a SUBSET of the platform-visible set (which the super-admin controls
 * via `models.visible`). The selection can only narrow what the platform
 * exposes — never widen it; the subset rule is enforced by the write API.
 *
 * Storage: the `WorkspaceModelVisibility` table holds one row per explicitly
 * allowed model id. Semantics:
 *   - zero rows for a workspace -> inherit ALL platform-visible models
 *   - >= 1 row                  -> restrict to exactly those ids
 *
 * Caching: a per-workspace in-memory snapshot with a short TTL plus explicit
 * `invalidateWorkspaceModels(workspaceId)` (called by the write route). The AI
 * proxy calls `isModelVisibleForWorkspace` on every request, so the cache keeps
 * that off the DB hot path.
 */

import { prisma } from '../lib/prisma'
import { AUTO_MODEL_ID } from '@shogo/model-catalog'

const CACHE_TTL_MS = 30_000

interface CacheEntry {
  /** `null` = inherit (no restriction); otherwise the explicit allowlist. */
  ids: Set<string> | null
  loadedAt: number
}

const cache = new Map<string, CacheEntry>()

function isFresh(entry: CacheEntry | undefined): entry is CacheEntry {
  return !!entry && Date.now() - entry.loadedAt <= CACHE_TTL_MS
}

async function loadAllowedModelIds(workspaceId: string): Promise<Set<string> | null> {
  const rows = await prisma.workspaceModelVisibility.findMany({
    where: { workspaceId },
    select: { modelId: true },
  })
  // No rows -> inherit all platform-visible models.
  if (rows.length === 0) return null
  return new Set(rows.map((r) => r.modelId))
}

/**
 * Allowed model ids for a workspace. `null` means "inherit" (no restriction —
 * show every platform-visible model). A non-null `Set` is the explicit
 * allowlist. Cached for {@link CACHE_TTL_MS}.
 */
export async function getAllowedModelIds(workspaceId: string): Promise<Set<string> | null> {
  const cached = cache.get(workspaceId)
  if (isFresh(cached)) return cached.ids
  try {
    const ids = await loadAllowedModelIds(workspaceId)
    cache.set(workspaceId, { ids, loadedAt: Date.now() })
    return ids
  } catch (err) {
    // On a DB hiccup, fail OPEN (inherit) rather than blocking every model —
    // a transient error shouldn't lock a workspace out of its models. Stamp a
    // short-lived cache so we don't hot-loop the failing query.
    console.error(`[workspace-models] load failed for ${workspaceId}, inheriting:`, (err as Error).message)
    cache.set(workspaceId, { ids: null, loadedAt: Date.now() })
    return null
  }
}

/**
 * Replace the workspace's allowlist with `ids`. An empty array clears all rows
 * (reverts to "inherit"). Runs in a transaction so the change is atomic.
 *
 * NOTE: this does NOT validate that ids are in the platform-visible set; the
 * write route is responsible for the subset check before calling this.
 */
export async function setAllowedModelIds(
  workspaceId: string,
  ids: string[],
  userId: string | null,
): Promise<void> {
  const unique = Array.from(new Set(ids.filter((x) => typeof x === 'string' && x.length > 0)))
  await prisma.$transaction([
    prisma.workspaceModelVisibility.deleteMany({ where: { workspaceId } }),
    ...(unique.length > 0
      ? [
          prisma.workspaceModelVisibility.createMany({
            data: unique.map((modelId) => ({ workspaceId, modelId, createdBy: userId })),
            skipDuplicates: true,
          }),
        ]
      : []),
  ])
  invalidateWorkspaceModels(workspaceId)
}

/** Drop the cached allowlist for a workspace. Call after a write. */
export function invalidateWorkspaceModels(workspaceId: string): void {
  cache.delete(workspaceId)
}

interface PlatformModelSets<C extends { id: string }, O extends { id: string }> {
  catalogModels: C[]
  openrouterModels: O[]
}

/**
 * Narrow a platform-visible payload to a workspace's allowlist. `allowed ===
 * null` means inherit (the full platform set is returned unchanged); otherwise
 * only models whose id is in the allowlist survive. This is the intersection
 * that drives the per-workspace picker.
 */
export function filterToAllowlist<C extends { id: string }, O extends { id: string }>(
  platform: PlatformModelSets<C, O>,
  allowed: Set<string> | null,
): PlatformModelSets<C, O> {
  if (allowed === null) return platform
  return {
    catalogModels: platform.catalogModels.filter((m) => allowed.has(m.id)),
    openrouterModels: platform.openrouterModels.filter((m) => allowed.has(m.id)),
  }
}

/**
 * The requested ids that are NOT in the platform-visible set. A workspace can
 * only narrow what the super-admin exposes, so a non-empty result means the
 * write violates the subset rule and must be rejected.
 */
export function modelsOutsidePlatform(
  requestedIds: string[],
  platform: PlatformModelSets<{ id: string }, { id: string }>,
): string[] {
  const platformIds = new Set<string>([
    ...platform.catalogModels.map((m) => m.id),
    ...platform.openrouterModels.map((m) => m.id),
  ])
  return requestedIds.filter((id) => !platformIds.has(id))
}

/** Test-only: clear the entire cache. */
export function __clearWorkspaceModelsCache(): void {
  cache.clear()
}

/**
 * Whether `modelId` is visible to `workspaceId`. True when the workspace
 * inherits (no restriction) or the id is in its allowlist. The special `auto`
 * meta-model is always allowed — it resolves server-side to a platform-default
 * concrete model. Aliases resolve to their canonical id before the check.
 */
export async function isModelVisibleForWorkspace(workspaceId: string, modelId: string): Promise<boolean> {
  const allowed = await getAllowedModelIds(workspaceId)
  if (allowed === null) return true
  if (!modelId || modelId === AUTO_MODEL_ID) return true
  if (allowed.has(modelId)) return true
  // Resolve aliases (e.g. a DB-defined model's alias) to the canonical id so a
  // hidden model can't be reached via an alias the picker never showed.
  try {
    const { getMergedModelEntrySync } = await import('./model-registry.service')
    const entry = getMergedModelEntrySync(modelId)
    if (entry && allowed.has(entry.id)) return true
  } catch {
    // registry unavailable — fall through to the raw-id result below
  }
  return false
}
