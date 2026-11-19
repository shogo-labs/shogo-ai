// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * QA acceptance tests for SHO-444 on the control plane.
 *
 * The card's rule is that capacity, the idle tier, placement order and the
 * burst scaler count ACTIVE VMs only — an idle-resident VM is evictable, so it
 * is free room, not demand. These tests drive the controller the way the
 * super-admin fleet endpoint and the burst reconciler do, and pin the
 * back-compat direction: an agent that predates the residency split must be
 * treated as busier than it may be, never as emptier.
 *
 * Run: bun test apps/api/src/__tests__/qa-sho444-active-capacity.acceptance.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  MetalWarmPoolController,
  _setAgentRestartRetry,
  activeLoad,
} from '../lib/metal-warm-pool-controller'
import { _setMetalPlacementRegistry, MetalPlacementRegistry } from '../lib/metal-placement-registry'

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

/** A host that reports the residency split: `assigned` resident, `active` in use. */
function host(hostId: string, meshIp: string, assigned: number, active: number | undefined) {
  return {
    ...REG,
    hostId,
    meshIp,
    load: {
      available: 0,
      assigned,
      suspended: 0,
      ...(active === undefined ? {} : { active, evictable: assigned - active }),
    },
  }
}

describe('SHO-444 — activeLoad falls back to assigned for an old agent', () => {
  it('uses `active` when the host reports it', () => {
    expect(activeLoad({ load: { assigned: 200, active: 3 } })).toBe(3)
  })

  it('falls back to `assigned` when it does not — busier than it may be, never emptier', () => {
    expect(activeLoad({ load: { assigned: 200 } })).toBe(200)
    expect(activeLoad({})).toBe(0)
  })
})

describe('SHO-444 — the fleet figures the super-admin panel reads', () => {
  beforeEach(() => {
    _setMetalPlacementRegistry(new MetalPlacementRegistry(() => null))
  })
  afterEach(() => {
    _setMetalPlacementRegistry(null)
    _setAgentRestartRetry(null)
  })

  it('getFleetStatus() reports active / evictable / activeUtilPct per host', async () => {
    const c = new MetalWarmPoolController(fakeEnv(), (async () => new Response()) as any)
    c.registerHost(host('ash-1', '10.8.0.2', 40, 4))
    c.registerHost(host('ash-2', '10.8.0.3', 40, undefined))

    const fleet = await c.getFleetStatus()
    const split = fleet.hosts.find((h) => h.hostId === 'ash-1')!
    expect(split.active).toBe(4)
    expect(split.evictable).toBe(36)
    expect(split.activeUtilPct).toBe(Math.round((4 / 80) * 100))
    // The assigned-based figure is kept beside it, so the gap IS the bucket.
    expect(split.utilPct).toBe(split.activeUtilPct)

    // An old agent: every resident VM counts as load, exactly as before.
    const old = fleet.hosts.find((h) => h.hostId === 'ash-2')!
    expect(old.active).toBe(40)
    expect(old.evictable).toBe(0)
    expect(old.activeUtilPct).toBe(Math.round((40 / 80) * 100))
  })
})

describe('SHO-444 — placement prefers the host that is actually idle', () => {
  beforeEach(() => {
    _setMetalPlacementRegistry(new MetalPlacementRegistry(() => null))
  })
  afterEach(() => {
    _setMetalPlacementRegistry(null)
    _setAgentRestartRetry(null)
  })

  it('a host holding 200 warm VMs of which 0 are in use beats a host with 5 in use', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/status')) return Response.json({ state: 'none' })
      seen.push(new URL(url).hostname)
      return new Response(JSON.stringify({ url: 'http://guest:8080', mode: 'assigned' }), { status: 200 })
    }) as any
    const c = new MetalWarmPoolController(fakeEnv(), fetchImpl)
    // 200 resident but nothing in use — the bucket's whole point.
    c.registerHost(host('warm', '10.8.0.2', 200, 0))
    // 5 resident, all in use.
    c.registerHost(host('busy', '10.8.0.3', 5, 5))

    await c.getMetalProjectUrl('p1')

    expect(seen).toEqual(['10.8.0.2'])
  })

  it('an old agent is still ordered by its resident count, as today', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/status')) return Response.json({ state: 'none' })
      seen.push(new URL(url).hostname)
      return new Response(JSON.stringify({ url: 'http://guest:8080', mode: 'assigned' }), { status: 200 })
    }) as any
    const c = new MetalWarmPoolController(fakeEnv(), fetchImpl)
    c.registerHost(host('full', '10.8.0.2', 200, undefined))
    c.registerHost(host('empty', '10.8.0.3', 5, undefined))

    await c.getMetalProjectUrl('p1')

    expect(seen).toEqual(['10.8.0.3'])
  })
})

describe('SHO-444 — the idle tier counts active VMs, not resident ones', () => {
  beforeEach(() => {
    _setMetalPlacementRegistry(new MetalPlacementRegistry(() => null))
  })
  afterEach(() => {
    _setMetalPlacementRegistry(null)
    _setAgentRestartRetry(null)
  })

  it('a region full of evictable VMs stays RELAXED', async () => {
    const c = new MetalWarmPoolController(fakeEnv(), (async () => new Response()) as any)
    // 3 hosts × 80 slots = 240 capacity; 200 resident but only 6 in use = 3%.
    c.registerHost(host('a', '10.8.0.2', 70, 2))
    c.registerHost(host('b', '10.8.0.3', 70, 2))
    c.registerHost(host('c', '10.8.0.4', 60, 2))

    const d = await c.idleDirectiveFor('us', undefined)

    expect(d.tier).toBe('relaxed')
  })

  it('the same region goes AGGRESSIVE once the ACTIVE VMs are hot', async () => {
    const c = new MetalWarmPoolController(fakeEnv(), (async () => new Response()) as any)
    // Same 200 resident, but now 200 in use = 83% of capacity.
    c.registerHost(host('a', '10.8.0.2', 70, 70))
    c.registerHost(host('b', '10.8.0.3', 70, 70))
    c.registerHost(host('c', '10.8.0.4', 60, 60))

    const d = await c.idleDirectiveFor('us', undefined)

    expect(d.tier).toBe('aggressive')
  })

  it('an old agent still drives the tier from its resident count', async () => {
    const c = new MetalWarmPoolController(fakeEnv(), (async () => new Response()) as any)
    c.registerHost(host('a', '10.8.0.2', 70, undefined))
    c.registerHost(host('b', '10.8.0.3', 70, undefined))
    c.registerHost(host('c', '10.8.0.4', 60, undefined))

    const d = await c.idleDirectiveFor('us', undefined)

    expect(d.tier).toBe('aggressive')
  })
})
