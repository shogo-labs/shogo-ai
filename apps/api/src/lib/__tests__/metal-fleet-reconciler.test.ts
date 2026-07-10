// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for the metal fleet reconciler's PURE planning function — the brain
 * that turns desired + live + burst state into scale actions. No I/O; we feed
 * snapshots and assert the plan. The actuation wiring (provider calls, registry
 * writes, leader lease) is deliberately thin around this and gated by env flags.
 */

import { describe, expect, it } from 'bun:test'
import { planReconcile, type ReconcileSnapshot } from '../metal-fleet-reconciler'
import { MAX_VMS_PER_HOST } from '../metal-warm-pool-controller'
import type { MetalFleetEnv } from '../../config/metal-fleet'

// >70% of a single host's real capacity → "hot" enough to trigger burst scale-up.
const HOT = Math.ceil(MAX_VMS_PER_HOST * 0.75)

const DESIRED: MetalFleetEnv = {
  baseline: [
    { hostId: 'latitude-dal-1', region: 'us', site: 'DAL', billing: 'monthly' },
    { hostId: 'latitude-dal-2', region: 'us', site: 'DAL', billing: 'monthly' },
    { hostId: 'latitude-fra-1', region: 'eu', site: 'FRA', billing: 'monthly' },
  ],
  burst: {
    enabled: true,
    plan: 's3-large-x86',
    billing: 'hourly',
    maxPerRegion: 2,
    scaleUpUtilPct: 70,
    scaleDownUtilPct: 40,
    cooldownSec: 900,
  },
}

// `poolSize` is the host's WARM-POOL target (idle pre-boot count); it is NOT the
// utilization denominator — capacity is MAX_VMS_PER_HOST per live host. `assigned`
// is the count of live microVMs, i.e. the numerator.
function host(hostId: string, region: string, poolSize: number, assigned: number): any {
  return { hostId, region, capacity: { poolSize }, load: { assigned } }
}

function snap(over: Partial<ReconcileSnapshot>): ReconcileSnapshot {
  return {
    now: 1_000_000_000,
    desired: DESIRED,
    live: [],
    burst: [],
    lastScaleAt: {},
    ...over,
  }
}

describe('planReconcile — baseline drift', () => {
  it('flags every desired baseline host that is not live', () => {
    const plan = planReconcile(snap({ live: [host('latitude-dal-1', 'us', 24, 0)] }))
    const missing = plan.actions.filter((a) => a.kind === 'baseline_missing').map((a: any) => a.hostId)
    expect(missing.sort()).toEqual(['latitude-dal-2', 'latitude-fra-1'])
  })
})

describe('planReconcile — scale up', () => {
  it('adds a burst host when a region is hot and under the cap', () => {
    // us: HOT/MAX_VMS_PER_HOST = 75% > 70%
    const plan = planReconcile(snap({ live: [host('latitude-dal-1', 'us', 24, HOT)] }))
    const up = plan.actions.find((a) => a.kind === 'scale_up') as any
    expect(up).toBeTruthy()
    expect(up.region).toBe('us')
    expect(up.site).toBe('DAL')
  })

  it('does NOT scale up past maxPerRegion', () => {
    const plan = planReconcile(
      snap({
        live: [host('latitude-dal-1', 'us', 24, HOT)],
        burst: [
          { hostId: 'b1', serverId: 'sv_1', region: 'us', site: 'DAL', createdAt: 1 },
          { hostId: 'b2', serverId: 'sv_2', region: 'us', site: 'DAL', createdAt: 2 },
        ],
      }),
    )
    expect(plan.actions.find((a) => a.kind === 'scale_up')).toBeUndefined()
  })

  it('respects the cooldown window', () => {
    const now = 1_000_000_000
    const plan = planReconcile(
      snap({
        now,
        live: [host('latitude-dal-1', 'us', 24, HOT)],
        lastScaleAt: { us: now - 100_000 }, // 100s ago < 900s cooldown
      }),
    )
    expect(plan.actions.find((a) => a.kind === 'scale_up')).toBeUndefined()
    const us = plan.regions.find((r) => r.region === 'us')!
    expect(us.cooldownRemainingMs).toBeGreaterThan(0)
  })

  it('does nothing when burst is disabled', () => {
    const desired = { ...DESIRED, burst: { ...DESIRED.burst, enabled: false } }
    const plan = planReconcile(snap({ desired, live: [host('latitude-dal-1', 'us', 24, HOT)] }))
    expect(plan.actions.some((a) => a.kind === 'scale_up')).toBe(false)
  })
})

describe('planReconcile — scale down (drain-first, two phase)', () => {
  it('cordons the NEWEST active burst host when the region is cool', () => {
    const plan = planReconcile(
      snap({
        live: [host('latitude-dal-1', 'us', 24, 2), host('b-old', 'us', 24, 0), host('b-new', 'us', 24, 0)],
        burst: [
          { hostId: 'b-old', serverId: 'sv_old', region: 'us', site: 'DAL', createdAt: 10 },
          { hostId: 'b-new', serverId: 'sv_new', region: 'us', site: 'DAL', createdAt: 20 },
        ],
      }),
    )
    const cordon = plan.actions.find((a) => a.kind === 'cordon_for_drain') as any
    expect(cordon).toBeTruthy()
    expect(cordon.hostId).toBe('b-new') // newest first
  })

  it('destroys a draining burst host once it reports 0 assigned', () => {
    const plan = planReconcile(
      snap({
        live: [host('latitude-dal-1', 'us', 24, 2), host('b-new', 'us', 24, 0)],
        burst: [{ hostId: 'b-new', serverId: 'sv_new', region: 'us', site: 'DAL', createdAt: 20, drainingSince: 5 }],
      }),
    )
    const destroy = plan.actions.find((a) => a.kind === 'destroy_drained') as any
    expect(destroy).toBeTruthy()
    expect(destroy.serverId).toBe('sv_new')
  })

  it('does NOT destroy a draining host that still has assigned projects', () => {
    const plan = planReconcile(
      snap({
        live: [host('latitude-dal-1', 'us', 24, 2), host('b-new', 'us', 24, 3)],
        burst: [{ hostId: 'b-new', serverId: 'sv_new', region: 'us', site: 'DAL', createdAt: 20, drainingSince: 5 }],
      }),
    )
    expect(plan.actions.find((a) => a.kind === 'destroy_drained')).toBeUndefined()
  })

  it('destroys a draining host that has fallen out of the live set', () => {
    const plan = planReconcile(
      snap({
        live: [host('latitude-dal-1', 'us', 24, 2)], // b-new no longer live
        burst: [{ hostId: 'b-new', serverId: 'sv_new', region: 'us', site: 'DAL', createdAt: 20, drainingSince: 5 }],
      }),
    )
    expect(plan.actions.find((a) => a.kind === 'destroy_drained')).toBeTruthy()
  })
})

describe('planReconcile — region assessment', () => {
  it('computes utilization across a region as assigned ÷ (liveHosts × MAX_VMS_PER_HOST)', () => {
    const assigned = 6
    const plan = planReconcile(snap({ live: [host('latitude-dal-1', 'us', 24, assigned)] }))
    const us = plan.regions.find((r) => r.region === 'us')!
    expect(us.utilPct).toBe(Math.round((assigned / MAX_VMS_PER_HOST) * 100))
    expect(plan.actions.some((a) => a.kind === 'scale_up' || a.kind === 'cordon_for_drain')).toBe(false)
  })
})
