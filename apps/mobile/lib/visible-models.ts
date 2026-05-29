// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Visible Models — admin-curated allowlist for the user-facing model picker.
 *
 * Reads `/api/platform/visible-models` (returned by the API server's
 * `getVisibleModels` SDK method) and shapes the result for the chat input
 * pickers. Catalog filtering and the OpenRouter "extras" group both come
 * from the same admin-controlled config, so the picker logic stays in one
 * place.
 */
import { useEffect, useMemo, useState } from 'react'
import { PlatformApi, type ResolvedVisibleModels } from '@shogo-ai/sdk'
import {
  getModelsByProvider,
  getModelEntry,
  getProviderLabel,
  AUTO_MODEL_ID,
  type ModelEntry,
  type ModelTier,
} from '@shogo/model-catalog'
import { createHttpClient } from './api'

export interface PickerModel {
  id: string
  displayName: string
  shortDisplayName?: string
  tier: ModelTier
  family?: string
  /** Native provider id (e.g. `anthropic`, `custom`). Lets surfaces that
   *  need the provider (not just the group label) build their options. */
  provider?: string
}

export interface PickerGroup {
  label: string
  models: PickerModel[]
}

const DEFAULT_OR_TIER: ModelTier = 'standard'

let cached: ResolvedVisibleModels | null = null
let inflight: Promise<ResolvedVisibleModels> | null = null

/** Per-id metadata resolved by the serving API (notably for DB-defined models
 *  this build doesn't carry in its bundled `MODEL_CATALOG`, e.g. MiMo). Kept
 *  module-global so non-picker surfaces (chips, analytics) can resolve a
 *  model's display/family/tier without re-fetching. */
interface ResolvedModelMeta {
  displayName: string
  shortDisplayName?: string
  tier: ModelTier
  family?: string
  maxOutputTokens?: number
}

const serverModelMeta = new Map<string, ResolvedModelMeta>()

function indexServerCatalog(data: ResolvedVisibleModels): void {
  serverModelMeta.clear()
  for (const m of data.catalogModels ?? []) {
    serverModelMeta.set(m.id, {
      displayName: m.displayName,
      shortDisplayName: m.shortDisplayName,
      tier: (m.tier as ModelTier) ?? 'standard',
      family: m.family,
      maxOutputTokens: m.maxOutputTokens,
    })
  }
  for (const m of data.openrouterModels ?? []) {
    if (serverModelMeta.has(m.id)) continue
    serverModelMeta.set(m.id, {
      displayName: m.displayName,
      tier: (m.tier as ModelTier | undefined) ?? DEFAULT_OR_TIER,
      family: 'other',
    })
  }
}

async function fetchVisibleModels(): Promise<ResolvedVisibleModels> {
  if (cached) return cached
  if (!inflight) {
    const platform = new PlatformApi(createHttpClient())
    inflight = platform
      .getVisibleModels()
      .then((data) => {
        cached = data
        indexServerCatalog(data)
        return data
      })
      .catch(() => {
        const fallback: ResolvedVisibleModels = { catalogIds: null, openrouterModels: [] }
        cached = fallback
        return fallback
      })
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

/** Drop the cached visible-models snapshot. Call after admin saves changes
 * so the next mount of a chat picker sees the new allowlist. */
export function invalidateVisibleModelsCache(): void {
  cached = null
  inflight = null
  serverModelMeta.clear()
}

// ===========================================================================
// Metadata resolver chain — server metadata (cloud-resolved, covers DB-only
// models) → bundled MODEL_CATALOG → id-based heuristics. Use these on any
// surface that needs to label/gate a model by id so DB-defined models render
// correctly even though they aren't in this build's bundled catalog.
// ===========================================================================

/** Resolve a model's full display name from its id. */
export function resolveDisplayName(id: string): string {
  if (id === AUTO_MODEL_ID) return 'Auto'
  const server = serverModelMeta.get(id)
  if (server?.displayName) return server.displayName
  const entry = getModelEntry(id)
  if (entry) return entry.displayName
  return id
}

/** Resolve a model's short display name (for compact chips). */
export function resolveShortName(id: string): string {
  if (!id) return 'Unknown'
  if (id === AUTO_MODEL_ID) return 'Auto'
  const server = serverModelMeta.get(id)
  if (server?.shortDisplayName) return server.shortDisplayName
  if (server?.displayName) return server.displayName
  const entry = getModelEntry(id)
  if (entry) return entry.shortDisplayName ?? entry.displayName
  return id.length > 20 ? id.slice(0, 20) + '...' : id
}

/** Resolve a model's tier (for Pro gating). Server metadata wins so
 *  DB-defined models gate by their admin-set tier; falls back to bundled
 *  catalog then the same id heuristics as `getModelTier`. */
export function resolveTier(id: string): ModelTier {
  if (id === AUTO_MODEL_ID) return 'economy'
  const server = serverModelMeta.get(id)
  if (server) return server.tier
  const entry = getModelEntry(id)
  if (entry) return entry.tier
  const lower = id.toLowerCase()
  if (lower.includes('opus')) return 'premium'
  if (lower.includes('haiku') || lower.includes('nano') || lower.includes('mini')) return 'economy'
  return 'standard'
}

/** Resolve a model's family (for color-coding/labels). Falls back to a
 *  best-effort id heuristic when neither server nor bundled metadata knows. */
export function resolveFamily(id: string): string {
  const server = serverModelMeta.get(id)
  if (server?.family) return server.family
  const entry = getModelEntry(id)
  if (entry) return entry.family
  const lower = id.toLowerCase()
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('haiku')) return 'haiku'
  if (lower.includes('gpt')) return 'gpt'
  return 'other'
}

/**
 * Group a flat list of resolved catalog models by provider, preserving
 * first-seen provider order. Used when the serving API ships
 * `catalogModels` (e.g. a cloud-connected desktop), so the picker renders
 * the connected cloud's catalog rather than this build's bundled one.
 */
function groupResolvedCatalogModels(
  models: NonNullable<ResolvedVisibleModels['catalogModels']>,
): PickerGroup[] {
  const order: string[] = []
  const byLabel = new Map<string, PickerModel[]>()
  for (const m of models) {
    const label = getProviderLabel(m.provider)
    let bucket = byLabel.get(label)
    if (!bucket) {
      bucket = []
      byLabel.set(label, bucket)
      order.push(label)
    }
    bucket.push({
      id: m.id,
      displayName: m.displayName,
      shortDisplayName: m.shortDisplayName,
      tier: m.tier as ModelTier,
      family: m.family,
      provider: m.provider,
    })
  }
  return order.map((label) => ({ label, models: byLabel.get(label)! }))
}

/**
 * Build the picker groups from the catalog + OpenRouter extras, applying
 * the admin allowlist. Pure, no I/O — feed it the snapshot from
 * `useVisibleModels()`.
 *
 * Catalog source:
 * - When the snapshot carries `catalogModels` (the serving API resolved the
 *   allowlist against its own catalog — notably a connected Shogo Cloud),
 *   render those directly so models absent from this build still show.
 * - Otherwise fall back to filtering this build's bundled catalog by
 *   `catalogIds` (`null` = all current-generation models; `[]` = none).
 *
 * OpenRouter extras are always appended as their own group. Their tier
 * defaults to `standard` if the admin didn't classify them.
 */
export function buildModelGroups(
  visible: ResolvedVisibleModels | null,
): PickerGroup[] {
  const openrouterModels = visible?.openrouterModels ?? []

  let catalogGroups: PickerGroup[]
  if (visible?.catalogModels) {
    catalogGroups = groupResolvedCatalogModels(visible.catalogModels).filter(
      (g) => g.models.length > 0,
    )
  } else {
    const catalogIds = visible?.catalogIds ?? null
    const allowed = catalogIds === null ? null : new Set(catalogIds)
    catalogGroups = getModelsByProvider().map((g): PickerGroup => ({
      label: g.label,
      models: g.models
        .filter((m: ModelEntry) => allowed === null || allowed.has(m.id))
        .map((m: ModelEntry) => ({
          id: m.id,
          displayName: m.displayName,
          shortDisplayName: m.shortDisplayName,
          tier: m.tier as ModelTier,
          family: m.family,
          provider: m.provider,
        })),
    })).filter((g) => g.models.length > 0)
  }

  if (openrouterModels.length > 0) {
    catalogGroups.push({
      label: 'OpenRouter',
      models: openrouterModels.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        tier: (m.tier as ModelTier | undefined) ?? DEFAULT_OR_TIER,
      })),
    })
  }

  return catalogGroups
}

/** Subscribe to the admin-configured visible-models snapshot. While the
 * fetch is in flight the hook returns `null` — callers should treat that
 * as "use the full catalog" and avoid blocking the UI on it. */
export function useVisibleModels(): ResolvedVisibleModels | null {
  const [snapshot, setSnapshot] = useState<ResolvedVisibleModels | null>(cached)

  useEffect(() => {
    let cancelled = false
    fetchVisibleModels().then((data) => {
      if (!cancelled) setSnapshot(data)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return snapshot
}

/** Memoised hook that combines `useVisibleModels()` + `buildModelGroups()`
 * and adapts to the admin allowlist on the fly. */
export function useModelPickerGroups(): PickerGroup[] {
  const visible = useVisibleModels()
  return useMemo(() => buildModelGroups(visible), [visible])
}
