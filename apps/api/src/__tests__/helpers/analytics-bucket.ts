// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Run a two-open cache assertion inside a single analytics cache bucket.
 *
 * `analyticsCacheKey` buckets the rolling window, so two opens that straddle a
 * bucket boundary legitimately miss the cache. The old way of dealing with that
 * was to sleep until the next boundary — up to 10 s in the perf test and up to
 * 40 s in the acceptance test. That is longer than Bun's 5 s default test
 * timeout, so a run that started a few seconds before a boundary slept past its
 * own timeout and failed without ever reaching its assertions (SHO-186: ~8 % of
 * CI runs, and the retry started inside the same window and failed too).
 *
 * Instead of waiting, re-run the pair when it straddled: the assertion only ever
 * runs on two opens that shared one bucket, and a normal run costs nothing. A
 * pair takes a few hundred milliseconds, so needing a second attempt at all is
 * ~0.5 % of runs and needing more is vanishingly unlikely.
 *
 * `run` must be self-contained per attempt (clear the cache / reset counters
 * inside it), because an attempt that straddles is thrown away.
 */
import { ANALYTICS_CACHE_BUCKET_MS } from '../../lib/analytics-cache'

export async function inOneCacheBucket<T>(
  run: () => Promise<T>,
  opts: { attempts?: number; now?: () => number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 5
  const now = opts.now ?? Date.now

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const bucketAtStart = Math.floor(now() / ANALYTICS_CACHE_BUCKET_MS)
    const result = await run()
    if (Math.floor(now() / ANALYTICS_CACHE_BUCKET_MS) === bucketAtStart) return result
  }

  throw new Error(
    `could not run the pair inside one ${ANALYTICS_CACHE_BUCKET_MS} ms cache bucket in ${attempts} attempts`,
  )
}
