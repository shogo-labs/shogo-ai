// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { MetalWarmPoolController } from '../metal-warm-pool-controller'
import { MetalPlacementRegistry } from '../metal-placement-registry'

const fakeEnv = () => async () => ({ PROJECT_ID: 'p' })

const REG = {
  hostId: 'h',
  meshIp: '10.0.0.1',
  agentPort: 9900,
  region: 'us',
  arch: 'x64',
  capacity: { poolSize: 4, memMiB: 2048, vcpus: 2 },
  load: { available: 1, assigned: 0, suspended: 0 },
}

describe('MetalWarmPoolController — cache/disk-aware routing', () => {
  it('de-prioritizes hosts over the disk high-watermark for new placements', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(new URL(url).hostname)
      return new Response(JSON.stringify({ url: 'http://g:8080', mode: 'assigned' }), { status: 200 })
    }) as any
    const registry = new MetalPlacementRegistry(() => null)
    const c = new MetalWarmPoolController(fakeEnv(), fetchImpl, Date.now, registry)
    // full host (95% used) should be skipped in favor of the roomy one, even
    // though the full host has lighter VM load.
    c.registerHost({
      ...REG,
      hostId: 'full',
      meshIp: '10.0.0.2',
      load: { available: 1, assigned: 0, suspended: 0 },
      disk: { totalBytes: 100, freeBytes: 5, usedPct: 95, cacheBytes: 90, localCount: 100 },
    })
    c.registerHost({
      ...REG,
      hostId: 'roomy',
      meshIp: '10.0.0.3',
      load: { available: 1, assigned: 2, suspended: 0 },
      disk: { totalBytes: 100, freeBytes: 60, usedPct: 40, cacheBytes: 30, localCount: 30 },
    })

    await c.getMetalProjectUrl('p-new')
    expect(seen[0]).toBe('10.0.0.3') // roomy host chosen first
  })

  it('prefers the host holding the project locally (placement) over load ordering', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(new URL(url).hostname)
      return new Response(JSON.stringify({ url: 'http://g:8080', mode: 'resumed', source: 'local' }), { status: 200 })
    }) as any
    const registry = new MetalPlacementRegistry(() => null)
    // Project already placed on the busier host — a local resume beats a lighter
    // host that would need an S3 pull / cold boot.
    await registry.setPlacement('p-cached', 'busy', 'local')
    const c = new MetalWarmPoolController(fakeEnv(), fetchImpl, Date.now, registry)
    c.registerHost({ ...REG, hostId: 'idle', meshIp: '10.0.0.4', load: { available: 4, assigned: 0, suspended: 0 } })
    c.registerHost({ ...REG, hostId: 'busy', meshIp: '10.0.0.5', load: { available: 0, assigned: 4, suspended: 0 } })

    await c.getMetalProjectUrl('p-cached')
    expect(seen[0]).toBe('10.0.0.5') // the cache-local host
  })

  it('a lease loser converges on the winner’s placed host (no split brain)', async () => {
    const registry = new MetalPlacementRegistry(() => null)
    // Winner already holds the lease and published placement on host "winner".
    await registry.acquireLease('p-race', 'winner-pod', 60_000)
    await registry.setPlacement('p-race', 'winner', 'local')

    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(new URL(url).hostname)
      return new Response(JSON.stringify({ url: 'http://g:8080', mode: 'resumed', source: 'local' }), { status: 200 })
    }) as any
    const c = new MetalWarmPoolController(fakeEnv(), fetchImpl, Date.now, registry)
    c.registerHost({ ...REG, hostId: 'other', meshIp: '10.0.0.6', load: { available: 4, assigned: 0, suspended: 0 } })
    c.registerHost({ ...REG, hostId: 'winner', meshIp: '10.0.0.7', load: { available: 0, assigned: 3, suspended: 0 } })

    // This controller loses the lease → must route to the winner's placed host.
    await c.getMetalProjectUrl('p-race')
    expect(seen[0]).toBe('10.0.0.7')
  })
})
