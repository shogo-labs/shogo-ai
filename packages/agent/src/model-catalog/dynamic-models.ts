// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runtime registry for models defined outside the static catalog (admin
 * `model_definitions` rows addressed by opaque ids such as UUIDs). The API
 * server owns those rows; it hands the runtime a snapshot at spawn
 * (`AGENT_MODEL_REGISTRY`) and per-chat provider hints, and every routing
 * path consults this registry before falling back to heuristics.
 *
 * State lives on `globalThis` so bundles that load this module more than
 * once (sdk shim, agent package, runtime) still share one registry.
 */

export interface DynamicModelEntry {
  id: string
  provider: string
  /** Upstream provider model name, e.g. `claude-opus-5-5`. */
  apiModel?: string
  contextWindow?: number
  maxOutputTokens?: number
}

const REGISTRY_KEY = Symbol.for('shogo.model-catalog.dynamic-models')

function registry(): Map<string, DynamicModelEntry> {
  const g = globalThis as unknown as Record<symbol, Map<string, DynamicModelEntry> | undefined>
  let map = g[REGISTRY_KEY]
  if (!map) {
    map = new Map()
    g[REGISTRY_KEY] = map
  }
  return map
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Add or update entries. Fields missing from a new entry keep their prior value. */
export function registerDynamicModels(entries: ReadonlyArray<Partial<DynamicModelEntry>>): void {
  const map = registry()
  for (const raw of entries) {
    const id = str(raw?.id)
    const provider = str(raw?.provider)
    if (!id || !provider) continue
    const prev = map.get(id)
    map.set(id, {
      id,
      provider,
      apiModel: str(raw.apiModel) ?? prev?.apiModel,
      contextWindow: positiveInt(raw.contextWindow) ?? prev?.contextWindow,
      maxOutputTokens: positiveInt(raw.maxOutputTokens) ?? prev?.maxOutputTokens,
    })
  }
}

/** Record a provider hint (e.g. the API's per-chat `modelProvider` stamp). */
export function rememberProviderHint(id: string | undefined, provider: string | undefined): void {
  if (!id || !provider) return
  registerDynamicModels([{ id, provider }])
}

export function getDynamicModel(id: string): DynamicModelEntry | undefined {
  return id ? registry().get(id) : undefined
}

/**
 * True when the entry is served by Anthropic upstream, either declared
 * directly or implied by a `claude-*` upstream model name.
 */
export function isAnthropicBacked(entry: DynamicModelEntry | undefined): boolean {
  if (!entry) return false
  return entry.provider === 'anthropic' || (entry.apiModel?.startsWith('claude') ?? false)
}

/**
 * Parse the compact `AGENT_MODEL_REGISTRY` env payload: an array of
 * `{ id, provider, apiModel?, contextWindow?, maxOutputTokens? }`.
 * Malformed input yields an empty list.
 */
export function parseDynamicModelsEnv(raw: string | undefined): DynamicModelEntry[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: DynamicModelEntry[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    const id = str(e.id)
    const provider = str(e.provider)
    if (!id || !provider) continue
    out.push({
      id,
      provider,
      apiModel: str(e.apiModel),
      contextWindow: positiveInt(e.contextWindow),
      maxOutputTokens: positiveInt(e.maxOutputTokens),
    })
  }
  return out
}

/** Test helper: drop every registered entry. */
export function clearDynamicModels(): void {
  registry().clear()
}
