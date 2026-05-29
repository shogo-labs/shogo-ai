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
import {
  MODEL_CATALOG,
  type ModelEntry,
  type BillingModel,
  type ModelTier,
  type ModelFamily,
  type ModelGeneration,
} from '@shogo/model-catalog'

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
  inputPerMillion: number
  cachedInputPerMillion: number
  cacheWritePerMillion: number
  outputPerMillion: number
}

interface RegistrySnapshot {
  /** All models, static-overlaid-by-DB, keyed by id. */
  merged: Map<string, ModelEntry>
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

/** Synchronous merged-entry lookup, resolving DB aliases. */
export function getMergedModelEntrySync(id: string): ModelEntry | undefined {
  refreshIfStaleInBackground()
  const canonical = snapshot.aliasToId.get(id) ?? id
  return snapshot.merged.get(canonical)
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
