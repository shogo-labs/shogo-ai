// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The pin is the whole fix for SHO-186, so assert what the cache actually sees:
 * a `Date.now()` inside the bucket we asked for, held still across both opens,
 * and a real clock again afterwards.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { ANALYTICS_CACHE_BUCKET_MS } from '../../lib/analytics-cache'
import { CLOCK_INTO_BUCKET_MS, pinClockIntoCacheBucket, restoreClock } from './analytics-bucket'

afterEach(() => restoreClock())

describe('pinClockIntoCacheBucket', () => {
  test('pins Date.now() into the requested offset of one bucket', () => {
    pinClockIntoCacheBucket()
    const pinned = Date.now()
    expect(pinned % ANALYTICS_CACHE_BUCKET_MS).toBe(CLOCK_INTO_BUCKET_MS)
    // The clock is frozen, so both opens land in the same bucket by construction.
    expect(Date.now()).toBe(pinned)
    expect(new Date().getTime()).toBe(pinned)
  })

  test('holds the bucket wherever the pin sits, including 100 ms before the next one', () => {
    for (const intoBucket of [0, 500, 53_000, 59_900]) {
      pinClockIntoCacheBucket(intoBucket)
      const bucket = Math.floor(Date.now() / ANALYTICS_CACHE_BUCKET_MS)
      expect(Date.now() % ANALYTICS_CACHE_BUCKET_MS).toBe(intoBucket)
      // Same bucket before and after the work a test does between two opens.
      expect(Math.floor(Date.now() / ANALYTICS_CACHE_BUCKET_MS)).toBe(bucket)
    }
  })

  test('restoreClock puts the real wall clock back', () => {
    const realBefore = Date.now()
    pinClockIntoCacheBucket()
    expect(Date.now()).toBe(realBefore - (realBefore % ANALYTICS_CACHE_BUCKET_MS) + CLOCK_INTO_BUCKET_MS)

    restoreClock()
    const realAfter = Date.now()
    expect(realAfter).toBeGreaterThanOrEqual(realBefore)
    // Restored to real time, not to some other instant: the only time that can
    // have passed is this test's own.
    expect(realAfter - realBefore).toBeLessThan(5_000)
  })
})
