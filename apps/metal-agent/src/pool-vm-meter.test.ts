// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool VM meter (SHO-424) — the host half of compute billing.
 *
 * The agent's counters are CUMULATIVE per VM and never reset, so the control
 * plane can diff them against its own cursor and get away with a lost
 * heartbeat. That only works if the counters are right, which means:
 *
 *  - time lands in the class the fleet gauges report (agent > app > idle), so
 *    the bill and the dashboard can never disagree;
 *  - a VM's final tick is taken while it is still assigned, or the last seconds
 *    before a suspend vanish from the invoice;
 *  - a clock step backwards cannot subtract metered time;
 *  - closed rows survive until acked, bounded so an unacked control plane
 *    cannot grow the agent's memory without limit.
 *
 * Driven with fakes — no Firecracker, no host.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const APP_WINDOW_MS = 120_000
const MAX_CLOSED = 2_000

class TestPool extends MetalWarmPool {
  seed(projectId: string, fields: Partial<AssignedVm> & { now?: number } = {}): AssignedVm {
    const now = fields.now ?? Date.now()
    const a: AssignedVm = {
      projectId,
      handle: {
        id: `vm-${projectId}`,
        agentUrl: 'http://10.0.0.9:8080',
        guestIp: '10.0.0.9',
        vcpus: 4,
        memoryMB: 8192,
        vmClass: 'standard',
      } as any,
      assignedAt: now,
      lastTouchedAt: now,
      lastRealActivityAt: now,
      alwaysOn: false,
      cause: 'user_open',
      ...fields,
    }
    ;(this as any).assigned.set(projectId, a)
    return a
  }
  peek(projectId: string): AssignedVm | undefined {
    return (this as any).assigned.get(projectId)
  }
  meter(projectId: string) {
    return (this as any).assigned.get(projectId)?.meter
  }
  klass(projectId: string, now: number): string {
    const a = (this as any).assigned.get(projectId)
    return (this as any).vmLiveness(a, now)
  }
  suspendedIds: string[] = []
  override async suspend(projectId: string): Promise<any> {
    this.suspendedIds.push(projectId)
    ;(this as any).assigned.delete(projectId)
    return { projectId }
  }
  closedLen(): number {
    return (this as any).closedMeters.length
  }
  closedRows() {
    return (this as any).closedMeters
  }
  close(projectId: string, now?: number): void {
    const a = (this as any).assigned.get(projectId)
    ;(this as any).closeMeter(a, now)
  }
}

function makePool(dir: string): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    idleSuspendMs: 1000,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = { procCount: () => 0, isRunning: () => true } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

describe('VM meter classification', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-meter-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('an in-flight agent turn wins over app traffic', () => {
    const pool = makePool(dir)
    const now = Date.now()
    pool.seed('both', { now, activeStreams: 1, lastAppRequestAt: now })
    // Disjoint buckets: agent-active must not also count as app-active, or the
    // fleet gauges stop summing to assigned.size.
    expect(pool.klass('both', now)).toBe('agent')
  })

  test('app traffic inside the window is app-active', () => {
    const pool = makePool(dir)
    const now = Date.now()
    pool.seed('app', { now, lastAppRequestAt: now - APP_WINDOW_MS + 1 })
    expect(pool.klass('app', now)).toBe('app')
  })

  test('app traffic outside the window falls back to the idle tail', () => {
    const pool = makePool(dir)
    const now = Date.now()
    pool.seed('stale', { now, lastAppRequestAt: now - APP_WINDOW_MS - 1 })
    expect(pool.klass('stale', now)).toBe('idle')
  })

  test('a VM that never served anything is idle, not app-active', () => {
    const pool = makePool(dir)
    const now = Date.now()
    pool.seed('quiet', { now })
    expect(pool.klass('quiet', now)).toBe('idle')
  })
})

describe('VM meter accumulation', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-meter-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('advances the counter for the class the VM is in', () => {
    const pool = makePool(dir)
    const t0 = 1_000_000
    pool.seed('agentvm', { now: t0, activeStreams: 2 })
    pool.advanceMeters(t0 + 5_000)
    expect(pool.meter('agentvm')).toMatchObject({ agentMs: 5_000, appMs: 0, idleMs: 0 })

    // The stream ends; the next window is user app traffic, then idleness.
    const a = pool.peek('agentvm')!
    a.activeStreams = 0
    a.lastAppRequestAt = t0 + 5_000
    pool.advanceMeters(t0 + 8_000)
    a.lastAppRequestAt = 0
    pool.advanceMeters(t0 + 11_000)

    expect(pool.meter('agentvm')).toMatchObject({ agentMs: 5_000, appMs: 3_000, idleMs: 3_000 })
  })

  test('counters are cumulative across ticks, never reset', () => {
    const pool = makePool(dir)
    const t0 = 2_000_000
    pool.seed('cumulative', { now: t0, activeStreams: 1 })
    for (let i = 1; i <= 4; i++) pool.advanceMeters(t0 + i * 1_000)
    // A dropped heartbeat costs nothing precisely because the total keeps
    // growing instead of describing only the last interval.
    expect(pool.meter('cumulative').agentMs).toBe(4_000)
  })

  test('a clock step backwards meters nothing instead of subtracting', () => {
    const pool = makePool(dir)
    const t0 = 3_000_000
    pool.seed('backstep', { now: t0, activeStreams: 1 })
    pool.advanceMeters(t0 + 10_000)
    pool.advanceMeters(t0 - 60_000)
    const m = pool.meter('backstep')
    expect(m.agentMs).toBe(10_000)
    expect(m.idleMs).toBe(0)
    expect(m.appMs).toBe(0)
  })

  test('reports the size the host booted, not a tier default', () => {
    const pool = makePool(dir)
    const t0 = 4_000_000
    pool.seed('sized', { now: t0, activeStreams: 1 })
    pool.advanceMeters(t0 + 1_000)
    const report = pool.meterReport(t0 + 1_000)
    const row = report.vms.find((v) => v.runtimeKey === 'sized')!
    expect(row).toMatchObject({ vcpus: 4, memMiB: 8192, vmClass: 'standard', cause: 'user_open' })
  })
})

describe('closed meters', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-meter-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('takes the final tick before the VM leaves assigned', () => {
    const pool = makePool(dir)
    const t0 = 5_000_000
    pool.seed('leaving', { now: t0, activeStreams: 1 })
    pool.close('leaving', t0 + 7_000)
    const [row] = pool.closedRows()
    // Without this tick the last 7s before a suspend would never be billed.
    expect(row).toMatchObject({ runtimeKey: 'leaving', agentMs: 7_000, endedAt: t0 + 7_000 })
  })

  test('a heartbeat still reports closed rows, and an ack drops them', () => {
    const pool = makePool(dir)
    const t0 = 6_000_000
    pool.seed('done', { now: t0, activeStreams: 1 })
    pool.close('done', t0 + 1_000)

    const first = pool.meterReport(t0 + 1_000)
    expect(first.closed.map((c) => c.runtimeKey)).toEqual(['done'])
    expect(first.seq).toBeGreaterThan(0)

    // Not acked yet: the next heartbeat repeats the row, because the control
    // plane may have dropped the previous one.
    const second = pool.meterReport(t0 + 2_000)
    expect(second.closed.map((c) => c.runtimeKey)).toEqual(['done'])
    expect(second.seq).toBeGreaterThan(first.seq)

    pool.ackMeters(second.seq)
    expect(pool.closedLen()).toBe(0)
  })

  test('an ack for an older seq keeps rows created after it', () => {
    const pool = makePool(dir)
    const t0 = 7_000_000
    pool.seed('a', { now: t0, activeStreams: 1 })
    pool.seed('b', { now: t0, activeStreams: 1 })
    pool.close('a', t0 + 1_000)
    const report = pool.meterReport(t0 + 1_000)
    pool.close('b', t0 + 2_000)

    pool.ackMeters(report.seq)
    expect(pool.closedRows().map((c: any) => c.runtimeKey)).toEqual(['b'])
  })

  test('the closed list is bounded when the control plane never acks', () => {
    const pool = makePool(dir)
    const t0 = 8_000_000
    for (let i = 0; i < MAX_CLOSED + 5; i++) {
      pool.seed(`vm${i}`, { now: t0, activeStreams: 1 })
      pool.close(`vm${i}`, t0 + 1_000)
    }
    expect(pool.closedLen()).toBe(MAX_CLOSED)
  })
})

/**
 * SHO-533 — the meter and the reaper must never disagree about "idle".
 *
 * They did: `vmMeterClass` charged a VM `idle` unless a stream was open or an app
 * request had arrived within 120s, while the reaper counted a heartbeat run or a
 * background task as activity (it bumped `lastRealActivityAt` on every busy
 * poll). So a VM could be billed as idle for hours and simultaneously be
 * considered too active to suspend. Both now read `vmLiveness`.
 */
describe('SHO-533 — one classifier for bill and reaper', () => {
  let dir: string
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-meter-shared-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  const guest = (extra: Record<string, unknown>) => (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          lastRequestAt: 1,
          activeStreams: 0,
          busy: false,
          activeTurns: 0,
          liveStreams: 0,
          lastAppRequestAt: null,
          lastAgentRequestAt: null,
          ...extra,
        }),
        { status: 200 },
      ),
    )) as any

  test('an orphan activeStreams with liveStreams: 0 meters idle', () => {
    const pool = makePool(dir)
    const now = Date.now()
    const a = pool.seed('orphan', {
      now: now - 60_000,
      activeStreams: 3,
      liveStreams: 0,
      busy: false,
      perClassActivity: true,
    })
    expect(pool.klass('orphan', now)).toBe('idle')

    // The same interval the reaper counts as idle is the interval the bill does.
    a.meter = { agentMs: 0, appMs: 0, idleMs: 0, advancedAt: now - 5_000 }
    pool.advanceMeters(now)
    expect(a.meter.idleMs).toBe(5_000)
    expect(a.lastRealActivityAt).toBe(now - 60_000)
  })

  test('a busy heartbeat poll bills idle and leaves the reaper clock alone', async () => {
    const pool = makePool(dir)
    ;(pool as any).cfg.activityPoll = true
    const now = Date.now()
    const a = pool.seed('heartbeat', { now: now - 60_000, perClassActivity: true })
    a.meter = { agentMs: 0, appMs: 0, idleMs: 0, advancedAt: now - 5_000 }
    const before = a.lastRealActivityAt!

    globalThis.fetch = guest({ busy: true, activeTurns: 1 })
    await pool.pollActivity()
    pool.advanceMeters(Date.now())

    expect(pool.klass('heartbeat', Date.now())).toBe('idle')
    expect(a.meter.idleMs).toBeGreaterThan(0)
    expect(a.meter.agentMs).toBe(0)
    // Not "active" for the reaper either: the window keeps running.
    expect(a.lastRealActivityAt).toBe(before)
  })

  test('a live stream is agent on both sides', async () => {
    const pool = makePool(dir)
    ;(pool as any).cfg.activityPoll = true
    const now = Date.now()
    const a = pool.seed('streaming', { now: now - 60_000, perClassActivity: true })
    const before = a.lastRealActivityAt!

    globalThis.fetch = guest({ busy: true, activeTurns: 1, activeStreams: 1, liveStreams: 1 })
    await pool.pollActivity()

    expect(pool.klass('streaming', Date.now())).toBe('agent')
    expect(a.lastRealActivityAt!).toBeGreaterThan(before)
    a.meter = { agentMs: 0, appMs: 0, idleMs: 0, advancedAt: now }
    pool.advanceMeters(now + 2_000)
    expect(a.meter.agentMs).toBe(2_000)
    expect(a.meter.idleMs).toBe(0)
  })
})
