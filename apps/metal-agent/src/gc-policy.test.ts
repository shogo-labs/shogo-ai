// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { planEvictions, type EvictionCandidate } from './gc-policy'

const GB = 1024 ** 3

function cand(overrides: Partial<EvictionCandidate>): EvictionCandidate {
  return {
    projectId: 'p',
    bytes: GB,
    lastAccessAt: 0,
    durableBacked: true,
    inFlight: false,
    ...overrides,
  }
}

describe('planEvictions', () => {
  test('does not trigger below the high watermark', () => {
    const d = planEvictions({
      usedBytes: 50 * GB,
      totalBytes: 100 * GB,
      cacheBytes: 10 * GB,
      candidates: [cand({ projectId: 'a' })],
      highPct: 85,
      lowPct: 70,
      cacheMaxBytes: 0,
    })
    expect(d.triggered).toBe(false)
    expect(d.evict).toEqual([])
  })

  test('evicts LRU-first down to the low watermark', () => {
    // 90/100 used, high=85, low=70 → must reclaim to <=70 GB (>=20 GB).
    const candidates = [
      cand({ projectId: 'newest', bytes: 10 * GB, lastAccessAt: 300 }),
      cand({ projectId: 'oldest', bytes: 10 * GB, lastAccessAt: 100 }),
      cand({ projectId: 'middle', bytes: 10 * GB, lastAccessAt: 200 }),
    ]
    const d = planEvictions({
      usedBytes: 90 * GB,
      totalBytes: 100 * GB,
      cacheBytes: 30 * GB,
      candidates,
      highPct: 85,
      lowPct: 70,
      cacheMaxBytes: 0,
    })
    expect(d.triggered).toBe(true)
    // oldest + middle = 20 GB reclaimed → used 70 GB (<= low). newest kept.
    expect(d.evict).toEqual(['oldest', 'middle'])
    expect(d.plannedBytes).toBe(20 * GB)
  })

  test('never evicts un-backed or in-flight snapshots', () => {
    const candidates = [
      cand({ projectId: 'unbacked', bytes: 10 * GB, lastAccessAt: 1, durableBacked: false }),
      cand({ projectId: 'inflight', bytes: 10 * GB, lastAccessAt: 2, inFlight: true }),
      cand({ projectId: 'ok', bytes: 10 * GB, lastAccessAt: 3 }),
    ]
    const d = planEvictions({
      usedBytes: 95 * GB,
      totalBytes: 100 * GB,
      cacheBytes: 30 * GB,
      candidates,
      highPct: 85,
      lowPct: 70,
      cacheMaxBytes: 0,
    })
    expect(d.evict).toEqual(['ok'])
  })

  test('honors the cache byte cap even below the disk watermark', () => {
    const candidates = [
      cand({ projectId: 'a', bytes: 5 * GB, lastAccessAt: 1 }),
      cand({ projectId: 'b', bytes: 5 * GB, lastAccessAt: 2 }),
    ]
    const d = planEvictions({
      usedBytes: 10 * GB,
      totalBytes: 100 * GB, // 10% disk — far below high
      cacheBytes: 10 * GB,
      candidates,
      highPct: 85,
      lowPct: 70,
      cacheMaxBytes: 6 * GB, // cache over cap by 4 GB → evict oldest (5 GB)
    })
    expect(d.triggered).toBe(true)
    expect(d.evict).toEqual(['a'])
  })

  test('force drains everything evictable regardless of watermarks', () => {
    const candidates = [
      cand({ projectId: 'a', bytes: GB, lastAccessAt: 1 }),
      cand({ projectId: 'b', bytes: GB, lastAccessAt: 2, inFlight: true }),
      cand({ projectId: 'c', bytes: GB, lastAccessAt: 3 }),
    ]
    const d = planEvictions({
      usedBytes: 1 * GB,
      totalBytes: 100 * GB,
      cacheBytes: 3 * GB,
      candidates,
      highPct: 85,
      lowPct: 70,
      cacheMaxBytes: 0,
      force: true,
    })
    expect(d.triggered).toBe(true)
    expect(d.evict).toEqual(['a', 'c']) // in-flight still protected
  })
})
