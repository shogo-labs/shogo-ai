// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { headroomPctFor, planEvictions, type EvictionCandidate } from './gc-policy'

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

describe('headroom: reclaim before the alert line', () => {
  // Staging dal-1 sat flat at 84.27% for hours with ~694 suspended snapshots
  // because the only disk trigger was `>= 85`, i.e. the alert itself. The
  // headroom trigger reclaims on the way up instead of at the page.
  const baseline = {
    totalBytes: 100 * GB,
    cacheBytes: 30 * GB,
    highPct: 85,
    lowPct: 70,
    cacheMaxBytes: 0,
  }

  test('a host just under the alert line now reclaims, marked as a headroom trim', () => {
    const d = planEvictions({
      ...baseline,
      usedBytes: 84 * GB,
      headroomPct: 80,
      candidates: [
        cand({ projectId: 'oldest', bytes: 2 * GB, lastAccessAt: 1 }),
        cand({ projectId: 'middle', bytes: 2 * GB, lastAccessAt: 2 }),
        cand({ projectId: 'newest', bytes: 2 * GB, lastAccessAt: 3 }),
      ],
    })
    expect(d.triggered).toBe(true)
    expect(d.trigger).toBe('headroom')
    // A trim, not a flush: once back under 80 GB it stops. Two snapshots
    // (4 GB) is the smallest set that clears the trigger.
    expect(d.evict).toEqual(['oldest', 'middle'])
    expect(d.plannedBytes).toBe(4 * GB)
  })

  test('a host under the headroom is untouched (no behaviour change on a healthy disk)', () => {
    const d = planEvictions({
      ...baseline,
      usedBytes: 79 * GB,
      headroomPct: 80,
      candidates: [cand({ projectId: 'a', bytes: 10 * GB })],
    })
    expect(d).toMatchObject({ triggered: false, trigger: null, evict: [] })
  })

  test('headroomPct 0 restores the old behaviour: nothing happens until 85', () => {
    const d = planEvictions({
      ...baseline,
      usedBytes: 84 * GB,
      headroomPct: 0,
      candidates: [cand({ projectId: 'a', bytes: 10 * GB })],
    })
    expect(d.triggered).toBe(false)
    expect(d.trigger).toBeNull()
  })

  test('above the alert line the watermark still governs and drains to low', () => {
    const d = planEvictions({
      ...baseline,
      usedBytes: 90 * GB,
      headroomPct: 80,
      candidates: [
        cand({ projectId: 'a', bytes: 10 * GB, lastAccessAt: 1 }),
        cand({ projectId: 'b', bytes: 10 * GB, lastAccessAt: 2 }),
        cand({ projectId: 'c', bytes: 10 * GB, lastAccessAt: 3 }),
      ],
    })
    expect(d.trigger).toBe('watermark')
    expect(d.plannedBytes).toBe(20 * GB) // down to the 70 GB low watermark
  })

  test('a headroom trim stops at its budget when the target is out of reach', () => {
    // The dal-1 shape: a volume large enough that four points of used% is far
    // more than the whole cache. Unbounded, this sweep would empty the warm pool
    // and do it again on the next one.
    const d = planEvictions({
      totalBytes: 10_000 * GB,
      usedBytes: 8_400 * GB, // 84%: past the 80% headroom, nowhere near 85%
      cacheBytes: 60 * GB,
      candidates: Array.from({ length: 6 }, (_, i) =>
        cand({ projectId: `p${i}`, bytes: 10 * GB, lastAccessAt: i }),
      ),
      highPct: 85,
      lowPct: 70,
      headroomPct: 80,
      headroomBudgetBytes: 25 * GB,
      cacheMaxBytes: 0,
    })
    expect(d.trigger).toBe('headroom')
    expect(d.evict).toEqual(['p0', 'p1', 'p2']) // LRU-first, then the budget stops it
    expect(d.plannedBytes).toBe(30 * GB) // within one entry of the budget
    expect(d.evictableCount).toBe(6) // the rest are still there, still cold
  })

  test('the budget never bounds the watermark path', () => {
    const d = planEvictions({
      ...baseline,
      usedBytes: 90 * GB,
      headroomPct: 80,
      headroomBudgetBytes: 5 * GB,
      candidates: [
        cand({ projectId: 'a', bytes: 10 * GB, lastAccessAt: 1 }),
        cand({ projectId: 'b', bytes: 10 * GB, lastAccessAt: 2 }),
        cand({ projectId: 'c', bytes: 10 * GB, lastAccessAt: 3 }),
      ],
    })
    expect(d.trigger).toBe('watermark')
    expect(d.plannedBytes).toBe(20 * GB) // a page is worth more than the budget
  })

  test('the cap still triggers on its own, labelled cap', () => {
    const d = planEvictions({
      ...baseline,
      usedBytes: 40 * GB,
      cacheBytes: 40 * GB,
      cacheMaxBytes: 20 * GB,
      headroomPct: 80,
      candidates: [
        cand({ projectId: 'a', bytes: 15 * GB, lastAccessAt: 1 }),
        cand({ projectId: 'b', bytes: 15 * GB, lastAccessAt: 2 }),
      ],
    })
    expect(d.trigger).toBe('cap')
    // Cache 40 GB against a 20 GB cap: both snapshots have to go to clear it.
    expect(d.evict).toEqual(['a', 'b'])
  })

  test('a trigger with nothing evictable reports it (the dal-1 shape)', () => {
    // Disk under pressure, 694 suspended snapshots, and every one of them
    // non-evictable because the host has no durable store: this used to be
    // completely silent. `evictable=0` on the log line is the diagnosis.
    const d = planEvictions({
      ...baseline,
      usedBytes: 84.27 * GB,
      headroomPct: 80,
      candidates: Array.from({ length: 5 }, (_, i) =>
        cand({ projectId: `p${i}`, bytes: GB, lastAccessAt: i, durableBacked: false }),
      ),
    })
    expect(d.trigger).toBe('headroom')
    expect(d.triggered).toBe(false)
    expect(d.evict).toEqual([])
    expect(d.evictableCount).toBe(0)
  })
})

describe('headroomPctFor', () => {
  test('accepts a value strictly between low and high', () => {
    expect(headroomPctFor({ gcHeadroomPct: 80, diskLowPct: 70, diskHighPct: 85 })).toBe(80)
  })

  test('ignores an out-of-range or disabled value rather than flushing the cache every sweep', () => {
    expect(headroomPctFor({ gcHeadroomPct: 0, diskLowPct: 70, diskHighPct: 85 })).toBe(0)
    expect(headroomPctFor({ gcHeadroomPct: 70, diskLowPct: 70, diskHighPct: 85 })).toBe(0)
    expect(headroomPctFor({ gcHeadroomPct: 85, diskLowPct: 70, diskHighPct: 85 })).toBe(0)
    expect(headroomPctFor({ gcHeadroomPct: 120, diskLowPct: 70, diskHighPct: 85 })).toBe(0)
    expect(headroomPctFor({ gcHeadroomPct: NaN, diskLowPct: 70, diskHighPct: 85 })).toBe(0)
  })
})
