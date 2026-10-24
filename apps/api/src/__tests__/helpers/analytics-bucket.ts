// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pin the wall clock inside one analytics cache bucket (SHO-186).
 *
 * `analyticsCacheKey` buckets the rolling window at `ANALYTICS_CACHE_BUCKET_MS`,
 * so two opens share a key only while the clock stays inside one bucket. Tests
 * that assert "a second open is a cache hit" used to *sleep* up to the next
 * boundary to make that true — up to 10 050 ms in the perf test (longer than
 * bun's 5 s default test timeout, so ~8 % of CI runs died on the sleep itself)
 * and up to 40 s in the acceptance test. Pinning the clock makes the shared
 * bucket a fact instead of a race, with no waiting at all.
 *
 * `setSystemTime` moves `Date.now()` / `new Date()` only: timers and
 * `performance.now()` keep running on the real clock, so the perf test's
 * elapsed-time bound still measures real time. Nothing on the analytics read
 * path (`lib/analytics-cache.ts` keys and expires on `Date.now()`;
 * `services/analytics.service.ts` takes `new Date()`) reads `performance.now()`
 * or arms a timer, so the pinned clock is exactly what the cache sees.
 *
 * Always restore with `restoreClock()` (from `afterEach`) so the tests that run
 * after the pinned one see the real clock.
 */
import { setSystemTime } from 'bun:test'
import { ANALYTICS_CACHE_BUCKET_MS } from '../../lib/analytics-cache'

/**
 * Where in the bucket to pin the clock.
 *
 * 1 000 ms by default — early in a bucket, clear of both edges, so it reads as
 * an ordinary open. Override it to show the test no longer depends on where the
 * clock stands relative to a boundary, e.g.
 * `SHO186_CLOCK_INTO_BUCKET_MS=53000 bun test …` pins 7 s before the next one.
 */
export const CLOCK_INTO_BUCKET_MS = Number(process.env.SHO186_CLOCK_INTO_BUCKET_MS ?? 1_000)

export function pinClockIntoCacheBucket(intoBucketMs: number = CLOCK_INTO_BUCKET_MS): void {
  const bucketStart = Math.floor(Date.now() / ANALYTICS_CACHE_BUCKET_MS) * ANALYTICS_CACHE_BUCKET_MS
  setSystemTime(new Date(bucketStart + intoBucketMs))
}

/** Put the real wall clock back. */
export function restoreClock(): void {
  setSystemTime()
}
