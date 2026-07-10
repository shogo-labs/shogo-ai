// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool liveness — the metal parity for "never route to a dead microVM".
 *
 * Reproduces the production incident where a preview stayed stuck on the
 * "Waking things up" interstitial forever (project 7d23341b on latitude-dal-2):
 *
 *   1. A project's firecracker process died (crash / OOM / lost suspend race)
 *      but its entry survived in the pool's `assigned` map, pointing at the
 *      dead guest's URL.
 *   2. `open()` (behind /assign) had an idempotent fast-path that returned that
 *      tracked handle as a warm `reused` hit WITHOUT checking the process was
 *      alive — so the control plane kept proxying to a guest that refused every
 *      connection ("[preview/render] Unable to connect" → 502; /preview/status
 *      never `running` → wake `{ready:false}`).
 *   3. Because the edge worker's wake page polls /assign every few seconds,
 *      each poll bumped `lastTouchedAt`, so the idle reaper (which only suspends
 *      QUIET VMs) never fired — the phantom entry lingered indefinitely.
 *
 * Fixes under test:
 *   - open() gates its reuse fast-path on `mgr.isRunning(handle)`; a dead entry
 *     is discarded and the open falls through to a fresh boot (self-heal).
 *   - reapDeadAssigned() clears dead entries regardless of idle time, so a
 *     continuously-polled dead VM is reclaimed even though reapIdle can't.
 *
 * Driven with fakes — no real Firecracker host.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { FcVmHandle, FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

/**
 * Pool subclass that stubs the provisioning paths so open() can exercise the
 * liveness gate offline. `assign()` records a call and installs a FRESH live VM
 * (added to the shared `alive` set) exactly as a real cold boot would.
 */
class TestPool extends MetalWarmPool {
  assignCalls: string[] = []
  stoppedHandles: string[] = []

  constructor(
    private alive: Set<string>,
    mgr: FirecrackerVMManager,
    cfg: typeof config,
  ) {
    super(mgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
  }

  /** A snapshot resume is never in play here — force the cold-boot/assign path. */
  override async canResume(): Promise<boolean> {
    return false
  }

  override async assign(projectId: string, _env: Record<string, string> = {}): Promise<AssignedVm> {
    this.assignCalls.push(projectId)
    const n = this.assignCalls.length
    const vmId = `fresh-${projectId}-${n}`
    const guestIp = `172.16.9.${n}`
    this.alive.add(vmId) // a freshly booted VM is alive
    const now = Date.now()
    const a: AssignedVm = {
      projectId,
      handle: { id: vmId, agentUrl: `http://${guestIp}:8080`, guestIp } as unknown as FcVmHandle,
      assignedAt: now,
      lastTouchedAt: now,
    }
    ;(this as any).assigned.set(projectId, a)
    return a
  }

  /** Seed an already-tracked VM; `live:false` simulates a dead firecracker proc. */
  seedAssigned(projectId: string, vmId: string, live: boolean): FcVmHandle {
    const handle = {
      id: vmId,
      agentUrl: `http://172.16.0.9:8080`,
      guestIp: '172.16.0.9',
    } as unknown as FcVmHandle
    if (live) this.alive.add(vmId)
    ;(this as any).assigned.set(projectId, {
      projectId,
      handle,
      assignedAt: Date.now(),
      lastTouchedAt: Date.now(),
    } satisfies AssignedVm)
    return handle
  }

  peek(projectId: string): AssignedVm | undefined {
    return (this as any).assigned.get(projectId)
  }
}

function makePool(dir: string): { pool: TestPool; alive: Set<string> } {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    idleSuspendMs: 1000,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const alive = new Set<string>()
  const fakeMgr = {
    procCount: () => alive.size,
    isRunning: (h: FcVmHandle) => alive.has(h.id),
    stopVM: async (h: FcVmHandle) => {
      alive.delete(h.id)
    },
  } as unknown as FirecrackerVMManager
  const pool = new TestPool(alive, fakeMgr, cfg)
  // Track stopVM targets for assertions (wraps the fake above).
  const origStop = (fakeMgr as any).stopVM
  ;(fakeMgr as any).stopVM = async (h: FcVmHandle) => {
    pool.stoppedHandles.push(h.id)
    return origStop(h)
  }
  return { pool, alive }
}

describe('pool open() liveness gate', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-liveness-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('reuses a tracked VM whose firecracker process is still alive (no reprovision)', async () => {
    const { pool } = makePool(dir)
    const handle = pool.seedAssigned('ok', 'fcvm-ok', true)

    const r = await pool.open('ok', {})

    expect(r.reused).toBe(true)
    expect(r.mode).toBe('assigned')
    expect(r.handle.id).toBe(handle.id)
    expect(pool.assignCalls).toEqual([]) // no cold boot — warm reuse
    expect(pool.stoppedHandles).toEqual([]) // live VM never stopped
  })

  // The core reproduction: a dead tracked VM must NOT be served as a warm hit.
  test('discards a DEAD tracked VM and reprovisions instead of serving its URL', async () => {
    const { pool } = makePool(dir)
    // fcvm-721: the production vmId — tracked in `assigned` but its FC proc is gone.
    pool.seedAssigned('7d23341b', 'fcvm-721', false)

    const r = await pool.open('7d23341b', {})

    // Must NOT hand back the dead VM as a reused warm hit.
    expect(r.handle.id).not.toBe('fcvm-721')
    expect(r.reused).toBeFalsy()
    expect(r.mode).toBe('assigned')
    // It cold-booted a fresh VM and swapped it into the map.
    expect(pool.assignCalls).toEqual(['7d23341b'])
    expect(pool.peek('7d23341b')?.handle.id).toBe(r.handle.id)
    // The dead VM was torn down (reaps its leaked tap/socket).
    expect(pool.stoppedHandles).toContain('fcvm-721')
  })
})

describe('pool reapDeadAssigned() liveness sweep', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-deadreap-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // Reproduces the "polled dead VM never ages out" half of the incident.
  test('reaps a continuously-touched dead VM that the idle reaper can never clear', async () => {
    const { pool } = makePool(dir)
    pool.seedAssigned('7d23341b', 'fcvm-721', false) // dead FC proc

    // Simulate the wake-poll: keep the entry "fresh" so it is never idle.
    pool.touch('7d23341b')
    const idleReaped = await pool.reapIdle(1000)

    // The idle reaper is helpless — the entry was just touched, so it is not
    // stale and stays a phantom "live" VM (the production deadlock).
    expect(idleReaped).toEqual([])
    expect(pool.peek('7d23341b')).toBeDefined()

    // The liveness sweep clears it regardless of how recently it was touched.
    const deadReaped = await pool.reapDeadAssigned()
    expect(deadReaped).toEqual(['7d23341b'])
    expect(pool.peek('7d23341b')).toBeUndefined()
    expect(pool.stoppedHandles).toContain('fcvm-721')
  })

  test('leaves healthy assigned VMs untouched', async () => {
    const { pool } = makePool(dir)
    pool.seedAssigned('alive-1', 'fcvm-a1', true)
    pool.seedAssigned('alive-2', 'fcvm-a2', true)
    pool.seedAssigned('dead', 'fcvm-dead', false)

    const reaped = await pool.reapDeadAssigned()

    expect(reaped).toEqual(['dead'])
    expect(pool.peek('alive-1')).toBeDefined()
    expect(pool.peek('alive-2')).toBeDefined()
    expect(pool.peek('dead')).toBeUndefined()
  })
})
