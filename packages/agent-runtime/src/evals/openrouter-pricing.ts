// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * OpenRouter pricing fetch + cache for the eval cost calculator.
 *
 * Why this exists:
 *   Without it, evals run against `openrouter:*` models had their cost
 *   computed via the catalog's Sonnet-rate fallback, producing wildly
 *   inflated dollar figures in `results.json` (e.g. MiMo-v2.5 agentic
 *   reported as $40 when the real OpenRouter charge was ~$1).
 *
 * Pricing source:
 *   `GET https://openrouter.ai/api/v1/models` → `data[].pricing`. The
 *   anonymous endpoint returns public list prices; sending
 *   `Authorization: Bearer <OPENROUTER_API_KEY>` returns the caller's
 *   tier-specific pricing (BYOK volume discounts, etc.). We use the key
 *   when available so reported costs match the user's actual bill.
 *
 *   Pricing fields are dollars-per-token strings. Observed keys:
 *     prompt, completion, input_cache_read, input_cache_write,
 *     image, audio, web_search, internal_reasoning, request
 *
 *   Most models populate prompt + completion. Anthropic-on-OpenRouter
 *   and a handful of others also populate cache_read / cache_write.
 *   When a field is missing we default it to 0, which matches
 *   OpenRouter's billing behavior (no charge).
 *
 * Caching:
 *   The first fetch in a process writes the parsed catalog to
 *   `<tmpdir>/shogo-openrouter-pricing.json` with a timestamp.
 *   Subsequent calls (in this process or other concurrent eval runs on
 *   the same machine) reuse the file until `ttlMs` expires (default
 *   24h). Failures fall back to a stale cache before giving up — we'd
 *   rather report stale prices than zero.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-token rates in USD. Multiply by token count directly — these are
 * the same units `run-eval.ts::PRICING` uses, so an OpenRouter pricing
 * entry can drop straight into that table.
 */
export interface PerTokenPricing {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface OpenRouterModelEntry {
  id: string
  name?: string
  context_length?: number
  pricing?: {
    prompt?: string
    completion?: string
    input_cache_read?: string
    input_cache_write?: string
    request?: string
    image?: string
  }
}

interface CachedCatalog {
  fetchedAt: number
  models: Record<string, PerTokenPricing>
  /** Full names indexed by id, useful for admin UI display. */
  names?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Cache file
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

function defaultCachePath(): string {
  const dir = join(tmpdir(), 'shogo-openrouter-cache')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'pricing.json')
}

function readCache(path: string): CachedCatalog | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as CachedCatalog
    if (
      typeof parsed?.fetchedAt === 'number'
      && parsed?.models
      && typeof parsed.models === 'object'
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

function writeCache(path: string, catalog: CachedCatalog): void {
  try {
    writeFileSync(path, JSON.stringify(catalog), 'utf8')
  } catch {
    // Cache is best-effort; failing to write shouldn't break the run.
  }
}

// ---------------------------------------------------------------------------
// Catalog fetch
// ---------------------------------------------------------------------------

function num(v: string | undefined): number {
  if (!v) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function normalizeEntry(e: OpenRouterModelEntry): PerTokenPricing {
  const p = e.pricing || {}
  return {
    input: num(p.prompt),
    output: num(p.completion),
    cacheRead: num(p.input_cache_read),
    cacheWrite: num(p.input_cache_write),
  }
}

async function fetchCatalog(): Promise<CachedCatalog> {
  const baseUrl = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '')
  const apiKey = process.env.OPENROUTER_API_KEY
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const res = await fetch(`${baseUrl}/models`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new Error(`OpenRouter /models returned ${res.status}: ${await res.text().catch(() => res.statusText)}`)
  }
  const data = await res.json() as { data?: OpenRouterModelEntry[] }
  const entries = data.data || []

  const models: Record<string, PerTokenPricing> = {}
  const names: Record<string, string> = {}
  for (const e of entries) {
    if (!e.id) continue
    models[e.id] = normalizeEntry(e)
    if (e.name) names[e.id] = e.name
  }
  return { fetchedAt: Date.now(), models, names }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let _processCache: CachedCatalog | null = null

interface FetchOpts {
  ttlMs?: number
  cachePath?: string
  /** Set to true to force a network fetch (skip disk cache and process cache). */
  forceRefresh?: boolean
}

/**
 * Returns the full per-token pricing catalog keyed by OpenRouter
 * canonical model id (e.g. `xiaomi/mimo-v2.5`, `anthropic/claude-sonnet-4-6`).
 * Disk-cached for `ttlMs` (default 24h) to avoid hammering the API
 * across parallel eval runs.
 */
export async function getOpenRouterPricingCatalog(opts: FetchOpts = {}): Promise<CachedCatalog> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS
  const path = opts.cachePath ?? defaultCachePath()

  if (_processCache && !opts.forceRefresh && Date.now() - _processCache.fetchedAt < ttl) {
    return _processCache
  }

  if (!opts.forceRefresh) {
    const disk = readCache(path)
    if (disk && Date.now() - disk.fetchedAt < ttl) {
      _processCache = disk
      return disk
    }
  }

  try {
    const fresh = await fetchCatalog()
    writeCache(path, fresh)
    _processCache = fresh
    return fresh
  } catch (err) {
    // Fall back to a stale cache rather than reporting $0.
    const stale = readCache(path)
    if (stale) {
      _processCache = stale
      return stale
    }
    throw err
  }
}

/**
 * Strip the `openrouter:` prefix and resolve a model id to its OpenRouter
 * pricing. Returns `null` for unknown ids.
 */
export async function getOpenRouterPricing(
  id: string,
  opts: FetchOpts = {},
): Promise<PerTokenPricing | null> {
  const canonical = id.startsWith('openrouter:') ? id.slice('openrouter:'.length) : id
  const catalog = await getOpenRouterPricingCatalog(opts)
  return catalog.models[canonical] ?? null
}

/**
 * Synchronous accessor — only succeeds if a previous async fetch has
 * already populated the in-process cache (or if the disk cache is
 * fresh). Returns null otherwise. Use when you can't await but still
 * want pricing if it's cheaply available.
 */
export function getOpenRouterPricingSync(
  id: string,
  opts: { ttlMs?: number; cachePath?: string } = {},
): PerTokenPricing | null {
  const canonical = id.startsWith('openrouter:') ? id.slice('openrouter:'.length) : id
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS
  if (_processCache && Date.now() - _processCache.fetchedAt < ttl) {
    return _processCache.models[canonical] ?? null
  }
  const path = opts.cachePath ?? defaultCachePath()
  const disk = readCache(path)
  if (disk && Date.now() - disk.fetchedAt < ttl) {
    _processCache = disk
    return disk.models[canonical] ?? null
  }
  return null
}
