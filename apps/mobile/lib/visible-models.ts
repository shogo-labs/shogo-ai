// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Visible Models — the user-facing model picker's data source.
 *
 * Reads `/api/platform/visible-models` (the API server's `getVisibleModels`
 * SDK method) and shapes the result for the chat-input pickers. The server is
 * the single source of truth: it returns the admin-managed model set
 * (`catalogModels`, sorted by admin `sortOrder`) plus any OpenRouter extras.
 *
 * This module deliberately does NOT fall back to the bundled `MODEL_CATALOG`.
 * Mixing the code-shipped catalog with the server set caused the picker to
 * paint the bundled models first and then flicker to the server set, and meant
 * admins couldn't fully control what users saw. The server already carries its
 * own static fallback (used only when its DB is empty), so the client never
 * needs a second one.
 *
 * Caching: the resolved snapshot is held in a module-level in-memory cache and
 * (on web) mirrored to `localStorage`, so a remount — or a full page reload —
 * paints the last-known list synchronously with no flash, then revalidates in
 * the background (stale-while-revalidate).
 */
import { useEffect, useMemo, useState } from 'react'
import { PlatformApi, type ResolvedVisibleModels } from '@shogo-ai/sdk'
import { AUTO_MODEL_ID, type ModelTier } from '@shogo/model-catalog'
import { createHttpClient } from './api'

export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface PickerModel {
  id: string
  displayName: string
  shortDisplayName?: string
  tier: ModelTier
  family?: string
  /** Native provider id (e.g. `anthropic`, `custom`). Lets surfaces that
   *  need the provider (not just the group label) build their options. */
  provider?: string
  /** Short blurb shown in the picker info panel. */
  description?: string
  /** Total context window in tokens (distinct from max output tokens). */
  contextWindow?: number
  /** Reasoning effort applied when the model runs. */
  reasoningEffort?: ReasoningEffort
}

export interface PickerGroup {
  label: string
  models: PickerModel[]
}

const DEFAULT_OR_TIER: ModelTier = 'standard'

// ===========================================================================
// In-memory cache (mirrored to localStorage on web) — stale-while-revalidate.
// ===========================================================================

const STORAGE_KEY = 'shogo.visibleModels.v1'

/** Web localStorage when available; undefined on native / SSR / tests. */
function storage(): Storage | undefined {
  try {
    const ls = (globalThis as any)?.localStorage
    return ls && typeof ls.getItem === 'function' ? (ls as Storage) : undefined
  } catch {
    return undefined
  }
}

function readPersisted(): ResolvedVisibleModels | null {
  const ls = storage()
  if (!ls) return null
  try {
    const raw = ls.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as ResolvedVisibleModels) : null
  } catch {
    return null
  }
}

function writePersisted(data: ResolvedVisibleModels): void {
  const ls = storage()
  if (!ls) return
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    /* quota / serialization — non-fatal, fall back to in-memory only */
  }
}

/** Per-id metadata resolved by the serving API. Kept module-global so non-picker
 *  surfaces (chips, analytics, the runtime config sync) can resolve a model's
 *  display/family/tier/provider by id without re-fetching. */
interface ResolvedModelMeta {
  displayName: string
  shortDisplayName?: string
  tier: ModelTier
  family?: string
  provider?: string
  maxOutputTokens?: number
  description?: string
  contextWindow?: number
  reasoningEffort?: ReasoningEffort
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
      provider: m.provider,
      maxOutputTokens: m.maxOutputTokens,
      description: m.description,
      contextWindow: m.contextWindow,
      reasoningEffort: m.reasoningEffort as ReasoningEffort | undefined,
    })
  }
  for (const m of data.openrouterModels ?? []) {
    if (serverModelMeta.has(m.id)) continue
    serverModelMeta.set(m.id, {
      displayName: m.displayName,
      tier: (m.tier as ModelTier | undefined) ?? DEFAULT_OR_TIER,
      family: 'other',
      provider: 'openrouter',
    })
  }
}

// Seed the cache (and the metadata index) from persisted storage at module
// load so the very first render — including after a full page reload — has the
// last-known model set immediately, with no bundled-catalog flicker.
let cached: ResolvedVisibleModels | null = readPersisted()
if (cached) indexServerCatalog(cached)
let inflight: Promise<ResolvedVisibleModels> | null = null

/** Fetch the latest snapshot, update the in-memory + persisted cache and the
 *  metadata index, and return it. Deduplicates concurrent callers. On failure
 *  the last-known snapshot is preserved (returned if present). */
function revalidate(): Promise<ResolvedVisibleModels> {
  if (!inflight) {
    const platform = new PlatformApi(createHttpClient())
    inflight = platform
      .getVisibleModels()
      .then((data) => {
        cached = data
        indexServerCatalog(data)
        writePersisted(data)
        return data
      })
      .catch(() => cached ?? { catalogIds: null, openrouterModels: [] })
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

/** Drop the cached visible-models snapshot and refetch. Call after admin saves
 *  changes so chat pickers pick up the new set. The last-known snapshot is kept
 *  in `cached` until the refetch lands, so there's no empty flash. */
export function invalidateVisibleModelsCache(): void {
  inflight = null
  void revalidate()
}

// ===========================================================================
// Metadata resolver chain — server metadata (covers all admin-managed models,
// including DB-only / custom-provider ones) → id-based heuristics. Use these
// on any surface that needs to label/gate a model by id.
// ===========================================================================

/** Resolve a model's full display name from its id. */
export function resolveDisplayName(id: string): string {
  if (id === AUTO_MODEL_ID) return 'Auto'
  const server = serverModelMeta.get(id)
  if (server?.displayName) return server.displayName
  return id
}

/** Resolve a model's short display name (for compact chips). */
export function resolveShortName(id: string): string {
  if (!id) return 'Unknown'
  if (id === AUTO_MODEL_ID) return 'Auto'
  const server = serverModelMeta.get(id)
  if (server?.shortDisplayName) return server.shortDisplayName
  if (server?.displayName) return server.displayName
  return id.length > 20 ? id.slice(0, 20) + '...' : id
}

/** Resolve a model's tier (for Pro gating). Server metadata wins; falls back to
 *  an id heuristic for ids the server doesn't (yet) know about. */
export function resolveTier(id: string): ModelTier {
  if (id === AUTO_MODEL_ID) return 'economy'
  const server = serverModelMeta.get(id)
  if (server) return server.tier
  const lower = id.toLowerCase()
  if (lower.includes('opus')) return 'premium'
  if (lower.includes('haiku') || lower.includes('nano') || lower.includes('mini')) return 'economy'
  return 'standard'
}

/** Resolve a model's family (for color-coding/labels). */
export function resolveFamily(id: string): string {
  const server = serverModelMeta.get(id)
  if (server?.family) return server.family
  const lower = id.toLowerCase()
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('haiku')) return 'haiku'
  if (lower.includes('gpt')) return 'gpt'
  return 'other'
}

/** Resolve a model's native provider id (e.g. `anthropic`, `openai`,
 *  `custom`). Server metadata only — returns undefined for unknown ids. */
export function resolveProvider(id: string): string | undefined {
  return serverModelMeta.get(id)?.provider
}

/** Resolve a model's configured reasoning effort, if any. */
export function resolveReasoningEffort(id: string): ReasoningEffort | undefined {
  return serverModelMeta.get(id)?.reasoningEffort
}

// ===========================================================================
// Picker list/group builders — purely server-driven.
// ===========================================================================

/** Human label for a native provider id, used to title picker groups. */
function providerGroupLabel(provider: string): string {
  switch (provider) {
    case 'anthropic':
      return 'Anthropic'
    case 'openai':
      return 'OpenAI'
    case 'google':
      return 'Google'
    case 'openrouter':
      return 'OpenRouter'
    case 'custom':
      return 'Custom'
    case 'local':
      return 'Local'
    default:
      return provider.charAt(0).toUpperCase() + provider.slice(1)
  }
}

function toPickerModel(m: NonNullable<ResolvedVisibleModels['catalogModels']>[number]): PickerModel {
  return {
    id: m.id,
    displayName: m.displayName,
    shortDisplayName: m.shortDisplayName,
    tier: (m.tier as ModelTier) ?? 'standard',
    family: m.family,
    provider: m.provider,
    description: m.description,
    contextWindow: m.contextWindow,
    reasoningEffort: m.reasoningEffort as ReasoningEffort | undefined,
  }
}

/**
 * Group the server's catalog models by provider, preserving first-seen
 * provider order. OpenRouter extras are appended as their own group.
 */
export function buildModelGroups(visible: ResolvedVisibleModels | null): PickerGroup[] {
  const groups: PickerGroup[] = []
  const byLabel = new Map<string, PickerModel[]>()
  for (const m of visible?.catalogModels ?? []) {
    const label = providerGroupLabel(m.provider)
    let bucket = byLabel.get(label)
    if (!bucket) {
      bucket = []
      byLabel.set(label, bucket)
      groups.push({ label, models: bucket })
    }
    bucket.push(toPickerModel(m))
  }

  const openrouterModels = visible?.openrouterModels ?? []
  if (openrouterModels.length > 0) {
    groups.push({
      label: 'OpenRouter',
      models: openrouterModels.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        tier: (m.tier as ModelTier | undefined) ?? DEFAULT_OR_TIER,
      })),
    })
  }

  return groups.filter((g) => g.models.length > 0)
}

/** Subscribe to the admin-configured visible-models snapshot. Returns the
 *  cached snapshot synchronously (when available) and revalidates in the
 *  background. While the first-ever fetch is in flight (and nothing is
 *  cached) this is `null` — callers render an empty/loading picker. */
export function useVisibleModels(): ResolvedVisibleModels | null {
  const [snapshot, setSnapshot] = useState<ResolvedVisibleModels | null>(cached)

  useEffect(() => {
    let cancelled = false
    revalidate().then((data) => {
      if (!cancelled) setSnapshot(data)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return snapshot
}

/** Memoised hook combining `useVisibleModels()` + `buildModelGroups()`. */
export function useModelPickerGroups(): PickerGroup[] {
  const visible = useVisibleModels()
  return useMemo(() => buildModelGroups(visible), [visible])
}

/**
 * Build a single flat, admin-ordered list of picker models (the redesigned
 * chat picker layout). Order is whatever the serving API returns — it sorts
 * the catalog by each model's admin-set `sortOrder`. OpenRouter extras are
 * appended last.
 */
export function buildModelList(visible: ResolvedVisibleModels | null): PickerModel[] {
  const out: PickerModel[] = []
  for (const m of visible?.catalogModels ?? []) {
    out.push(toPickerModel(m))
  }
  for (const m of visible?.openrouterModels ?? []) {
    out.push({
      id: m.id,
      displayName: m.displayName,
      tier: (m.tier as ModelTier | undefined) ?? DEFAULT_OR_TIER,
    })
  }
  return out
}

/** Memoised hook returning the flat, admin-ordered picker list. */
export function useModelPickerList(): PickerModel[] {
  const visible = useVisibleModels()
  return useMemo(() => buildModelList(visible), [visible])
}
