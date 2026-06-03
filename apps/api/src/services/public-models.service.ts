// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Public model alias registry.
 *
 * The public `/v1/*` API exposes a small, curated set of Shogo-branded model
 * ids (e.g. `hoshi-1.0`) to external developers. Each public id is an alias
 * that maps to an internal "backing" model id resolvable by the AI proxy's
 * `resolveModel` (any static-catalog or DB-defined model). The public surface
 * translates the public id to its backing id before routing, and masks the
 * underlying provider/model on the way back out so the upstream identity is
 * never disclosed.
 *
 * The alias map is super-admin managed and stored as JSON in the generic
 * `PlatformSetting` key/value table under `PUBLIC_MODELS_SETTING_KEY` — no
 * dedicated schema/migration. Storage shape:
 *
 *   [{ publicId, displayName, backingModelId, enabled }]
 *
 * Caching mirrors `provider-credentials.service` / `model-registry.service`:
 * an in-memory snapshot with a short TTL plus an explicit
 * `invalidatePublicModels()` that the admin write route calls so changes take
 * effect immediately. The `*Sync` accessors never await a DB round-trip on a
 * hot request — they read the snapshot and trigger a background refresh when
 * stale.
 */

import { prisma } from '../lib/prisma'

/** PlatformSetting key holding the JSON-encoded public model alias map. */
export const PUBLIC_MODELS_SETTING_KEY = 'public-models'

const CACHE_TTL_MS = 30_000

/** A single public model alias entry as stored and served. */
export interface PublicModel {
  /** External-facing model id (e.g. `hoshi-1.0`). */
  publicId: string
  /** Human-readable name shown in `/v1/models`. */
  displayName: string
  /** Internal model id passed to the AI proxy's `resolveModel`. */
  backingModelId: string
  /** When false, the alias is hidden from `/v1/models` and rejected. */
  enabled: boolean
}

interface Snapshot {
  models: PublicModel[]
  loadedAt: number
}

let snapshot: Snapshot = { models: [], loadedAt: 0 }
let inflight: Promise<void> | null = null

/**
 * Coerce a raw stored entry into a `PublicModel`, dropping anything that lacks
 * the two required string fields. `enabled` defaults to true (an entry written
 * without the flag is treated as live). Returns null for invalid rows.
 */
function coerceEntry(raw: unknown): PublicModel | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const publicId = typeof r.publicId === 'string' ? r.publicId.trim() : ''
  const backingModelId =
    typeof r.backingModelId === 'string' ? r.backingModelId.trim() : ''
  if (!publicId || !backingModelId) return null
  const displayName =
    typeof r.displayName === 'string' && r.displayName.trim()
      ? r.displayName.trim()
      : publicId
  const enabled = r.enabled === undefined ? true : r.enabled !== false
  return { publicId, displayName, backingModelId, enabled }
}

/** Parse the stored JSON blob into a validated, de-duplicated list. */
export function parsePublicModels(value: string | null | undefined): PublicModel[] {
  if (!value) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: PublicModel[] = []
  const seen = new Set<string>()
  for (const raw of parsed) {
    const entry = coerceEntry(raw)
    if (!entry) continue
    // Last write wins on duplicate publicId, but keep first to be stable.
    if (seen.has(entry.publicId)) continue
    seen.add(entry.publicId)
    out.push(entry)
  }
  return out
}

/**
 * Reload the alias map from the DB and rebuild the snapshot. Resilient: any DB
 * or parse failure leaves the public surface with an empty map rather than
 * throwing (fail closed — unknown models are simply rejected).
 */
async function refresh(): Promise<void> {
  try {
    const row = (await prisma.platformSetting.findUnique({
      where: { key: PUBLIC_MODELS_SETTING_KEY },
    })) as { value: string } | null
    snapshot = { models: parsePublicModels(row?.value), loadedAt: Date.now() }
  } catch (err) {
    snapshot = { ...snapshot, loadedAt: Date.now() }
    console.error('[public-models] refresh failed, using last snapshot:', (err as Error).message)
  }
}

function isStale(): boolean {
  return Date.now() - snapshot.loadedAt > CACHE_TTL_MS
}

function refreshIfStaleInBackground(): void {
  if (!isStale() || inflight) return
  inflight = refresh().finally(() => {
    inflight = null
  })
}

/** Await a fresh load. Call once at server startup to prime the cache. */
export async function primePublicModels(): Promise<void> {
  await refresh()
}

/** Drop the cache and reload. Call from the admin write route. */
export async function invalidatePublicModels(): Promise<void> {
  await refresh()
}

/** All enabled public models (snapshot read; background refresh when stale). */
export function getPublicModelsSync(): PublicModel[] {
  refreshIfStaleInBackground()
  return snapshot.models.filter((m) => m.enabled)
}

/**
 * Resolve an external public model id to its alias entry. Returns null when the
 * id is unknown or the alias is disabled, so callers can 404 uniformly.
 */
export function resolvePublicModelSync(publicId: string): PublicModel | null {
  refreshIfStaleInBackground()
  const match = snapshot.models.find((m) => m.publicId === publicId)
  if (!match || !match.enabled) return null
  return match
}
