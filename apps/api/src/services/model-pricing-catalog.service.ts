// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Model pricing catalog (LiteLLM-sourced).
 *
 * Neither OpenAI nor Anthropic expose a per-token *price* API — only their
 * docs pages and consumption/cost-reporting endpoints. The ecosystem's
 * de-facto machine-readable rate card is LiteLLM's
 * `model_prices_and_context_window.json`, a single JSON keyed by model id with
 * input/output/cache per-token costs and context window. We fetch it, cache it
 * (24h TTL), and use it to:
 *
 *   1. auto-fill pricing + context window when an admin enables a discovered
 *      provider model (see admin-model-catalog enable route), and
 *   2. bulk-refresh pricing on existing `model_definitions` rows, triggered
 *      manually or once per day when a super admin opens the AI page.
 *
 * Per-token costs are converted to the per-million figures the rest of the
 * billing stack uses. When LiteLLM has no entry for a model we fall back to the
 * shipped per-family list-price buckets (`MODEL_DOLLAR_COSTS`) so a model is
 * never billed at $0.
 *
 * The last-refresh timestamp is persisted in `PlatformSetting` so the 24h
 * staleness gate is shared across instances; the parsed table itself lives only
 * in this module's in-memory cache.
 */

import { prisma } from '../lib/prisma'
import { MODEL_DOLLAR_COSTS, getModelBillingModel } from '@shogo/model-catalog'

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h
const REFRESHED_AT_KEY = 'pricing.litellm.refreshed_at'

export interface ResolvedPricing {
  inputPerMillion: number
  cachedInputPerMillion: number
  cacheWritePerMillion: number
  outputPerMillion: number
  contextWindow?: number
  source: 'litellm' | 'bucket'
}

interface LiteLLMEntry {
  inputPerMillion: number
  cachedInputPerMillion: number
  cacheWritePerMillion: number
  outputPerMillion: number
  contextWindow?: number
}

interface RawLiteLLMSpec {
  litellm_provider?: string
  mode?: string
  max_input_tokens?: number
  max_tokens?: number
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
  cache_creation_input_token_cost?: number
}

interface Snapshot {
  /** alias forms (raw id, provider-stripped, date-stripped) -> normalized entry. */
  byAlias: Map<string, LiteLLMEntry>
  fetchedAt: number
}

let snapshot: Snapshot = { byAlias: new Map(), fetchedAt: 0 }
let inflight: Promise<void> | null = null

function perMillion(perToken: unknown): number {
  const n = typeof perToken === 'number' ? perToken : Number(perToken)
  return Number.isFinite(n) && n > 0 ? n * 1_000_000 : 0
}

/** Strip a trailing `-YYYYMMDD` (or `-YYYY-MM-DD`) date suffix from a model id. */
function stripDate(id: string): string {
  return id.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '')
}

/** Aliases under which an id should be indexed/looked up. */
function aliasForms(id: string): string[] {
  const forms = new Set<string>()
  const raw = id.trim()
  if (!raw) return []
  forms.add(raw)
  const stripped = raw.includes('/') ? raw.slice(raw.indexOf('/') + 1) : raw
  forms.add(stripped)
  forms.add(stripDate(raw))
  forms.add(stripDate(stripped))
  return Array.from(forms).filter(Boolean)
}

function buildSnapshot(raw: Record<string, RawLiteLLMSpec>): Snapshot {
  const byAlias = new Map<string, LiteLLMEntry>()
  for (const [key, spec] of Object.entries(raw)) {
    if (key === 'sample_spec' || !spec || typeof spec !== 'object') continue
    if (typeof spec.input_cost_per_token !== 'number' && typeof spec.output_cost_per_token !== 'number') continue
    const entry: LiteLLMEntry = {
      inputPerMillion: perMillion(spec.input_cost_per_token),
      cachedInputPerMillion: perMillion(spec.cache_read_input_token_cost),
      cacheWritePerMillion: perMillion(spec.cache_creation_input_token_cost),
      outputPerMillion: perMillion(spec.output_cost_per_token),
      contextWindow:
        Number.isFinite(spec.max_input_tokens) && (spec.max_input_tokens as number) > 0
          ? (spec.max_input_tokens as number)
          : Number.isFinite(spec.max_tokens) && (spec.max_tokens as number) > 0
            ? (spec.max_tokens as number)
            : undefined,
    }
    // First write wins so the canonical (often un-dated) key isn't shadowed by
    // a later dated variant for the same alias.
    for (const alias of aliasForms(key)) {
      if (!byAlias.has(alias)) byAlias.set(alias, entry)
    }
  }
  return { byAlias, fetchedAt: Date.now() }
}

async function fetchSnapshot(): Promise<void> {
  const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`LiteLLM pricing fetch returned ${res.status}`)
  const raw = (await res.json()) as Record<string, RawLiteLLMSpec>
  snapshot = buildSnapshot(raw)
}

function isCacheStale(): boolean {
  return Date.now() - snapshot.fetchedAt > CACHE_TTL_MS
}

/** Ensure the in-memory table is loaded (lazy). Force re-fetch on demand. */
async function ensureSnapshot(force = false): Promise<void> {
  if (!force && snapshot.byAlias.size > 0 && !isCacheStale()) return
  if (inflight) return inflight
  inflight = fetchSnapshot().finally(() => {
    inflight = null
  })
  await inflight
}

/** Per-family list-price fallback so a model is never billed at $0. */
function bucketPricing(id: string): ResolvedPricing {
  const billing = getModelBillingModel(id)
  const costs = (MODEL_DOLLAR_COSTS as any)[billing] ?? MODEL_DOLLAR_COSTS.sonnet
  return {
    inputPerMillion: costs.inputPerMillion,
    cachedInputPerMillion: costs.cachedInputPerMillion,
    cacheWritePerMillion: costs.cacheWritePerMillion,
    outputPerMillion: costs.outputPerMillion,
    source: 'bucket',
  }
}

/** Look up a LiteLLM entry for one or more candidate ids (id, apiModel). */
function lookupLiteLLM(...ids: Array<string | null | undefined>): LiteLLMEntry | undefined {
  for (const id of ids) {
    if (!id) continue
    for (const alias of aliasForms(id)) {
      const hit = snapshot.byAlias.get(alias)
      if (hit) return hit
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve pricing for a model to persist at enable time. Loads the LiteLLM
 * table if needed, falling back to the per-family bucket. Never throws — a
 * fetch failure just yields the bucket fallback.
 */
export async function resolveEnablePricing(id: string, apiModel?: string): Promise<ResolvedPricing> {
  try {
    await ensureSnapshot()
  } catch {
    return bucketPricing(id)
  }
  const hit = lookupLiteLLM(id, apiModel)
  if (!hit) return bucketPricing(id)
  return { ...hit, source: 'litellm' }
}

export interface PricingRefreshResult {
  ok: boolean
  refreshedAt: string | null
  updated: number
  total: number
  skipped?: boolean
  error?: string
}

/** ISO timestamp of the last successful refresh, or null. */
export async function getPricingRefreshedAt(): Promise<string | null> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: REFRESHED_AT_KEY } })
    return row?.value || null
  } catch {
    return null
  }
}

/** True when no refresh has happened or the last one is older than the TTL. */
export async function isPricingStale(): Promise<boolean> {
  const at = await getPricingRefreshedAt()
  if (!at) return true
  const ts = Date.parse(at)
  if (!Number.isFinite(ts)) return true
  return Date.now() - ts > CACHE_TTL_MS
}

/**
 * Fetch the latest LiteLLM table and update pricing + context window on every
 * `model_definition` row that matches. Rows without a LiteLLM match are left
 * untouched (so admin-set / custom prices aren't clobbered with guesses).
 * Returns counts and the new refreshedAt. Does not invalidate the registry —
 * the caller should after a successful refresh.
 */
export async function refreshModelPricingFromLiteLLM(userId: string): Promise<PricingRefreshResult> {
  try {
    await ensureSnapshot(true)
  } catch (err: any) {
    return { ok: false, refreshedAt: await getPricingRefreshedAt(), updated: 0, total: 0, error: err?.message || 'fetch failed' }
  }

  const rows = (await (prisma as any).modelDefinition.findMany()) as Array<{
    id: string
    apiModel: string
    contextWindow: number | null
  }>

  let updated = 0
  for (const row of rows) {
    const hit = lookupLiteLLM(row.id, row.apiModel)
    if (!hit) continue
    await (prisma as any).modelDefinition.update({
      where: { id: row.id },
      data: {
        inputPerMillion: hit.inputPerMillion,
        cachedInputPerMillion: hit.cachedInputPerMillion,
        cacheWritePerMillion: hit.cacheWritePerMillion,
        outputPerMillion: hit.outputPerMillion,
        ...(hit.contextWindow ? { contextWindow: hit.contextWindow } : {}),
        updatedBy: userId,
      },
    })
    updated++
  }

  const refreshedAt = new Date().toISOString()
  await prisma.platformSetting.upsert({
    where: { key: REFRESHED_AT_KEY },
    create: { key: REFRESHED_AT_KEY, value: refreshedAt, updatedBy: userId },
    update: { value: refreshedAt, updatedBy: userId },
  })

  return { ok: true, refreshedAt, updated, total: rows.length }
}
