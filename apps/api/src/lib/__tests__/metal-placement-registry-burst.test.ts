// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Burst-host tracking, reconcile leader lease, and scale cooldown on the metal
 * placement registry. Exercised against the in-memory fallback (redisGetter =>
 * null) — the same code path used when Redis is unavailable, and enough to prove
 * the semantics the reconciler relies on.
 */

import { describe, expect, it } from 'bun:test'
import { MetalPlacementRegistry } from '../metal-placement-registry'

function reg() {
  return new MetalPlacementRegistry(() => null)
}

describe('registry burst hosts', () => {
  it('records, lists, and removes burst hosts', async () => {
    const r = reg()
    await r.recordBurstHost({ hostId: 'b1', serverId: 'sv_1', region: 'us', site: 'DAL', createdAt: 1 })
    await r.recordBurstHost({ hostId: 'b2', serverId: 'sv_2', region: 'eu', site: 'FRA', createdAt: 2 })
    let all = await r.listBurstHosts()
    expect(all.map((h) => h.hostId).sort()).toEqual(['b1', 'b2'])

    // Upsert (mark draining) keeps a single record.
    await r.recordBurstHost({ hostId: 'b1', serverId: 'sv_1', region: 'us', site: 'DAL', createdAt: 1, drainingSince: 9 })
    all = await r.listBurstHosts()
    expect(all.find((h) => h.hostId === 'b1')?.drainingSince).toBe(9)
    expect(all.length).toBe(2)

    await r.removeBurstHost('b1')
    all = await r.listBurstHosts()
    expect(all.map((h) => h.hostId)).toEqual(['b2'])
  })
})

describe('registry reconcile leader lease', () => {
  it('grants to the first holder and denies a second until re-held', async () => {
    const r = reg()
    expect(await r.acquireReconcileLease('a', 10_000)).toBe(true)
    expect(await r.acquireReconcileLease('b', 10_000)).toBe(false)
    // Same holder re-acquires (renew).
    expect(await r.acquireReconcileLease('a', 10_000)).toBe(true)
  })

  it('lets a new holder take over after the lease expires', async () => {
    const r = reg()
    expect(await r.acquireReconcileLease('a', 1)).toBe(true)
    await new Promise((res) => setTimeout(res, 5))
    expect(await r.acquireReconcileLease('b', 10_000)).toBe(true)
  })
})

describe('registry scale cooldown', () => {
  it('defaults to 0 and round-trips the last scale time per region', async () => {
    const r = reg()
    expect(await r.getLastScaleAt('us')).toBe(0)
    await r.setLastScaleAt('us', 12345)
    expect(await r.getLastScaleAt('us')).toBe(12345)
    expect(await r.getLastScaleAt('eu')).toBe(0)
  })
})
