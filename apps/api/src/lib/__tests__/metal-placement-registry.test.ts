// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { MetalPlacementRegistry, type HostScalars } from '../metal-placement-registry'

// Force the in-process fallback (no Redis) so the tests are deterministic.
const mk = () => new MetalPlacementRegistry(() => null)

const host = (id: string, over: Partial<HostScalars> = {}): HostScalars => ({
  hostId: id,
  meshIp: '10.0.0.1',
  agentPort: 9900,
  region: 'us',
  arch: 'x64',
  capacity: { poolSize: 4, memMiB: 2048, vcpus: 2 },
  load: { available: 1, assigned: 0, suspended: 0 },
  lastSeenAt: Date.now(),
  ...over,
})

describe('MetalPlacementRegistry (in-memory fallback)', () => {
  it('upserts and lists live hosts', async () => {
    const r = mk()
    await r.upsertHost(host('a'))
    await r.upsertHost(host('b'))
    const ids = (await r.listHosts()).map((h) => h.hostId).sort()
    expect(ids).toEqual(['a', 'b'])
  })

  it('drops hosts older than the TTL from listHosts', async () => {
    const r = mk()
    await r.upsertHost(host('stale', { lastSeenAt: Date.now() - 10 * 60_000 }))
    expect(await r.listHosts()).toEqual([])
  })

  it('set/get/clear placement round-trips', async () => {
    const r = mk()
    await r.setPlacement('p', 'host-1', 'local')
    expect((await r.getPlacement('p'))?.hostId).toBe('host-1')
    expect((await r.getPlacement('p'))?.tier).toBe('local')
    await r.clearPlacement('p')
    expect(await r.getPlacement('p')).toBeNull()
  })

  it('lease is exclusive: a second holder cannot acquire until release', async () => {
    const r = mk()
    expect(await r.acquireLease('p', 'holderA', 60_000)).toBe(true)
    expect(await r.acquireLease('p', 'holderB', 60_000)).toBe(false)
    expect(await r.leaseHolder('p')).toBe('holderA')
    // Same holder re-acquire is idempotent.
    expect(await r.acquireLease('p', 'holderA', 60_000)).toBe(true)
    await r.releaseLease('p', 'holderA')
    expect(await r.leaseHolder('p')).toBeNull()
    expect(await r.acquireLease('p', 'holderB', 60_000)).toBe(true)
  })

  it('only the holder can renew or release', async () => {
    const r = mk()
    await r.acquireLease('p', 'A', 60_000)
    expect(await r.renewLease('p', 'B')).toBe(false)
    expect(await r.renewLease('p', 'A')).toBe(true)
    await r.releaseLease('p', 'B') // wrong holder → no-op
    expect(await r.leaseHolder('p')).toBe('A')
  })

  it('an expired lease can be acquired by anyone', async () => {
    const r = mk()
    await r.acquireLease('p', 'A', 1) // 1ms TTL
    await new Promise((res) => setTimeout(res, 5))
    expect(await r.acquireLease('p', 'B', 60_000)).toBe(true)
  })
})
