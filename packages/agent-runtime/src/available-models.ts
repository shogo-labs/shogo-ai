// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The chat models this workspace can use, as the API reports them.
 *
 * The only model id the runtime pins itself is `auto`. Anything the agent
 * reads about concrete models (tool descriptions, the SDK guide, validation of
 * a model argument) comes from here, which is fed by the same
 * `GET ${AI_PROXY_URL}/models` endpoint the chat picker uses. That endpoint
 * already applies the platform allowlist and the workspace narrowing.
 *
 * Until the first successful fetch the list is "not loaded". In that state we
 * cannot validate a concrete id, so `isAvailableModel` accepts it, and prompts
 * only offer `auto`.
 */

import { AUTO_MODEL_ID, buildAutoTierMap, type ModelTierMap } from './model-router'
import { isAutoModel } from '@shogo/model-catalog'

export interface AvailableModel {
  id: string
  displayName: string
  provider: string
}

const CACHE_TTL_MS = 5 * 60_000
const FETCH_TIMEOUT_MS = 3_000
/** Keep prompt text bounded even if the workspace exposes many models. */
const MAX_LISTED_IN_PROMPT = 12

let models: AvailableModel[] | null = null
let fetchedAt = 0
let inflight: Promise<void> | null = null

export function isAvailableModelListLoaded(): boolean {
  return models !== null
}

export function getAvailableModels(): AvailableModel[] {
  return models ?? []
}

/** `auto` is always valid. A concrete id must be in the API list once it has loaded. */
export function isAvailableModel(id: string): boolean {
  const trimmed = id.trim()
  if (isAutoModel(trimmed)) return true
  if (models === null) return true
  return models.some((m) => m.id === trimmed)
}

/** Short text for tool descriptions, built from the currently cached list. */
export function availableModelsHint(): string {
  if (models === null || models.length === 0) {
    return 'Use "auto" (recommended). Call list_models for the other model ids.'
  }
  const ids = models
    .slice(0, MAX_LISTED_IN_PROMPT)
    .map((m) => (m.displayName && m.displayName !== m.id ? `"${m.id}" (${m.displayName})` : `"${m.id}"`))
    .join(', ')
  const more = models.length > MAX_LISTED_IN_PROMPT ? '; call list_models for the full list' : ''
  return `Use "auto" (recommended). Other available model ids: ${ids}${more}.`
}

/**
 * Fetch the workspace's chat models. Keeps the previous list if the request
 * fails, and is a no-op when the proxy is not configured (local dev without
 * a proxy) or the cache is still fresh.
 */
export async function refreshAvailableModels(opts: { force?: boolean } = {}): Promise<void> {
  const proxyUrl = process.env.AI_PROXY_URL?.replace(/\/$/, '')
  const token = process.env.AI_PROXY_TOKEN
  if (!proxyUrl || !token) return
  if (!opts.force && models !== null && Date.now() - fetchedAt < CACHE_TTL_MS) return
  if (inflight) return inflight

  inflight = (async () => {
    try {
      const res = await fetch(`${proxyUrl}/models`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { data?: unknown }
      const entries = Array.isArray(body.data) ? body.data : []
      models = entries
        .filter((e: any) => e && typeof e.id === 'string' && e.kind !== 'live' && e.available !== false)
        .map((e: any) => ({
          id: e.id as string,
          displayName: typeof e.display_name === 'string' ? e.display_name : e.id,
          provider: typeof e.owned_by === 'string' ? e.owned_by : '',
        }))
      fetchedAt = Date.now()
    } catch (err: any) {
      console.warn(`[available-models] refresh failed; keeping previous list: ${err?.message ?? err}`)
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/**
 * The concrete model behind an Auto tier, for code paths that cannot route
 * `auto` themselves (the teammate loop, for example). Reads the admin tier map
 * the API injects as `AGENT_AUTO_TIER_MAP`, then falls back to the package
 * defaults, the same map `auto` routes through.
 */
export function resolveAutoTierModelId(tier: keyof ModelTierMap): string {
  const raw = process.env.AGENT_AUTO_TIER_MAP
  if (raw) {
    try {
      const id = JSON.parse(raw)?.[tier]?.id
      if (typeof id === 'string' && id.trim()) return id.trim()
    } catch {
      // Malformed override: fall through to the package defaults.
    }
  }
  return buildAutoTierMap()[tier]
}

export { AUTO_MODEL_ID }

/** Test helper: forget the cached list. */
export function __resetAvailableModelsForTests(): void {
  models = null
  fetchedAt = 0
  inflight = null
}
