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
 * Build the picker groups from the catalog + OpenRouter extras, applying
 * the admin allowlist. Pure, no I/O — feed it the snapshot from
 * `useVisibleModels()`.
 *
 * Rules:
 * - `catalogIds === null` means "show all current-generation catalog
 *   models" (the default — admin hasn't curated a list yet).
 * - `catalogIds === []` removes every catalog model; the picker may still
 *   show OpenRouter extras.
 * - OpenRouter extras are appended as their own group. Their tier
 *   defaults to `standard` if the admin didn't classify them.
 */
export function buildModelGroups(
  visible: ResolvedVisibleModels | null,
): PickerGroup[] {
  const catalogIds = visible?.catalogIds ?? null
  const openrouterModels = visible?.openrouterModels ?? []

  const allowed = catalogIds === null ? null : new Set(catalogIds)
  const catalogGroups = getModelsByProvider().map((g): PickerGroup => ({
    label: g.label,
    models: g.models
      .filter((m: ModelEntry) => allowed === null || allowed.has(m.id))
      .map((m: ModelEntry) => ({
        id: m.id,
        displayName: m.displayName,
        tier: m.tier as ModelTier,
      })),
  })).filter((g) => g.models.length > 0)

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
