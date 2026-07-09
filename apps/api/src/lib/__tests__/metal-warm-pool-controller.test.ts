// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { MetalWarmPoolController, NoMetalHostError } from '../metal-warm-pool-controller'
import { MetalPlacementRegistry, _setMetalPlacementRegistry } from '../metal-placement-registry'
import { isMetalEnabled, isMetalEligibleProject, rolloutBucket } from '../metal-eligibility'

const REG = {
  hostId: 'ash-1',
  meshIp: '10.8.0.2',
  agentPort: 9900,
  region: 'us',
  arch: 'x64',
  capacity: { poolSize: 4, memMiB: 2048, vcpus: 2 },
  load: { available: 1, assigned: 0, suspended: 0 },
}

function fakeEnv() {
  return async () => ({ PROJECT_ID: 'p' })
}

describe('MetalWarmPoolController', () => {
  // Isolate the shared placement registry (lease/placement state) per test so
  // reused projectIds don't leak state between cases. In prod this is Redis-
  // backed and shared across replicas; here it's a fresh in-memory instance.
  beforeEach(() => {
    _setMetalPlacementRegistry(new MetalPlacementRegistry(() => null))
  })
  afterEach(() => {
    _setMetalPlacementRegistry(null)
  })

  it('throws NoMetalHostError when no host has registered', async () => {
    const c = new MetalWarmPoolController(fakeEnv(), (async () => new Response()) as any)
    await expect(c.getMetalProjectUrl('p1')).rejects.toBeInstanceOf(NoMetalHostError)
  })

  it('assigns via a live host and records a cold-miss', async () => {
    let body: any
    const fetchImpl = (async (url: string, init: any) => {
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({ url: 'http://10.8.0.2:8080', mode: 'assigned' }), { status: 200 })
    }) as any
    const c = new MetalWarmPoolController(fakeEnv(), fetchImpl)
    c.registerHost(REG)

    const url = await c.getMetalProjectUrl('p1')
    expect(url).toBe('http://10.8.0.2:8080')
    expect(body.projectId).toBe('p1')

    const status = c.getStatus()
    expect(status.stats.assigned).toBe(1)
    expect(status.stats.coldMiss).toBe(1)
    expect(status.stats.snapshotHitRate).toBe(0) // 0 resumes / (0+1)
    expect(status.projects).toBe(1)
  })

  it('records a resume (snapshot hit) with wake latency', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ url: 'http://10.8.0.2:8080', mode: 'resumed', source: 'local', readyMs: 42 }), {
        status: 200,
      })) as any
    const c = new MetalWarmPoolController(fakeEnv(), fetchImpl)
    c.registerHost(REG)

    await c.getMetalProjectUrl('p1')
    const status = c.getStatus()
    expect(status.stats.resumed).toBe(1)
    expect(status.stats.coldMiss).toBe(0)
    expect(status.stats.snapshotHitRate).toBe(1)
  })

  it('is sticky: a project returns to the same host', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(new URL(url).host)
      return new Response(JSON.stringify({ url: 'http://guest:8080', mode: 'resumed', source: 'local' }), { status: 200 })
    }) as any
    const c = new MetalWarmPoolController(fakeEnv(), fetchImpl)
    c.registerHost({ ...REG, hostId: 'ash-1', meshIp: '10.8.0.2' })
    c.registerHost({ ...REG, hostId: 'ash-2', meshIp: '10.8.0.3' })

    await c.getMetalProjectUrl('p1')
    // Force a real re-resolve (the 2nd call would otherwise hit the URL cache).
    c.invalidateUrlCache('p1')
    await c.getMetalProjectUrl('p1')
    // both calls hit whichever host was chosen first
    expect(seen[0]).toBe(seen[1])
  })

  it('serves a repeat resolve from the URL cache without re-hitting the host', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(JSON.stringify({ url: 'http://g:8080', mode: 'assigned' }), { status: 200 })
    }) as any
    const c = new MetalWarmPoolController(fakeEnv(), fetchImpl)
    c.registerHost(REG)

    const a = await c.getMetalProjectUrl('p1')
    const b = await c.getMetalProjectUrl('p1') // cache hit — no /assign
    expect(a).toBe(b)
    expect(calls).toBe(1)
    const s = c.getStatus()
    expect(s.stats.cacheHit).toBe(1)
    expect(s.stats.coldMiss).toBe(1) // only the first (real) resolve is a cold miss

    // Invalidating forces the next resolve back to the host.
    c.invalidateUrlCache('p1')
    await c.getMetalProjectUrl('p1')
    expect(calls).toBe(2)
  })

  it('records an already-running re-attach (reused) as a warm hit, not a cold miss', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ url: 'http://g:8080', mode: 'assigned', reused: true }), {
        status: 200,
      })) as any
    const c = new MetalWarmPoolController(fakeEnv(), fetchImpl)
    c.registerHost(REG)

    await c.getMetalProjectUrl('p1')
    const s = c.getStatus()
    expect(s.stats.reused).toBe(1)
    expect(s.stats.coldMiss).toBe(0)
    expect(s.stats.assigned).toBe(0)
    expect(s.stats.warmHitRate).toBe(1) // avoided a cold boot
    expect(s.stats.snapshotHitRate).toBe(null) // not a snapshot resume either
  })

  it('a stop invalidates the cached URL so the next open re-resolves', async () => {
    let calls = 0
    const fetchImpl = (async (url: string) => {
      calls++
      const p = new URL(url).pathname
      if (p === '/stop') return new Response(JSON.stringify({ suspended: true }), { status: 200 })
      return new Response(JSON.stringify({ url: 'http://g:8080', mode: 'assigned' }), { status: 200 })
    }) as any
    const c = new MetalWarmPoolController(fakeEnv(), fetchImpl)
    c.registerHost(REG)

    await c.getMetalProjectUrl('p1') // assign (calls=1)
    await c.stopProject('p1') // stop (calls=2) — drops the cache
    await c.getMetalProjectUrl('p1') // must re-assign (calls=3), not serve stale
    expect(calls).toBe(3)
  })

  it('cordon drains: a cordoned host takes no new placements', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(new URL(url).hostname)
      return new Response(JSON.stringify({ url: 'http://guest:8080', mode: 'assigned' }), { status: 200 })
    }) as any
    const c = new MetalWarmPoolController(fakeEnv(), fetchImpl)
    c.registerHost({ ...REG, hostId: 'ash-1', meshIp: '10.8.0.2' })
    c.registerHost({ ...REG, hostId: 'ash-2', meshIp: '10.8.0.3' })

    await c.setHostCordon('ash-1', true)
    // Every new placement must avoid the cordoned host.
    await c.getMetalProjectUrl('p1')
    await c.getMetalProjectUrl('p2')
    await c.getMetalProjectUrl('p3')
    expect(seen.every((h) => h === '10.8.0.3')).toBe(true)

    const fleet = await c.getFleetStatus()
    expect(fleet.hosts.find((h) => h.hostId === 'ash-1')?.cordoned).toBe(true)
    expect(fleet.hosts.find((h) => h.hostId === 'ash-2')?.cordoned).toBe(false)

    // Uncordon restores eligibility.
    await c.setHostCordon('ash-1', false)
    const fleet2 = await c.getFleetStatus()
    expect(fleet2.hosts.find((h) => h.hostId === 'ash-1')?.cordoned).toBe(false)
  })

  it('cordoning the only host yields NoMetalHostError', async () => {
    const c = new MetalWarmPoolController(fakeEnv(), (async () => new Response()) as any)
    c.registerHost(REG)
    await c.setHostCordon('ash-1', true)
    await expect(c.getMetalProjectUrl('p1')).rejects.toBeInstanceOf(NoMetalHostError)
  })

  it('fails over to another host when the first errors, dropping stickiness', async () => {
    let calls = 0
    const fetchImpl = (async (url: string) => {
      calls++
      if (new URL(url).host === '10.8.0.2:9900') throw new Error('conn refused')
      return new Response(JSON.stringify({ url: 'http://guest:8080', mode: 'assigned' }), { status: 200 })
    }) as any
    const c = new MetalWarmPoolController(fakeEnv(), fetchImpl)
    c.registerHost({ ...REG, hostId: 'ash-1', meshIp: '10.8.0.2', load: { available: 1, assigned: 0, suspended: 0 } })
    c.registerHost({ ...REG, hostId: 'ash-2', meshIp: '10.8.0.3', load: { available: 1, assigned: 5, suspended: 0 } })

    const url = await c.getMetalProjectUrl('p1')
    expect(url).toBe('http://guest:8080')
    expect(calls).toBe(2) // first host threw, second succeeded
    expect(c.getStatus().stats.hostErrors).toBe(1)
  })

  it('treats hosts past the TTL as not live', async () => {
    let clock = 1_000_000
    const fetchImpl = (async () => new Response(JSON.stringify({ url: 'http://g:8080' }), { status: 200 })) as any
    const c = new MetalWarmPoolController(fakeEnv(), fetchImpl, () => clock)
    c.registerHost(REG)
    expect(c.liveHosts().length).toBe(1)
    clock += 91_000 // > default 90s TTL
    expect(c.liveHosts().length).toBe(0)
    await expect(c.getMetalProjectUrl('p1')).rejects.toBeInstanceOf(NoMetalHostError)
  })

  it('resolves via a host known only through the shared registry (cross-replica)', async () => {
    // Simulate a multi-replica deployment: the node-agent's heartbeat landed on
    // a SIBLING api pod, so this controller never saw registerHost() — but the
    // sibling published the host to the shared registry. Without registry-aware
    // discovery this would NoMetalHostError and (in metal-only mode) 503.
    const shared = new MetalPlacementRegistry(() => null)
    _setMetalPlacementRegistry(shared)
    await shared.upsertHost({ ...REG, lastSeenAt: Date.now() })

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ url: 'http://10.8.0.2:8080', mode: 'assigned' }), { status: 200 })) as any
    // NOTE: no c.registerHost(...) — this pod has an empty in-memory host map.
    const c = new MetalWarmPoolController(fakeEnv(), fetchImpl, Date.now, shared)
    expect(c.liveHosts().length).toBe(0) // in-memory view is empty
    expect(await c.liveHostCount()).toBe(1) // but the fleet view sees the sibling's host

    const url = await c.getMetalProjectUrl('p1')
    expect(url).toBe('http://10.8.0.2:8080')
  })

  it('dedupes concurrent resolves for the same project', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      await new Promise((r) => setTimeout(r, 10))
      return new Response(JSON.stringify({ url: 'http://g:8080', mode: 'assigned' }), { status: 200 })
    }) as any
    const c = new MetalWarmPoolController(fakeEnv(), fetchImpl)
    c.registerHost(REG)
    const [a, b] = await Promise.all([c.getMetalProjectUrl('p1'), c.getMetalProjectUrl('p1')])
    expect(a).toBe(b)
    expect(calls).toBe(1)
  })
})

describe('metal eligibility', () => {
  const orig = { ...process.env }
  beforeEach(() => {
    delete process.env.SHOGO_METAL_ENABLED
    delete process.env.METAL_PROJECT_ALLOWLIST
    delete process.env.METAL_ROLLOUT_PERCENT
  })
  afterEach(() => {
    process.env.SHOGO_METAL_ENABLED = orig.SHOGO_METAL_ENABLED
    process.env.METAL_PROJECT_ALLOWLIST = orig.METAL_PROJECT_ALLOWLIST
    process.env.METAL_ROLLOUT_PERCENT = orig.METAL_ROLLOUT_PERCENT
  })

  it('is disabled by default', () => {
    expect(isMetalEnabled()).toBe(false)
  })

  it('honours the global enable flag', () => {
    process.env.SHOGO_METAL_ENABLED = 'true'
    expect(isMetalEnabled()).toBe(true)
  })

  it('allowlist forces eligibility regardless of rollout percent', () => {
    process.env.METAL_PROJECT_ALLOWLIST = 'a, b ,c'
    expect(isMetalEligibleProject('b')).toBe(true)
    expect(isMetalEligibleProject('z')).toBe(false)
  })

  it('percentage rollout is stable per project', () => {
    process.env.METAL_ROLLOUT_PERCENT = '100'
    expect(isMetalEligibleProject('anything')).toBe(true)
    process.env.METAL_ROLLOUT_PERCENT = '0'
    expect(isMetalEligibleProject('anything')).toBe(false)
    // deterministic bucketing
    expect(rolloutBucket('proj-x')).toBe(rolloutBucket('proj-x'))
    expect(rolloutBucket('proj-x')).toBeGreaterThanOrEqual(0)
    expect(rolloutBucket('proj-x')).toBeLessThan(100)
  })
})
