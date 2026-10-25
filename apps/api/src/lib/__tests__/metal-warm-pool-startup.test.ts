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

describe('MetalWarmPoolController — startup', () => {
  it('spreads cold opens instead of sending every new project to the slightly lighter host', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/status')) return Response.json({ state: 'none' })
      seen.push(new URL(url).hostname)
      return Response.json({ url: 'http://g:8080', mode: 'assigned' })
    }) as any
    const c = new MetalWarmPoolController(fakeEnv(), fetchImpl, Date.now, new MetalPlacementRegistry(() => null))
    c.registerHost({ ...REG, hostId: 'dal-1', meshIp: '10.0.0.2', load: { available: 6, assigned: 0, suspended: 0 } })
    c.registerHost({ ...REG, hostId: 'dal-2', meshIp: '10.0.0.3', load: { available: 6, assigned: 1, suspended: 0 } })

    await c.getMetalProjectUrl('new-1')
    await c.getMetalProjectUrl('new-2')
    expect(seen).toEqual(['10.0.0.2', '10.0.0.3'])
  })

  it('a warm re-attach is not a cold open and does not move later placements', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/status')) return Response.json({ state: 'none' })
      seen.push(new URL(url).hostname)
      return Response.json({ url: 'http://g:8080', mode: 'assigned', reused: true })
    }) as any
    const c = new MetalWarmPoolController(fakeEnv(), fetchImpl, Date.now, new MetalPlacementRegistry(() => null))
    c.registerHost({ ...REG, hostId: 'dal-1', meshIp: '10.0.0.2', load: { available: 6, assigned: 0, suspended: 0 } })
    c.registerHost({ ...REG, hostId: 'dal-2', meshIp: '10.0.0.3', load: { available: 6, assigned: 1, suspended: 0 } })

    await c.getMetalProjectUrl('live-1')
    await c.getMetalProjectUrl('live-2')
    expect(seen).toEqual(['10.0.0.2', '10.0.0.2'])
  })

  it('consumes the wait start a timed-out attempt left, so one open is measured once', async () => {
    const registry = new MetalPlacementRegistry(() => null)
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/status')) return Response.json({ state: 'none' })
      return Response.json({
        url: 'http://g:8080',
        mode: 'assigned',
        reused: true,
        lateWake: { mode: 'assigned', phases: { hydrate_repo: 120_000 }, totalMs: 150_000 },
      })
    }) as any
    const c = new MetalWarmPoolController(fakeEnv(), fetchImpl, Date.now, registry)
    c.registerHost({ ...REG, hostId: 'dal-1', meshIp: '10.0.0.2' })

    await registry.markWakeStart('slow', Date.now() - 150_000)
    await c.getMetalProjectUrl('slow')
    expect(await registry.takeWakeStart('slow')).toBeNull()
  })
})

describe('MetalPlacementRegistry — wake start', () => {
  it('keeps the first attempt and hands it out once', async () => {
    const r = new MetalPlacementRegistry(() => null)
    await r.markWakeStart('k', 1_000)
    await r.markWakeStart('k', 2_000)
    expect(await r.takeWakeStart('k', 5_000)).toBe(1_000)
    expect(await r.takeWakeStart('k', 5_000)).toBeNull()
  })

  it('forgets a start older than any open', async () => {
    const r = new MetalPlacementRegistry(() => null)
    await r.markWakeStart('k', 0)
    expect(await r.takeWakeStart('k', 31 * 60_000)).toBeNull()
  })
})
