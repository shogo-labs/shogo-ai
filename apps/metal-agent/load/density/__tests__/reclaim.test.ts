// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for the idle-reclaim measurement helpers (SHO-553 AC2).
 *
 * Everything here is pure: no host, no network, no proc filesystem.
 * - `idleMemoryPoint` — the 10/30-min per-idle-VM soak-delta + VmRSS numbers
 * - `balloonedVms / balloonedIdleMiB` — which VMs the balloon inflated
 * - `pickWakeTargets` — which VMs to probe on wake
 * - `summarizeWake` — p50/p95 and the +100 ms budget
 * - `reclaimSummary` — roll-up from per-step marks
 * - `idleVmStates` — join from /vms assigned[] + per-pid RSS
 */

import { describe, expect, test } from 'bun:test'
import {
  WAKE_P95_BUDGET_MS,
  WAKE_PROBE_MIN,
  balloonedIdleMiB,
  balloonedVms,
  idleMemoryPoint,
  idleVmStates,
  pickWakeTargets,
  reclaimSummary,
  summarizeWake,
  type IdleVmState,
} from '../reclaim'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function vm(override: Partial<IdleVmState> = {}): IdleVmState {
  return {
    projectId: `proj-${Math.random().toString(36).slice(2)}`,
    role: 'idle',
    balloonedMiB: 0,
    fcRssMiB: 128,
    assignedAtMs: 0,
    ...override,
  }
}

// ---------------------------------------------------------------------------
// idleMemoryPoint
// ---------------------------------------------------------------------------

describe('idleMemoryPoint', () => {
  test('computes soak-delta per VM and VmRSS - balloon mean for settled VMs', () => {
    const nowMs = 15 * 60_000 // 15 min into hold
    // Two idle VMs assigned from t=0 (settled for 10 min).
    const vms: IdleVmState[] = [
      vm({ role: 'idle', balloonedMiB: 50, fcRssMiB: 200, assignedAtMs: 0 }),
      vm({ role: 'idle', balloonedMiB: 30, fcRssMiB: 160, assignedAtMs: 0 }),
    ]
    const point = idleMemoryPoint({
      minutes: 10,
      nowMs,
      rssBeforeMiB: 100,
      soakRssMiB: 460, // 100 (before) + 360 (soak), delta = 360
      soakVms: 2,
      vms,
    })
    // soak-delta per VM: (460-100)/2 = 180
    expect(point.soakDeltaPerVmMiB).toBe(180)
    // VmRSS - balloon: (200-50 + 160-30) / 2 = 140
    expect(point.vmVmRssMinusBalloonMiB).toBe(140)
    expect(point.idleVms).toBe(2)
    expect(point.soakVms).toBe(2)
    expect(point.minutes).toBe(10)
  })

  test('excludes idle VMs assigned after the interval started', () => {
    const nowMs = 10 * 60_000
    const tooNew = vm({ role: 'idle', balloonedMiB: 20, fcRssMiB: 100, assignedAtMs: 9 * 60_000 })
    const settled = vm({ role: 'idle', balloonedMiB: 20, fcRssMiB: 100, assignedAtMs: 0 })
    const point = idleMemoryPoint({
      minutes: 10,
      nowMs,
      rssBeforeMiB: 0,
      soakRssMiB: 200,
      soakVms: 2,
      vms: [tooNew, settled],
    })
    expect(point.idleVms).toBe(1)
    expect(point.vmVmRssMinusBalloonMiB).toBe(80)
  })

  test('returns null VmRSS mean when no VM has been idle long enough', () => {
    const nowMs = 5 * 60_000
    const point = idleMemoryPoint({
      minutes: 10,
      nowMs,
      rssBeforeMiB: 0,
      soakRssMiB: 100,
      soakVms: 2,
      vms: [vm({ assignedAtMs: 4 * 60_000 })],
    })
    expect(point.vmVmRssMinusBalloonMiB).toBeNull()
    expect(point.idleVms).toBe(0)
  })

  test('clamps negative soak delta to zero', () => {
    const point = idleMemoryPoint({
      minutes: 10,
      nowMs: 15 * 60_000,
      rssBeforeMiB: 500,
      soakRssMiB: 400, // host RSS went down (unusual but possible)
      soakVms: 4,
      vms: [],
    })
    expect(point.soakDeltaPerVmMiB).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// balloonedVms / balloonedIdleMiB
// ---------------------------------------------------------------------------

describe('balloonedVms', () => {
  test('returns only idle VMs with a non-zero balloon', () => {
    const vms = [
      vm({ role: 'idle', balloonedMiB: 64 }),
      vm({ role: 'idle', balloonedMiB: 0 }),
      vm({ role: 'agent', balloonedMiB: 64 }), // not idle
    ]
    const got = balloonedVms(vms)
    expect(got).toHaveLength(1)
    expect(got[0].balloonedMiB).toBe(64)
  })
})

describe('balloonedIdleMiB', () => {
  test('sums balloon sizes of reclaimed idle VMs', () => {
    const vms = [
      vm({ role: 'idle', balloonedMiB: 50 }),
      vm({ role: 'idle', balloonedMiB: 30 }),
      vm({ role: 'idle', balloonedMiB: 0 }), // not reclaimed
    ]
    expect(balloonedIdleMiB(vms)).toBe(80)
  })

  test('returns 0 when no VM has been reclaimed', () => {
    expect(balloonedIdleMiB([vm({ role: 'idle', balloonedMiB: 0 })])).toBe(0)
    expect(balloonedIdleMiB([])).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// pickWakeTargets
// ---------------------------------------------------------------------------

describe('pickWakeTargets', () => {
  test('prefers ballooned VMs, pads with non-ballooned when fewer than min', () => {
    const ballooned = [vm({ role: 'idle', balloonedMiB: 64 }), vm({ role: 'idle', balloonedMiB: 32 })]
    const unballooned = Array.from({ length: 12 }, () => vm({ role: 'idle', balloonedMiB: 0 }))
    const targets = pickWakeTargets([...ballooned, ...unballooned], WAKE_PROBE_MIN)
    expect(targets.length).toBeGreaterThanOrEqual(WAKE_PROBE_MIN)
    // Ballooned ones are included
    for (const b of ballooned) expect(targets.some((t) => t.projectId === b.projectId)).toBe(true)
  })

  test('returns all idle VMs when fewer than min are available', () => {
    const vms = [vm({ role: 'idle', balloonedMiB: 0 }), vm({ role: 'idle', balloonedMiB: 64 })]
    const targets = pickWakeTargets(vms, WAKE_PROBE_MIN)
    expect(targets).toHaveLength(2)
  })

  test('never returns non-idle VMs', () => {
    const mixed = [vm({ role: 'agent', balloonedMiB: 0 }), vm({ role: 'idle', balloonedMiB: 64 })]
    const targets = pickWakeTargets(mixed, 1)
    expect(targets.every((v) => v.role === 'idle')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// summarizeWake
// ---------------------------------------------------------------------------

describe('summarizeWake', () => {
  test('computes p50 and p95 from latencies', () => {
    const latencies = Array.from({ length: 20 }, (_, i) => (i + 1) * 10) // 10…200 ms
    const summary = summarizeWake(latencies, 0)
    expect(summary.n).toBe(20)
    expect(summary.p50Ms).toBeGreaterThan(0)
    expect(summary.p95Ms).toBeGreaterThanOrEqual(summary.p50Ms)
    expect(summary.errors).toBe(0)
    expect(summary.baselineP95Ms).toBeNull()
    expect(summary.pass).toBeNull()
  })

  test('computes delta vs baseline and fails when over budget', () => {
    // baseline p95 = 200 ms, run p95 = 400 ms → delta = +200 > 100 budget
    const latencies = Array.from({ length: 20 }, () => 400)
    const summary = summarizeWake(latencies, 0, 200)
    expect(summary.baselineP95Ms).toBe(200)
    expect(summary.deltaP95Ms).toBeGreaterThan(WAKE_P95_BUDGET_MS)
    expect(summary.pass).toBe(false)
  })

  test('passes when delta is within budget', () => {
    // baseline p95 = 400 ms, run p95 = 450 ms → delta = +50 ≤ 100 budget
    const latencies = Array.from({ length: 20 }, () => 450)
    const summary = summarizeWake(latencies, 0, 400)
    expect(summary.deltaP95Ms).toBeLessThanOrEqual(WAKE_P95_BUDGET_MS)
    expect(summary.pass).toBe(true)
  })

  test('counts timed-out probes as errors', () => {
    const summary = summarizeWake([100, 150], 3)
    expect(summary.errors).toBe(3)
    // n is the total attempted (latencies + errors)
    expect(summary.n).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// reclaimSummary
// ---------------------------------------------------------------------------

describe('reclaimSummary', () => {
  test('picks the densest step for each mark', () => {
    const steps = [
      { n: 40, idleAt10: { minutes: 10, soakDeltaPerVmMiB: 90, vmVmRssMinusBalloonMiB: 70, idleVms: 33, soakVms: 40 } },
      { n: 80, idleAt10: { minutes: 10, soakDeltaPerVmMiB: 100, vmVmRssMinusBalloonMiB: 80, idleVms: 66, soakVms: 80 } },
    ]
    const summary = reclaimSummary({ steps })
    expect(summary.at10?.soakDeltaPerVmMiB).toBe(100) // from step n=80
    expect(summary.at10?.soakVms).toBe(80)
  })

  test('returns null marks when no step measured them', () => {
    const summary = reclaimSummary({ steps: [{ n: 40 }] })
    expect(summary.at10).toBeNull()
    expect(summary.at30).toBeNull()
  })

  test('includes wake summary when provided', () => {
    const wake = summarizeWake([100, 120])
    const summary = reclaimSummary({ steps: [], wake })
    expect(summary.wake?.p50Ms).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// idleVmStates
// ---------------------------------------------------------------------------

describe('idleVmStates', () => {
  test('joins assigned[] with per-pid RSS via vmId', () => {
    const rssMap = new Map([['vm-1', 128], ['vm-2', 256]])
    const assignedAt = new Map([['proj-a', 0], ['proj-b', 1000]])
    const states = idleVmStates({
      assigned: [
        { projectId: 'proj-a', vmId: 'vm-1', balloonedMiB: 20, role: 'idle' },
        { projectId: 'proj-b', vmId: 'vm-2', balloonedMiB: 0, role: 'agent' },
      ],
      assignedAt,
      rssForVmId: (vmId) => rssMap.get(vmId) ?? null,
    })
    expect(states).toHaveLength(2)
    const a = states.find((s) => s.projectId === 'proj-a')!
    expect(a.fcRssMiB).toBe(128)
    expect(a.balloonedMiB).toBe(20)
    expect(a.role).toBe('idle')
    expect(a.assignedAtMs).toBe(0)
    const b = states.find((s) => s.projectId === 'proj-b')!
    expect(b.fcRssMiB).toBe(256)
    expect(b.role).toBe('agent')
  })

  test('sets fcRssMiB to null for VMs with no matching pid', () => {
    const states = idleVmStates({
      assigned: [{ projectId: 'proj-x', vmId: 'vm-unknown', balloonedMiB: 0, role: 'idle' }],
      assignedAt: new Map([['proj-x', 0]]),
      rssForVmId: () => null,
    })
    expect(states[0].fcRssMiB).toBeNull()
  })

  test('handles VMs with no vmId (RSS cannot be resolved)', () => {
    const states = idleVmStates({
      assigned: [{ projectId: 'proj-y', balloonedMiB: 0, role: 'idle' }],
      assignedAt: new Map([['proj-y', 0]]),
      rssForVmId: () => 999,
    })
    expect(states[0].fcRssMiB).toBeNull()
  })

  test('clamps negative balloonedMiB to zero', () => {
    const states = idleVmStates({
      assigned: [{ projectId: 'proj-z', vmId: 'vm-z', balloonedMiB: -1, role: 'idle' }],
      assignedAt: new Map([['proj-z', 0]]),
      rssForVmId: () => 100,
    })
    expect(states[0].balloonedMiB).toBe(0)
  })
})
