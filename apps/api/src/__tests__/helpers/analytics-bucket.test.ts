// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The retry path of `inOneCacheBucket` is what keeps a cache-pair test off the
 * clock. It is rare in a real run (two opens straddle a 60 s boundary ~0.5 % of
 * the time), so drive it with a fake clock rather than waiting for it.
 */
import { describe, expect, test } from 'bun:test'
import { ANALYTICS_CACHE_BUCKET_MS } from '../../lib/analytics-cache'
import { inOneCacheBucket } from './analytics-bucket'

describe('inOneCacheBucket', () => {
  test('runs the pair once when both opens share a bucket', async () => {
    let clock = 0
    let runs = 0
    const result = await inOneCacheBucket(
      async () => {
        runs += 1
        clock += 300
        return `run-${runs}`
      },
      { now: () => clock },
    )
    expect(runs).toBe(1)
    expect(result).toBe('run-1')
  })

  test('re-runs the pair when a boundary fell between the two opens', async () => {
    let clock = ANALYTICS_CACHE_BUCKET_MS - 100
    let runs = 0
    const startedAt = performance.now()

    const result = await inOneCacheBucket(
      async () => {
        runs += 1
        // The first pair starts 100 ms before a boundary, so it straddles it;
        // the second pair is 300 ms into the new bucket and lands cleanly.
        if (runs === 1) clock += 400
        else clock += 300
        return `run-${runs}`
      },
      { now: () => clock },
    )

    expect(runs).toBe(2)
    expect(result).toBe('run-2')
    // The whole point: straddling costs an extra attempt, never a wait.
    expect(performance.now() - startedAt).toBeLessThan(250)
  })

  test('fails loudly instead of asserting on a straddled pair', async () => {
    let clock = 0
    let runs = 0
    const alwaysStraddles = inOneCacheBucket(
      async () => {
        runs += 1
        clock += ANALYTICS_CACHE_BUCKET_MS
        return null
      },
      { now: () => clock, attempts: 3 },
    )

    await expect(alwaysStraddles).rejects.toThrow(/one 60000 ms cache bucket in 3 attempts/)
    expect(runs).toBe(3)
  })
})
