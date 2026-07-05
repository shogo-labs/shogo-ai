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
    await c.getMetalProjectUrl('p1')
    // both calls hit whichever host was chosen first
    expect(seen[0]).toBe(seen[1])
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
