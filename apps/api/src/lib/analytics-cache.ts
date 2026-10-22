// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Short-TTL cache for the Analytics reads (SHO-140).
 *
 * The Usage tab re-derives the same aggregates for every member who opens it
 * and for every param change on screen. Two requests for the same
 * (scope, window, shape) inside the TTL must not scan `usage_events` twice, so
 * this caches the *promise*, not just the value: a second caller arriving while
 * the first scan is still running awaits it instead of starting another one.
 *
 * Per-process is correct here: the API runs as a single deployment and every
 * entry is a pure read of rows that only change through
 * `invalidateAnalyticsCache` (wired to the usage-event insert point), so a
 * stale entry can never be older than the TTL.
 */

const DEFAULT_TTL_MS = 60_000

/**
 * Rolling windows are bucketed to this before they become a cache key.
 *
 * It must never be shorter than the TTL. The key is what a request looks up, so
 * an entry only ever helps requests that land in the same bucket: with a 30 s
 * bucket and a 60 s TTL a second open 31 s later computed a different key and
 * scanned again, i.e. half the TTL was unreachable. At 60 s == TTL the key is
 * stable for exactly as long as an entry can be served, and because a caller
 * always buckets with *its own* clock an entry can never be served outside the
 * bucket it was written in (so a window is never read from the wrong bucket).
 */
export const ANALYTICS_CACHE_BUCKET_MS = 60_000

interface CacheEntry {
  expiresAt: number
  promise: Promise<unknown>
}

const entries = new Map<string, CacheEntry>()

/**
 * Cache key. Every dimension that changes the answer is part of it — in
 * particular the caller's own member id when a non-admin is scoped to
 * themselves, so a member never receives an admin-wide result (or another
 * member's) from the cache.
 *
 * `from`/`to` are the *bucketed* window ends: a rolling "last 30 days" window
 * moves with every request, so the raw timestamps would miss on every call. The
 * query still runs with the exact window; a hit means the caller gets rows read
 * up to one bucket ago, which the insert-time invalidation clears.
 */
export function analyticsCacheKey(parts: {
  workspaceId?: string
  projectId?: string | null
  /** `undefined` = every member (admin / platform scope). */
  userId?: string
  from: Date
  to: Date
  shape: string
}): string {
  const scope = parts.projectId
    ? `project:${parts.projectId}`
    : parts.workspaceId
      ? `workspace:${parts.workspaceId}`
      : 'platform'
  const member = parts.userId ? `member:${parts.userId}` : 'all'
  return `${scope}|${member}|${bucket(parts.from)}|${bucket(parts.to)}|${parts.shape}`
}

/** Floor a timestamp to `ANALYTICS_CACHE_BUCKET_MS` so rolling windows share a key. */
function bucket(date: Date): number {
  return Math.floor(date.getTime() / ANALYTICS_CACHE_BUCKET_MS)
}

/**
 * Run `fn` once per key per TTL. Concurrent callers share the in-flight
 * promise; a rejection is evicted immediately so the next request retries
 * instead of serving the error for a minute.
 */
export function withAnalyticsCache<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const now = Date.now()
  const hit = entries.get(key)
  if (hit && hit.expiresAt > now) return hit.promise as Promise<T>

  const promise = fn()
  const entry: CacheEntry = { expiresAt: now + ttlMs, promise }
  entries.set(key, entry)
  promise.catch(() => {
    if (entries.get(key) === entry) entries.delete(key)
  })
  return promise
}

/**
 * Drop every cached shape for one workspace (or project). Called from the
 * usage-event insert point, so a fresh event is visible on the next open
 * without waiting out the TTL.
 */
export function invalidateAnalyticsCache(scope: {
  workspaceId?: string
  projectId?: string | null
}): void {
  if (scope.workspaceId) expire((key) => key.startsWith(`workspace:${scope.workspaceId}|`))
  if (scope.projectId) expire((key) => key.startsWith(`project:${scope.projectId}|`))
}

/** Test seam: forget everything. */
export function clearAnalyticsCache(): void {
  entries.clear()
}

export const ANALYTICS_CACHE_DEFAULT_TTL_MS = DEFAULT_TTL_MS

function expire(match: (key: string) => boolean): void {
  for (const key of [...entries.keys()]) {
    if (match(key)) entries.delete(key)
  }
}
