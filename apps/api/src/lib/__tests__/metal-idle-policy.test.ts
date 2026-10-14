// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, it } from 'bun:test'
import { decideIdleTier, idleDirective, idlePolicyConfig, type IdlePolicyConfig } from '../metal-idle-policy'
import { MAX_VMS_PER_HOST, MetalWarmPoolController } from '../metal-warm-pool-controller'
import { MetalPlacementRegistry } from '../metal-placement-registry'

const CFG: IdlePolicyConfig = { relaxedMs: 4 * 3600_000, aggressiveMs: 15 * 60_000, thresholdPct: 60, hysteresisPct: 5 }

describe('decideIdleTier', () => {
  it('is relaxed under the threshold and aggressive at or above it', () => {
    expect(decideIdleTier(0, undefined, CFG)).toBe('relaxed')
    expect(decideIdleTier(59, undefined, CFG)).toBe('relaxed')
    expect(decideIdleTier(60, undefined, CFG)).toBe('aggressive')
    expect(decideIdleTier(95, 'relaxed', CFG)).toBe('aggressive')
  })

  it('holds aggressive until utilization drops below threshold minus hysteresis', () => {
    expect(decideIdleTier(58, 'aggressive', CFG)).toBe('aggressive')
    expect(decideIdleTier(55, 'aggressive', CFG)).toBe('aggressive')
    expect(decideIdleTier(54, 'aggressive', CFG)).toBe('relaxed')
    // A relaxed host in the band stays relaxed.
    expect(decideIdleTier(58, 'relaxed', CFG)).toBe('relaxed')
  })

  it('maps the tier onto its window', () => {
    expect(idleDirective(10, undefined, CFG, 1)).toEqual({ idleMs: CFG.relaxedMs, tier: 'relaxed', fleetUtilPct: 10, computedAt: 1 })
    expect(idleDirective(70, undefined, CFG, 2).idleMs).toBe(CFG.aggressiveMs)
  })
})

describe('idlePolicyConfig', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('defaults to 4h relaxed / 15m aggressive at 60%', () => {
    delete process.env.METAL_IDLE_RELAXED_MS
    delete process.env.METAL_IDLE_AGGRESSIVE_MS
    delete process.env.METAL_IDLE_FLEET_PCT
    expect(idlePolicyConfig()).toEqual({ relaxedMs: 14_400_000, aggressiveMs: 900_000, thresholdPct: 60, hysteresisPct: 5 })
  })

  it('reads overrides and ignores garbage', () => {
    process.env.METAL_IDLE_RELAXED_MS = '3600000'
    process.env.METAL_IDLE_FLEET_PCT = 'nope'
    const c = idlePolicyConfig()
    expect(c.relaxedMs).toBe(3_600_000)
    expect(c.thresholdPct).toBe(60)
  })
})

describe('MetalWarmPoolController.idleDirectiveFor', () => {
  const host = (hostId: string, region: string, assigned: number) => ({
    hostId,
    meshIp: '10.8.0.2',
    agentPort: 9900,
    region,
    arch: 'x64',
    capacity: { poolSize: 4, memMiB: 2048, vcpus: 2 },
    load: { available: 1, assigned, suspended: 0 },
  })

  it('computes utilization per region across that region only', async () => {
    const c = new MetalWarmPoolController(
      async () => ({}),
      (async () => new Response()) as any,
      Date.now,
      new MetalPlacementRegistry(() => null),
    )
    const busy = Math.ceil(MAX_VMS_PER_HOST * 0.9)
    c.registerHost(host('us-1', 'us', busy))
    c.registerHost(host('us-2', 'us', busy))
    c.registerHost(host('eu-1', 'eu', 0))

    const us = await c.idleDirectiveFor('us', undefined)
    expect(us.tier).toBe('aggressive')
    expect(us.fleetUtilPct).toBe(Math.round((busy / MAX_VMS_PER_HOST) * 100))

    const eu = await c.idleDirectiveFor('eu', 'aggressive')
    expect(eu.tier).toBe('relaxed')
    expect(eu.fleetUtilPct).toBe(0)
  })
})
