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
  getProviderLabel,
  type ModelEntry,
  type ModelTier,
} from '@shogo/model-catalog'
import { createHttpClient } from './api'

export interface PickerModel {
  id: string
  displayName: string
  tier: ModelTier
}

export interface PickerGroup {
  label: string
  models: PickerModel[]
}

const DEFAULT_OR_TIER: ModelTier = 'standard'

let cached: ResolvedVisibleModels | null = null
let inflight: Promise<ResolvedVisibleModels> | null = null

async function fetchVisibleModels(): Promise<ResolvedVisibleModels> {
  if (cached) return cached
  if (!inflight) {
    const platform = new PlatformApi(createHttpClient())
    inflight = platform
      .getVisibleModels()
      .then((data) => {
        cached = data
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
    bucket.push({ id: m.id, displayName: m.displayName, tier: m.tier as ModelTier })
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
          tier: m.tier as ModelTier,
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
