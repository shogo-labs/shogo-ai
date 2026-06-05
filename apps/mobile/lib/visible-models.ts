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
import { getActiveWorkspaceId } from './workspace-store'

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

/** Sentinel cache key for the unscoped platform-visible set (no active
 *  workspace). Real workspace ids are used verbatim as keys, so the picker is
 *  scoped to the active workspace's admin-curated subset. */
const PLATFORM_KEY = '__platform__'

/** The cache key for the picker right now: the active workspace id, or the
 *  platform sentinel when none is selected (e.g. local mode / signed-out). */
function activeCacheKey(): string {
  return getActiveWorkspaceId() ?? PLATFORM_KEY
}

/** Web localStorage when available; undefined on native / SSR / tests. */
function storage(): Storage | undefined {
  try {
    const ls = (globalThis as any)?.localStorage
    return ls && typeof ls.getItem === 'function' ? (ls as Storage) : undefined
  } catch {
    return undefined
  }
}

function storageKeyFor(cacheKey: string): string {
  return `${STORAGE_KEY}:${cacheKey}`
}

function readPersisted(cacheKey: string): ResolvedVisibleModels | null {
  const ls = storage()
  if (!ls) return null
  try {
    const raw = ls.getItem(storageKeyFor(cacheKey))
    return raw ? (JSON.parse(raw) as ResolvedVisibleModels) : null
  } catch {
    return null
  }
}

function writePersisted(cacheKey: string, data: ResolvedVisibleModels): void {
  const ls = storage()
  if (!ls) return
  try {
    ls.setItem(storageKeyFor(cacheKey), JSON.stringify(data))
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

// Per-key snapshot cache (keyed by active workspace id, or PLATFORM_KEY). Seed
// the active key from persisted storage at module load so the very first render
// — including after a full page reload — has the last-known model set
// immediately, with no bundled-catalog flicker.
const cache = new Map<string, ResolvedVisibleModels>()
const inflight = new Map<string, Promise<ResolvedVisibleModels>>()

{
  const key = activeCacheKey()
  const seed = readPersisted(key)
  if (seed) {
    cache.set(key, seed)
    indexServerCatalog(seed)
  }
}

/** Read the cached snapshot for a key (in-memory, then persisted). */
function getCached(cacheKey: string): ResolvedVisibleModels | null {
  const mem = cache.get(cacheKey)
  if (mem) return mem
  const persisted = readPersisted(cacheKey)
  if (persisted) cache.set(cacheKey, persisted)
  return persisted
}

/** Fetch the latest snapshot for a key, update the in-memory + persisted cache
 *  and the metadata index, and return it. Deduplicates concurrent callers. On
 *  failure the last-known snapshot is preserved (returned if present).
 *
 *  When the key is a workspace id the workspace-scoped endpoint is used (the
 *  admin-curated subset); otherwise the unscoped platform set. */
function revalidate(cacheKey: string): Promise<ResolvedVisibleModels> {
  let pending = inflight.get(cacheKey)
  if (!pending) {
    const platform = new PlatformApi(createHttpClient())
    const fetcher =
      cacheKey === PLATFORM_KEY
        ? platform.getVisibleModels()
        : platform.getWorkspaceVisibleModels(cacheKey)
    pending = fetcher
      .then((data) => {
        cache.set(cacheKey, data)
        // Only re-index the global metadata map when this key is still the
        // active one, so a background refresh for a now-inactive workspace
        // doesn't clobber the active workspace's metadata.
        if (cacheKey === activeCacheKey()) indexServerCatalog(data)
        writePersisted(cacheKey, data)
        return data
      })
      .catch(() => getCached(cacheKey) ?? { catalogIds: null, openrouterModels: [] })
      .finally(() => {
        inflight.delete(cacheKey)
      })
    inflight.set(cacheKey, pending)
  }
  return pending
}

/** Drop the cached visible-models snapshot and refetch. Call after an admin
 *  saves changes so chat pickers pick up the new set. Pass a workspace id to
 *  refresh that workspace's scoped set; omit to refresh the currently-active
 *  key. The last-known snapshot is kept until the refetch lands (no flash). */
export function invalidateVisibleModelsCache(workspaceId?: string): void {
  const key = workspaceId ?? activeCacheKey()
  inflight.delete(key)
  void revalidate(key)
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

/** Subscribe to the visible-models snapshot for the active workspace (the
 *  admin-curated subset), or the platform set when no workspace is active.
 *  Returns the cached snapshot synchronously (when available) and revalidates
 *  in the background. While the first-ever fetch is in flight (and nothing is
 *  cached) this is `null` — callers render an empty/loading picker. */
export function useVisibleModels(): ResolvedVisibleModels | null {
  const cacheKey = activeCacheKey()
  const [snapshot, setSnapshot] = useState<ResolvedVisibleModels | null>(() => getCached(cacheKey))

  useEffect(() => {
    let cancelled = false
    // Paint the cached snapshot for this key immediately (covers a workspace
    // switch where the key changed since the last render).
    setSnapshot(getCached(cacheKey))
    revalidate(cacheKey).then((data) => {
      if (!cancelled) setSnapshot(data)
    })
    return () => {
      cancelled = true
    }
  }, [cacheKey])

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

// ===========================================================================
// Stale-selection reconciliation.
//
// Model ids that pre-date the slug->UUID migration (e.g. `mimo-v2.5`,
// `claude-opus-4-8`) survive only as server-side aliases — they are no longer
// catalog ids. A selection persisted before the migration therefore can't be
// matched or labelled by the picker (it renders the raw slug). Detect that and
// reset to the tier default once the live catalog has loaded.
// ===========================================================================

/**
 * Decide whether a stored selection is stale against the live catalog. Returns
 * the id to reset to, or `null` when no reset is needed — i.e. the selection is
 * `Auto`/a known catalog id, or the catalog hasn't loaded yet (so a valid
 * selection is never reset before metadata arrives). If the requested
 * `fallback` itself isn't visible, returns `AUTO_MODEL_ID` so we never swap one
 * unrenderable slug for another.
 */
export function reconcileModelSelection(
  selected: string,
  fallback: string,
  visible: ResolvedVisibleModels | null,
): string | null {
  if (!visible) return null
  const known = new Set<string>([
    ...(visible.catalogModels ?? []).map((m) => m.id),
    ...(visible.openrouterModels ?? []).map((m) => m.id),
  ])
  if (known.size === 0) return null
  if (selected === AUTO_MODEL_ID || known.has(selected)) return null
  return known.has(fallback) ? fallback : AUTO_MODEL_ID
}

/**
 * Reset a stale stored model selection to `fallback` once the catalog loads.
 * `onReset` should route through the owner's normal model-change handler so the
 * corrected id is persisted (and any runtime config re-synced). Pass
 * `enabled = false` to skip reconciliation (e.g. when a parent already owns and
 * reconciles the selection).
 */
export function useReconcileStaleModelSelection(
  selected: string,
  fallback: string,
  onReset: (id: string) => void,
  enabled = true,
): void {
  const visible = useVisibleModels()
  useEffect(() => {
    if (!enabled) return
    const next = reconcileModelSelection(selected, fallback, visible)
    if (next && next !== selected) onReset(next)
  }, [visible, selected, fallback, onReset, enabled])
}
