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
      if (url.endsWith('/status')) return Response.json({ state: 'none' })
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

  it('a lease loser joins the winner’s host while the winner’s cold boot is still running', async () => {
    const registry = new MetalPlacementRegistry(() => null)
    let finishWinnerBoot!: () => void
    const winnerBooting = new Promise<void>((r) => (finishWinnerBoot = r))
    const assigns: Array<{ pod: string; host: string }> = []
    const fetchFor = (pod: string) =>
      (async (url: string) => {
        if (url.endsWith('/status')) return Response.json({ state: 'none' })
        assigns.push({ pod, host: new URL(url).hostname })
        if (pod === 'a') await winnerBooting
        return new Response(JSON.stringify({ url: 'http://g:8080', mode: 'assigned' }), { status: 200 })
      }) as any

    // Each API pod sees a different least-loaded host (heartbeats lag the
    // winner's in-flight boot), so load ordering alone would split them.
    const pod = (name: string) => {
      const c = new MetalWarmPoolController(fakeEnv(), fetchFor(name), Date.now, registry, async () => ({ PROJECT_ID: 'p' }))
      ;(c as any).holderId = `pod-${name}`
      return c
    }
    const a = pod('a')
    a.registerHost({ ...REG, hostId: 'h1', meshIp: '10.0.1.1', load: { available: 4, assigned: 0, suspended: 0 } })
    a.registerHost({ ...REG, hostId: 'h2', meshIp: '10.0.1.2', load: { available: 1, assigned: 3, suspended: 0 } })
    const b = pod('b')
    b.registerHost({ ...REG, hostId: 'h1', meshIp: '10.0.1.1', load: { available: 1, assigned: 3, suspended: 0 } })
    b.registerHost({ ...REG, hostId: 'h2', meshIp: '10.0.1.2', load: { available: 4, assigned: 0, suspended: 0 } })

    const winner = a.getMetalPublishedUrl('p-cold', 'cold-site')
    while (!assigns.some((x) => x.pod === 'a')) await Bun.sleep(5)
    const loser = await b.getMetalPublishedUrl('p-cold', 'cold-site')
    finishWinnerBoot()
    await winner

    expect(loser.hostId).toBe('h1')
    expect(new Set(assigns.map((x) => x.host))).toEqual(new Set(['10.0.1.1']))
  })
})
