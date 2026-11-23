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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { LiveRegistry } from './live-registry'
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
      // `assign()` and `resume()` always seed the meter; only an adopted VM used
      // to arrive without one.
      meter: { agentMs: 0, appMs: 0, idleMs: 0, advancedAt: now },
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
    return (this as any).vmMeterClass(a, now)
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
 * SHO-532. The meter used to live ONLY in memory, and `adopt()` restored a VM
 * with the registry's original `assignedAt` and no meter — so the first tick
 * after every metal-agent restart charged the VM's whole life to its current
 * class. Prod rows reached 4.4M agent-seconds in one hour.
 */
describe('VM meter across a metal-agent restart', () => {
  const DAY = 86_400_000
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-meter-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('an assigned VM with no meter yet counts from its first tick, not from assignedAt', () => {
    const pool = makePool(dir)
    const t0 = 9_000_000
    // The state `adopt()` puts a VM in before the fix: a live assignment whose
    // assignedAt is a month old and whose meter has not been created.
    pool.seed('adopted', { now: t0, assignedAt: t0 - 30 * DAY, activeStreams: 1, meter: undefined })
    pool.advanceMeters(t0)
    pool.advanceMeters(t0 + 30_000)

    const m = pool.meter('adopted')
    expect(m.agentMs + m.appMs + m.idleMs).toBe(30_000)
  })

  test('a re-adopted live VM bills only the time since the restart, in each class', async () => {
    const cfg = {
      ...config,
      work: dir,
      snapDir: join(dir, 'snap'),
      runDir: join(dir, 'run'),
      snapStore: 'none' as const,
      poolSize: 0,
    }
    mkdirSync(cfg.snapDir, { recursive: true })
    mkdirSync(cfg.runDir, { recursive: true })

    // A "guest" that answers /health, and a live pid = a VM that survived the
    // agent's restart (systemd KillMode=process).
    const guest = Bun.serve({ port: 0, fetch: () => new Response('ok') })
    const child = Bun.spawn(['sleep', '30'])
    try {
      const sock = join(cfg.runDir, 'proj.sock')
      writeFileSync(sock, '')
      const assignedAt = Date.now() - 30 * DAY
      new LiveRegistry(cfg.runDir).put({
        projectId: 'proj',
        vmId: 'fcvm-proj',
        pid: child.pid,
        guestIp: '127.0.0.1',
        agentUrl: `http://localhost:${guest.port}`,
        socketPath: sock,
        serialLog: join(cfg.runDir, 'proj.serial'),
        net: { tap: 'fctap0', guestIp: '127.0.0.1' } as any,
        rootfs: join(cfg.runDir, 'proj.rootfs'),
        vcpus: 4,
        memoryMB: 8192,
        assignedAt,
        lastTouchedAt: assignedAt,
        v: 1,
      })
      const fakeMgr = { adoptVM: () => {}, reapHostOrphans: () => 0, procCount: () => 0 }
      const pool = new TestPool(fakeMgr as any, cfg as any, { kind: 'none' } as unknown as SnapshotStore)

      const res = await pool.adopt()
      expect(res.adopted).toEqual(['proj'])
      const vm = pool.getAssigned('proj')!
      // Fresh assignment record: the counters start now, not a month ago.
      expect(vm.meter).toMatchObject({ agentMs: 0, appMs: 0, idleMs: 0 })

      const t0 = vm.meter!.advancedAt
      pool.advanceMeters(t0 + 30_000) // idle
      vm.activeStreams = 2 // an agent turn begins: a different class
      pool.advanceMeters(t0 + 60_000)

      const m = pool.meter('proj')!
      expect(m.idleMs).toBe(30_000)
      expect(m.agentMs).toBe(30_000)
      // On main the first tick charges the 30 days since assignedAt — to whichever
      // class the VM happened to be in.
      expect(m.agentMs + m.appMs + m.idleMs).toBe(60_000)
    } finally {
      child.kill('SIGKILL')
      await child.exited.catch(() => {})
      guest.stop(true)
    }
  })
})
