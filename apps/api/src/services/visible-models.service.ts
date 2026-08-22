// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Visible-models resolution — the single source of truth for "which models
 * can this caller see/use right now". Shared by:
 *
 *   - `GET /api/admin/settings/visible-models` (admin read/write of the
 *     allowlist config)
 *   - `GET /api/platform/visible-models` (chat picker, platform-wide)
 *   - `GET /api/workspaces/:id/visible-models` (chat picker, workspace-scoped)
 *   - `GET /ai/v1/models` (the LLM gateway's OpenAI-compatible model list —
 *     see `routes/ai-proxy.ts`)
 *
 * Extracted from `server.ts` so the AI proxy routes (which `server.ts`
 * imports) can consume this resolution without a circular import.
 *
 * Resolution pipeline: admin-managed DB `ModelDefinition` rows (or the
 * static `MODEL_CATALOG` as a first-run fallback when the DB is empty),
 * gated by whether the provider has a usable API key, plus admin-curated
 * OpenRouter extras stored under the `PlatformSetting` key `models.visible`.
 * See `resolvePlatformVisibleModels` for the full algorithm.
 */

import { prisma } from '../lib/prisma'
import { fetchCloudVisibleModels } from '../lib/federated-upstream'
import { NATIVE_PROVIDER_ENV_KEY, getNativeProviderApiKeySync } from './provider-credentials.service'
import * as workspaceModelsService from './workspace-models.service'

const VISIBLE_MODELS_KEY = 'models.visible'

export interface VisibleOpenRouterModelStored {
  id: string
  displayName: string
  contextLength?: number
  tier?: 'economy' | 'standard' | 'premium'
  /**
   * Per-token rates in USD captured from OpenRouter's `/api/v1/models`
   * at the time the admin added the model. Stored alongside the entry
   * so:
   *   - the admin UI can show real $/M-token figures next to each model,
   *   - the eval cost calculator can report real (not Sonnet-fallback)
   *     dollar costs without hitting OpenRouter at every run,
   *   - usage analytics can compute spend without re-fetching upstream.
   *
   * Fields are optional individually because OpenRouter doesn't return
   * cache pricing for every model. Missing → 0 in cost calc.
   */
  pricing?: {
    promptPerToken?: number
    completionPerToken?: number
    cacheReadPerToken?: number
    cacheWritePerToken?: number
  }
}

export interface VisibleModelsConfigStored {
  catalogIds: string[] | null
  openrouterModels: VisibleOpenRouterModelStored[]
}

/** A resolved, picker-ready catalog entry (static `MODEL_CATALOG` overlaid
 *  with enabled DB-defined models). */
export interface VisibleCatalogModel {
  id: string
  provider: string
  displayName: string
  shortDisplayName: string
  tier: string
  family: string
  maxOutputTokens: number
  sortOrder?: number
  description?: string
  contextWindow?: number
  reasoningEffort?: string
}

/** The full platform-visible model payload: the catalog allowlist resolved
 *  to picker-ready entries, plus the admin-curated OpenRouter extras. */
export interface VisibleModelsPayload {
  catalogIds: string[] | null
  openrouterModels: VisibleOpenRouterModelStored[]
  catalogModels: VisibleCatalogModel[]
}

/** Just the two model sets, without the raw `catalogIds` allowlist — what a
 *  workspace-scoped caller (chat picker, gateway) actually needs. */
export interface ResolvedVisibleModelSets {
  catalogModels: VisibleCatalogModel[]
  openrouterModels: VisibleOpenRouterModelStored[]
}

const DEFAULT_VISIBLE_MODELS: VisibleModelsConfigStored = {
  catalogIds: null,
  openrouterModels: [],
}

function sanitizeOpenRouterPricing(raw: any): VisibleOpenRouterModelStored['pricing'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: NonNullable<VisibleOpenRouterModelStored['pricing']> = {}
  for (const key of ['promptPerToken', 'completionPerToken', 'cacheReadPerToken', 'cacheWritePerToken'] as const) {
    const v = raw[key]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizeOpenRouterEntry(m: any): VisibleOpenRouterModelStored | null {
  if (!m || typeof m.id !== 'string' || typeof m.displayName !== 'string') return null
  return {
    id: m.id,
    displayName: m.displayName,
    contextLength: typeof m.contextLength === 'number' ? m.contextLength : undefined,
    tier: m.tier === 'economy' || m.tier === 'standard' || m.tier === 'premium' ? m.tier : undefined,
    pricing: sanitizeOpenRouterPricing(m.pricing),
  }
}

function parseVisibleModelsValue(raw: string | null | undefined): VisibleModelsConfigStored {
  if (!raw) return { ...DEFAULT_VISIBLE_MODELS }
  try {
    const parsed = JSON.parse(raw)
    const catalogIds = Array.isArray(parsed?.catalogIds)
      ? parsed.catalogIds.filter((x: unknown): x is string => typeof x === 'string')
      : parsed?.catalogIds === null ? null : null
    const openrouterModels = Array.isArray(parsed?.openrouterModels)
      ? parsed.openrouterModels
          .map(sanitizeOpenRouterEntry)
          .filter((m: VisibleOpenRouterModelStored | null): m is VisibleOpenRouterModelStored => m !== null)
      : []
    return { catalogIds, openrouterModels }
  } catch {
    return { ...DEFAULT_VISIBLE_MODELS }
  }
}

/** Read the admin-configured allowlist as stored (`models.visible`). */
export async function readVisibleModelsConfig(): Promise<VisibleModelsConfigStored> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: VISIBLE_MODELS_KEY } })
    return parseVisibleModelsValue(row?.value)
  } catch {
    return { ...DEFAULT_VISIBLE_MODELS }
  }
}

/** Sanitize + persist a new allowlist config (admin write). */
export async function writeVisibleModelsConfig(
  body: any,
  userId: string,
): Promise<VisibleModelsConfigStored> {
  const next: VisibleModelsConfigStored = {
    catalogIds: Array.isArray(body?.catalogIds)
      ? body.catalogIds.filter((x: unknown): x is string => typeof x === 'string')
      : null,
    openrouterModels: Array.isArray(body?.openrouterModels)
      ? body.openrouterModels
          .map(sanitizeOpenRouterEntry)
          .filter((m: VisibleOpenRouterModelStored | null): m is VisibleOpenRouterModelStored => m !== null)
      : [],
  }

  await prisma.platformSetting.upsert({
    where: { key: VISIBLE_MODELS_KEY },
    create: { key: VISIBLE_MODELS_KEY, value: JSON.stringify(next), updatedBy: userId },
    update: { value: JSON.stringify(next), updatedBy: userId },
  })

  return next
}

/** A model is presentable only when its provider has a usable key. `custom`
 *  models carry their own encrypted key (and are only merged when enabled), so
 *  they're always considered configured. Unknown/legacy providers aren't gated
 *  to avoid hiding models we don't have an env mapping for. */
export function isModelProviderConfigured(provider: string): boolean {
  if (provider === 'custom' || provider === 'local') return true
  if (!NATIVE_PROVIDER_ENV_KEY[provider]) return true
  // Respect admin-stored (encrypted DB) keys as well as env vars.
  return !!getNativeProviderApiKeySync(provider)
}

// Stable sort by sortOrder (ascending); models without one sink to the
// bottom, preserving their catalog order. This is what gives the user
// picker its admin-controlled order.
function bySortOrder<T extends { sortOrder?: number }>(rows: T[]): T[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const ao = a.row.sortOrder ?? Number.POSITIVE_INFINITY
      const bo = b.row.sortOrder ?? Number.POSITIVE_INFINITY
      return ao === bo ? a.i - b.i : ao - bo
    })
    .map((x) => x.row)
}

/** Resolve an allowlist into full picker-ready catalog entries against the
 *  MERGED catalog (static `MODEL_CATALOG` overlaid with enabled DB-defined
 *  models). `null` ids means "all current-generation models". Shipping these
 *  over the wire lets a cloud-connected desktop render models its bundled
 *  catalog may not know about — including purely-DB-defined ones (e.g. MiMo).
 *
 *  The `family` and `maxOutputTokens` fields are included so clients can
 *  label/color and gate a model they don't carry in their bundled catalog. */
export async function resolveVisibleCatalogModels(
  catalogIds: string[] | null,
): Promise<VisibleCatalogModel[]> {
  const { getMergedCatalogSync, getMergedModelEntrySync, getDbModelEntriesSync } = await import('./model-registry.service')
  const toVisible = (entry: any): VisibleCatalogModel => ({
    id: entry.id,
    provider: entry.provider,
    displayName: entry.displayName,
    shortDisplayName: entry.shortDisplayName,
    tier: entry.tier,
    family: entry.family,
    maxOutputTokens: entry.maxOutputTokens,
    ...(typeof entry.sortOrder === 'number' ? { sortOrder: entry.sortOrder } : {}),
    ...(entry.description ? { description: entry.description } : {}),
    ...(typeof entry.contextWindow === 'number' ? { contextWindow: entry.contextWindow } : {}),
    ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
  })
  if (catalogIds === null) {
    // DB-managed picker: when any models are defined in the DB, the picker
    // reflects exactly those (the admin-curated/seeded set) so super admins
    // can fully control — and remove — what users see. The static
    // MODEL_CATALOG is a routing-only fallback, used here ONLY when the DB
    // has no models yet, so a fresh/unseeded instance is never empty.
    const dbEntries = getDbModelEntriesSync()
    const usingStaticFallback = dbEntries.length === 0
    const source = usingStaticFallback ? getMergedCatalogSync() : dbEntries
    return bySortOrder(
      source
        .filter((e) => e.generation === 'current')
        // Provider-key gating is meaningful for admin-managed rows: if the
        // admin has configured models but removed the backing provider key,
        // those models should disappear from the picker. The static catalog is
        // only a first-run fallback for an unseeded DB; gating it would make a
        // fresh dev instance empty before the admin has had a chance to add
        // keys or DB rows.
        .filter((e) => usingStaticFallback || isModelProviderConfigured(e.provider))
        .map(toVisible),
    )
  }
  const out: VisibleCatalogModel[] = []
  for (const id of catalogIds) {
    const entry = getMergedModelEntrySync(id)
    if (entry && isModelProviderConfigured(entry.provider)) out.push(toVisible(entry))
  }
  return bySortOrder(out)
}

/** Build the full platform-visible model payload: the catalog allowlist
 *  resolved to picker-ready entries plus the admin-curated OpenRouter extras.
 *  Shared by `GET /api/platform/visible-models` and the per-workspace endpoint
 *  (which intersects this with the workspace's own allowlist). Local-only —
 *  does not consult a connected cloud (see `resolvePlatformVisibleModelsForRequest`
 *  for the cloud-aware variant). */
export async function resolvePlatformVisibleModels(): Promise<VisibleModelsPayload> {
  const config = await readVisibleModelsConfig()
  const catalogModels = await resolveVisibleCatalogModels(config.catalogIds)
  return { catalogIds: config.catalogIds, openrouterModels: config.openrouterModels, catalogModels }
}

/** Cloud-aware platform resolution: prefer a connected cloud's resolved
 *  catalog (a desktop forwarding AI traffic upstream reflects what the cloud
 *  super-admin curated under "Available Models") and fall back to the local
 *  DB-backed resolution otherwise. Mirrors the fallback in
 *  `GET /api/platform/visible-models`. */
export async function resolvePlatformVisibleModelsForRequest(): Promise<VisibleModelsPayload> {
  try {
    const fromCloud = await fetchCloudVisibleModels()
    if (fromCloud) {
      return {
        catalogIds: fromCloud.catalogIds,
        openrouterModels: (fromCloud.openrouterModels ?? []) as VisibleOpenRouterModelStored[],
        catalogModels: (fromCloud.catalogModels ?? []) as VisibleCatalogModel[],
      }
    }
  } catch {
    // unreachable cloud / parse error — fall through to local resolution
  }
  return resolvePlatformVisibleModels()
}

/**
 * The resolved model set for a workspace: the platform-visible set (cloud-
 * aware) narrowed by the workspace's own allowlist (`null` allowlist means
 * "inherit everything platform-visible"). This is what a workspace-scoped
 * caller — the chat picker or the `GET /ai/v1/models` gateway listing —
 * should actually see and be able to use.
 */
export async function resolveVisibleModelsForWorkspace(
  workspaceId: string,
): Promise<ResolvedVisibleModelSets> {
  const platform = await resolvePlatformVisibleModelsForRequest()
  const allowed = await workspaceModelsService.getAllowedModelIds(workspaceId)
  if (allowed === null) {
    return { catalogModels: platform.catalogModels, openrouterModels: platform.openrouterModels }
  }
  return workspaceModelsService.filterToAllowlist(platform, allowed)
}
