// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Model registry service.
 *
 * Merges the static, code-shipped `MODEL_CATALOG` with DB-defined models
 * (the `ModelDefinition` table) so new models — including custom
 * OpenAI-compatible third-party endpoints (the `ModelProvider` table, e.g.
 * MiMo / xiaomimimo) — can be added entirely from super admin without a
 * code release.
 *
 * The static catalog stays the baseline; DB rows augment it and override on
 * id collision. This service is the single server-side source for:
 *
 *   - `getMergedCatalog()` — every model the server knows about, as
 *     `ModelEntry`s (drives `/api/platform/visible-models`).
 *   - `getRoutingConfig(id)` — `{ provider, apiModel, baseUrl?, apiKey?,
 *     authStyle? }` for the AI proxy, decrypting a custom provider's key.
 *   - `getDbModelPricing(id)` — per-token USD list prices for billing.
 *
 * Caching: an in-memory snapshot with a short TTL plus explicit
 * `invalidateModelRegistry()` (called by the admin write routes). The AI
 * proxy reads the snapshot synchronously via the `*Sync` accessors and
 * triggers a non-blocking background refresh when stale, so a hot request
 * never awaits a DB round-trip.
 *
 * Plaintext provider keys exist only inside this module's cache (decrypted
 * on load). They are never logged and never returned by read APIs.
 */

import { prisma } from '../lib/prisma'
import { decryptSecret } from '../lib/secret-crypto'
import { setDbModelPricingProvider } from '../lib/db-model-pricing'
import * as modelCatalog from '@shogo/model-catalog'
import type {
  ModelEntry,
  BillingModel,
  ModelTier,
  ModelFamily,
  ModelGeneration,
} from '@shogo/model-catalog'

// Namespace import + fallback so a partial test mock of the (large) catalog
// module that omits `MODEL_CATALOG` degrades to an empty catalog (DB-only /
// identity resolution) instead of failing the ESM import link. In production
// the real export is always present.
const MODEL_CATALOG: Record<string, ModelEntry> =
  (modelCatalog as { MODEL_CATALOG?: Record<string, ModelEntry> }).MODEL_CATALOG ?? {}

const CACHE_TTL_MS = 30_000

export interface DbModelPricing {
  inputPerMillion: number
  cachedInputPerMillion: number
  cacheWritePerMillion: number
  outputPerMillion: number
}

/** Routing config consumed by the AI proxy's `resolveModel`. */
export interface ModelRoutingConfig {
  provider: string
  apiModel: string
  displayName: string
  /** Set for `provider === 'custom'`: the OpenAI-compatible base URL. */
  baseUrl?: string
  /** Set for `provider === 'custom'`: the decrypted upstream API key. */
  apiKey?: string
  /** Set for `provider === 'custom'`: how to attach the key. */
  authStyle?: 'bearer' | 'api-key-header'
}

interface ProviderRow {
  id: string
  label: string
  baseUrl: string
  protocol: string
  authStyle: string
  encryptedApiKey: string
  enabled: boolean
}

interface ModelRow {
  id: string
  provider: string
  providerId: string | null
  apiModel: string
  displayName: string
  shortDisplayName: string
  tier: string
  family: string
  generation: string
  maxOutputTokens: number
  enabled: boolean
  sortOrder: number | null
  aliases: unknown
  capabilities: unknown
  description: string | null
  contextWindow: number | null
  reasoningEffort: string | null
  inputPerMillion: number
  cachedInputPerMillion: number
  cacheWritePerMillion: number
  outputPerMillion: number
}

interface RegistrySnapshot {
  /** All models, static-overlaid-by-DB, keyed by id. */
  merged: Map<string, ModelEntry>
  /** Ids of models that came from the DB (`ModelDefinition`), as opposed to
   *  the static `MODEL_CATALOG`. Lets the visible-models picker reflect only
   *  the admin-managed set while the static catalog stays a routing fallback. */
  dbIds: Set<string>
  /** Routing config keyed by id (DB models only; static handled by proxy). */
  routing: Map<string, ModelRoutingConfig>
  /** Per-token pricing keyed by id (DB models only). */
  pricing: Map<string, DbModelPricing>
  /** alias id -> canonical id (DB models only). */
  aliasToId: Map<string, string>
  loadedAt: number
}

let snapshot: RegistrySnapshot = emptySnapshot()
let inflight: Promise<void> | null = null

function emptySnapshot(): RegistrySnapshot {
  // Seed the merged map with the static catalog so the snapshot is always
  // useful even before the first DB load completes.
  const merged = new Map<string, ModelEntry>()
  for (const entry of Object.values(MODEL_CATALOG)) {
    merged.set(entry.id, entry as ModelEntry)
  }
  return {
    merged,
    dbIds: new Set(),
    routing: new Map(),
    pricing: new Map(),
    aliasToId: new Map(),
    loadedAt: 0,
  }
}

function deriveBillingModel(family: string, tier: string): BillingModel {
  if (family === 'opus') return 'opus'
  if (family === 'sonnet') return 'sonnet'
  if (family === 'haiku') return 'haiku'
  // gpt / other: fall back by tier so the static-catalog type stays valid.
  if (tier === 'premium') return 'opus'
  if (tier === 'economy') return 'haiku'
  return 'sonnet'
}

function rowToModelEntry(row: ModelRow): ModelEntry {
  const capabilities =
    row.capabilities && typeof row.capabilities === 'object'
      ? (row.capabilities as ModelEntry['capabilities'])
      : undefined
  return {
    id: row.id,
    provider: row.provider as ModelEntry['provider'],
    apiModel: row.apiModel,
    displayName: row.displayName,
    shortDisplayName: row.shortDisplayName,
    tier: row.tier as ModelTier,
    family: row.family as ModelFamily,
    generation: row.generation as ModelGeneration,
    billingModel: deriveBillingModel(row.family, row.tier),
    maxOutputTokens: row.maxOutputTokens,
    ...(capabilities ? { capabilities } : {}),
    ...(typeof row.sortOrder === 'number' ? { sortOrder: row.sortOrder } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
    ...(row.reasoningEffort ? { reasoningEffort: row.reasoningEffort as ModelEntry['reasoningEffort'] } : {}),
  }
}

function aliasList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string')
  return []
}

/**
 * Load the DB rows and rebuild the snapshot. Resilient: any DB or decryption
 * failure falls back to the static-only snapshot rather than throwing, so a
 * broken DB never takes down model routing for the built-in catalog.
 */
async function refresh(): Promise<void> {
  try {
    const [models, providers] = await Promise.all([
      (prisma as any).modelDefinition.findMany({ where: { enabled: true } }) as Promise<ModelRow[]>,
      (prisma as any).modelProvider.findMany() as Promise<ProviderRow[]>,
    ])

    const providersById = new Map<string, ProviderRow>()
    for (const p of providers) providersById.set(p.id, p)

    const next = emptySnapshot()

    for (const row of models) {
      const entry = rowToModelEntry(row)
      next.merged.set(entry.id, entry) // DB overrides static on id collision
      next.dbIds.add(entry.id)

      next.pricing.set(row.id, {
        inputPerMillion: row.inputPerMillion,
        cachedInputPerMillion: row.cachedInputPerMillion,
        cacheWritePerMillion: row.cacheWritePerMillion,
        outputPerMillion: row.outputPerMillion,
      })

      const routing: ModelRoutingConfig = {
        provider: row.provider,
        apiModel: row.apiModel,
        displayName: row.displayName,
      }
      if (row.provider === 'custom' && row.providerId) {
        const provider = providersById.get(row.providerId)
        if (provider && provider.enabled) {
          routing.baseUrl = provider.baseUrl
          routing.authStyle = provider.authStyle === 'api-key-header' ? 'api-key-header' : 'bearer'
          try {
            routing.apiKey = decryptSecret(provider.encryptedApiKey)
          } catch (err) {
            // Misconfigured master key or corrupt blob — skip routing for
            // this model rather than leaking or crashing. It still appears
            // in the catalog/picker, but requests will 4xx upstream-side.
            console.error(`[model-registry] failed to decrypt key for provider ${provider.id}:`, (err as Error).message)
          }
        }
      }
      next.routing.set(row.id, routing)

      for (const alias of aliasList(row.aliases)) {
        next.aliasToId.set(alias, row.id)
      }
    }

    next.loadedAt = Date.now()
    snapshot = next
  } catch (err) {
    // Keep whatever snapshot we had; just stamp it so we don't hot-loop.
    snapshot = { ...snapshot, loadedAt: Date.now() }
    console.error('[model-registry] refresh failed, using static catalog only:', (err as Error).message)
  }
}

function isStale(): boolean {
  return Date.now() - snapshot.loadedAt > CACHE_TTL_MS
}

/** Kick a background refresh if the snapshot is stale. Non-blocking. */
function refreshIfStaleInBackground(): void {
  if (!isStale() || inflight) return
  inflight = refresh().finally(() => {
    inflight = null
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Await a fresh load. Call once at server startup to prime the cache. */
export async function primeModelRegistry(): Promise<void> {
  await refresh()
}

/** Drop the cache and reload. Call from admin write routes. */
export async function invalidateModelRegistry(): Promise<void> {
  await refresh()
}

/**
 * Synchronous accessor for the merged catalog (static overlaid by DB).
 * Triggers a background refresh if stale.
 */
export function getMergedCatalogSync(): ModelEntry[] {
  refreshIfStaleInBackground()
  return Array.from(snapshot.merged.values())
}

/**
 * Synchronous accessor for only the DB-defined (`ModelDefinition`) models —
 * i.e. the admin-managed set, excluding the static `MODEL_CATALOG` baseline.
 * Used by the visible-models picker so the admin can fully curate (and
 * remove) what users see. Returns enabled rows only, since `refresh()` loads
 * `enabled: true` definitions. Empty when nothing has been added/seeded yet,
 * in which case callers fall back to the static catalog.
 */
export function getDbModelEntriesSync(): ModelEntry[] {
  refreshIfStaleInBackground()
  const out: ModelEntry[] = []
  for (const id of snapshot.dbIds) {
    const entry = snapshot.merged.get(id)
    if (entry) out.push(entry)
  }
  return out
}

/** Synchronous merged-entry lookup, resolving DB aliases. */
export function getMergedModelEntrySync(id: string): ModelEntry | undefined {
  refreshIfStaleInBackground()
  const canonical = snapshot.aliasToId.get(id) ?? id
  return snapshot.merged.get(canonical)
}

const LABEL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Pick a human label off a merged/DB entry: short name → full name → api slug. */
function entryLabel(
  e: { shortDisplayName?: string | null; displayName?: string | null; apiModel?: string | null } | undefined,
): string | undefined {
  return e?.shortDisplayName || e?.displayName || e?.apiModel || undefined
}

/**
 * Synchronous best-effort label for a model id (canonical UUID, alias slug, or
 * static-catalog id): `shortDisplayName` → `displayName` → `apiModel` → raw id.
 * Reads the in-memory snapshot (background-refreshes when stale). For batch use
 * on freshness-critical surfaces (analytics) prefer the async `resolveModelLabels`.
 */
export function resolveModelLabelSync(id: string): string {
  if (!id) return id
  return entryLabel(getMergedModelEntrySync(id)) ?? id
}

/**
 * Batch-resolve model ids to human display labels. Awaits a registry refresh
 * when the snapshot is stale (so models added since the last load resolve),
 * then does one targeted `model_definitions` lookup for any UUID-shaped ids
 * still unresolved — e.g. admin-disabled rows excluded from the enabled-only
 * snapshot. Unknown ids map to themselves so callers can blindly use the map.
 */
export async function resolveModelLabels(ids: Iterable<string>): Promise<Map<string, string>> {
  const unique = [...new Set(
    [...ids].filter((id): id is string => typeof id === 'string' && id.length > 0),
  )]
  const out = new Map<string, string>()
  if (unique.length === 0) return out

  if (isStale()) await refresh()

  const stillUnresolved: string[] = []
  for (const id of unique) {
    const label = entryLabel(getMergedModelEntrySync(id))
    if (label) out.set(id, label)
    else if (LABEL_UUID_RE.test(id)) stillUnresolved.push(id)
    else out.set(id, id)
  }

  if (stillUnresolved.length > 0) {
    try {
      const rows = (await (prisma as any).modelDefinition.findMany({
        where: { id: { in: stillUnresolved } },
        select: { id: true, shortDisplayName: true, displayName: true, apiModel: true },
      })) as Array<{ id: string; shortDisplayName: string | null; displayName: string | null; apiModel: string | null }>
      for (const r of rows) out.set(r.id, entryLabel(r) ?? r.id)
    } catch {
      // Table absent on a schema variant / transient DB error — fall through to
      // the raw-id fallback below rather than failing the whole analytics call.
    }
  }

  for (const id of unique) {
    if (!out.has(id)) out.set(id, id)
  }
  return out
}

/** Convenience single-id async label resolver (awaits freshness). */
export async function resolveModelLabel(id: string): Promise<string> {
  if (!id) return id
  return (await resolveModelLabels([id])).get(id) ?? id
}

/**
 * Synchronous routing lookup for a DB-defined model (including custom
 * providers, with the key decrypted). Returns undefined for ids not defined
 * in the DB — the proxy falls back to its static registry for those.
 */
export function getDbRoutingConfigSync(id: string): ModelRoutingConfig | undefined {
  refreshIfStaleInBackground()
  const canonical = snapshot.aliasToId.get(id) ?? id
  return snapshot.routing.get(canonical)
}

/** Synchronous per-token pricing lookup for a DB-defined model. */
export function getDbModelPricingSync(id: string): DbModelPricing | undefined {
  refreshIfStaleInBackground()
  const canonical = snapshot.aliasToId.get(id) ?? id
  return snapshot.pricing.get(canonical)
}

// Register with the billing-side pricing hook so usage-cost / cost-analytics
// can read DB pricing without importing this module (and the full catalog)
// directly. See apps/api/src/lib/db-model-pricing.ts.
setDbModelPricingProvider(getDbModelPricingSync)

/** Async merged catalog (awaits a refresh when stale). For non-hot paths. */
export async function getMergedCatalog(): Promise<ModelEntry[]> {
  if (isStale()) await refresh()
  return Array.from(snapshot.merged.values())
}
