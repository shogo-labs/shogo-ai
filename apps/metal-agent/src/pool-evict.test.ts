// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The "ready to suspend" bucket, wired into the pool (SHO-444).
 *
 * An idle VM stays resident — instant resume — but counts as free capacity, and
 * is suspended early only when an assign or resume on this host actually needs
 * the slot or the RAM. These tests drive `assign()`/`resume()` against a fake
 * host: no real Firecracker, no S3.
 *
 * The rules themselves (when a host is full, which VM gives up its slot) are
 * pinned in evict.test.ts; this file is about the wiring and the things that
 * must never be evicted.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config, type MetalConfig } from './config'
import type { FcVmConfig, FcVmHandle, FirecrackerVMManager } from './firecracker-vm-manager'
import { MetalWarmPool, type AssignedVm, type SuspendReason } from './pool'
import type { SnapshotStore } from './snapshot-store'

const IDLE_MS = 1000

class TestPool extends MetalWarmPool {
  /** ProjectIds this pool suspended, in order, with the reason it was given. */
  suspends: Array<{ projectId: string; reason?: SuspendReason }> = []
  /** Injected /proc/meminfo, so the memory trigger is testable off Linux. */
  mem: { totalMiB: number; availableMiB: number } | undefined
  /** Held open by a test that needs two assigns to reach selection together. */
  gate?: Promise<void>
  onSuspendEntered?: () => void

  protected override hostMemoryNow() {
    return this.mem
  }

  override async suspend(projectId: string, opts: { reason?: SuspendReason } = {}): Promise<any> {
    this.onSuspendEntered?.()
    if (this.gate) await this.gate
    this.suspends.push({ projectId, reason: opts.reason })
    ;(this as any).assigned.delete(projectId)
    return { projectId, suspendReason: opts.reason }
  }

  seed(projectId: string, fields: Partial<AssignedVm> = {}): AssignedVm {
    const now = Date.now()
    const a: AssignedVm = {
      projectId,
      handle: { id: `vm-${projectId}`, agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9', vmClass: 'standard' } as any,
      assignedAt: now,
      lastTouchedAt: now,
      lastRealActivityAt: now,
      alwaysOn: false,
      ...fields,
    }
    ;(this as any).assigned.set(projectId, a)
    return a
  }

  peek(projectId: string): AssignedVm | undefined {
    return (this as any).assigned.get(projectId)
  }

  resident(): string[] {
    return [...(this as any).assigned.keys()]
  }
}

let dir: string
const cleanups: Array<() => void> = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metal-evict-'))
})
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  rmSync(dir, { recursive: true, force: true })
})

/** A guest that accepts /pool/assign and answers /health. */
function makeGuest(): { port: number } {
  const server = Bun.serve({ port: 0, fetch: () => new Response('ok') })
  cleanups.push(() => server.stop(true))
  if (server.port === undefined) throw new Error('guest server did not bind a port')
  return { port: server.port }
}

function makePool(guestPort: number, over: Partial<MetalConfig> = {}): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    poolSize: 0,
    idleSuspendMs: IDLE_MS,
    evictMaxPerAssign: 3,
    evictHeadroomSlots: 0,
    maxResidentVmsPerHost: 0,
    evictMemReserveMiB: 0,
    healthRetries: 1,
    healthIntervalMs: 1,
    ...over,
  } as MetalConfig
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })

  let n = 0
  const mgr = {
    async startVM(c: FcVmConfig = {}): Promise<FcVmHandle> {
      n++
      return {
        id: `vm-new-${n}`,
        agentUrl: `http://127.0.0.1:${guestPort}`,
        guestIp: '127.0.0.1',
        pid: 1000 + n,
        platform: 'linux',
        net: { tap: `fctap${n}`, guestIp: '127.0.0.1' } as any,
        rootfs: join(dir, `rootfs-${n}`),
        socketPath: join(dir, `fc-${n}.sock`),
        serialLog: join(dir, `fc-${n}.serial`),
        vcpus: c.cpus ?? 2,
        memoryMB: c.memoryMB ?? 1024,
        vmClass: c.vmClass ?? 'standard',
      }
    },
    async stopVM(): Promise<void> {},
    isRunning: () => true,
    procCount: () => 0,
    durableRootfs: (p: string) => ({ path: p, mode: 'full' }),
    restoreRootfsArtifactPath: (p: string) => p,
  } as unknown as FirecrackerVMManager

  const pool = new TestPool(mgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
  // The cold-boot hydration path is not what this file is about: stub it so an
  // assign reaches `assigned` without S3 or a real guest.
  for (const m of [
    'waitForHealth',
    'hydrateFromBackup',
    'hydrateProjectData',
    'hydrateRepoAtAssign',
    'hydrateHomeState',
    'hydratePublishedData',
    'saveBackupToStore',
    'saveProjectDataToStore',
    'saveRepoToStore',
    'saveHomeStateToStore',
    'callGuestHook',
  ]) {
    ;(pool as any)[m] = async () => ({ hydrated: false })
  }
  return pool
}

describe('assign() on a full host evicts instead of scaling', () => {
  test('suspends exactly the longest-idle evictable VM and succeeds on this host', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { maxResidentVmsPerHost: 2 })
    const now = Date.now()
    pool.seed('idle-10s', { lastRealActivityAt: now - 10 * IDLE_MS })
    pool.seed('idle-2s', { lastRealActivityAt: now - 2 * IDLE_MS })

    const a = await pool.assign('incoming')

    expect(pool.suspends).toEqual([{ projectId: 'idle-10s', reason: 'evicted' }])
    expect(a.projectId).toBe('incoming')
    expect(pool.resident().sort()).toEqual(['idle-2s', 'incoming'])
  })

  test('the memory trigger evicts too, from an injected meminfo', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { evictMemReserveMiB: 2048 })
    pool.mem = { totalMiB: 8192, availableMiB: 3000 }
    pool.seed('warm', { lastRealActivityAt: Date.now() - 10 * IDLE_MS })

    await pool.assign('incoming')

    expect(pool.suspends.map((s) => s.projectId)).toEqual(['warm'])
  })

  test('nothing evictable → the assign still succeeds, exactly as before', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { maxResidentVmsPerHost: 1 })
    // Resident, but in use: the host is full of WORK, not of warm VMs.
    pool.seed('busy', { lastRealActivityAt: Date.now(), activeStreams: 1 })

    const a = await pool.assign('incoming')

    expect(pool.suspends).toEqual([])
    expect(a.projectId).toBe('incoming')
    expect(pool.resident().sort()).toEqual(['busy', 'incoming'])
  })
})

describe('never evicts the wrong VM', () => {
  test('an active VM (inside the window) is not a candidate', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { maxResidentVmsPerHost: 1 })
    pool.seed('just-used', { lastRealActivityAt: Date.now() - IDLE_MS / 2 })

    await pool.assign('incoming')

    expect(pool.suspends).toEqual([])
    expect(pool.peek('just-used')).toBeDefined()
  })

  test('a busy VM is not a candidate, however long it has been idle', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { maxResidentVmsPerHost: 1 })
    pool.seed('mid-turn', { lastRealActivityAt: Date.now() - 100 * IDLE_MS, activeStreams: 1 })

    await pool.assign('incoming')

    expect(pool.suspends).toEqual([])
    expect(pool.peek('mid-turn')).toBeDefined()
  })

  test('an always-on VM is never evicted', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { maxResidentVmsPerHost: 1 })
    pool.seed('paid', { lastRealActivityAt: Date.now() - 100 * IDLE_MS, alwaysOn: true })

    await pool.assign('incoming')

    expect(pool.suspends).toEqual([])
    expect(pool.peek('paid')).toBeDefined()
  })

  test('the project being assigned is never its own victim', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { maxResidentVmsPerHost: 1 })
    // A re-assign of a project that is already resident and idle.
    pool.seed('incoming', { lastRealActivityAt: Date.now() - 100 * IDLE_MS })

    await pool.assign('incoming')

    expect(pool.suspends).toEqual([])
    expect(pool.peek('incoming')).toBeDefined()
  })

  test('two concurrent assigns on a full host evict two different VMs', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { maxResidentVmsPerHost: 2 })
    const now = Date.now()
    pool.seed('idle-a', { lastRealActivityAt: now - 10 * IDLE_MS })
    pool.seed('idle-b', { lastRealActivityAt: now - 20 * IDLE_MS })

    // Hold both suspends open until each assign has picked its victim, so this
    // is the real race: both see the host full at the same moment.
    let release!: () => void
    pool.gate = new Promise<void>((r) => (release = r))
    let entered = 0
    let bothEntered!: () => void
    const both = new Promise<void>((r) => (bothEntered = r))
    pool.onSuspendEntered = () => {
      if (++entered === 2) bothEntered()
    }

    const p1 = pool.assign('incoming-1')
    const p2 = pool.assign('incoming-2')
    await both
    release()
    await Promise.all([p1, p2])

    expect(pool.suspends.map((s) => s.projectId).sort()).toEqual(['idle-a', 'idle-b'])
  })

  test('a VM that becomes active between selection and suspend is skipped', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { maxResidentVmsPerHost: 1 })
    const now = Date.now()
    const victim = pool.seed('was-idle', { lastRealActivityAt: now - 10 * IDLE_MS })
    // The user clicks in the window between the candidate list and the suspend.
    const realResidency = (pool as any).vmResidency.bind(pool)
    let calls = 0
    ;(pool as any).vmResidency = (a: AssignedVm, t: number) => {
      if (a.projectId === 'was-idle' && ++calls > 1) return 'active'
      return realResidency(a, t)
    }

    await pool.assign('incoming')

    expect(pool.suspends).toEqual([])
    expect(victim.lastRealActivityAt).toBe(now - 10 * IDLE_MS)
  })
})

describe('resume() makes room too', () => {
  test('a resume on a full host evicts a warm VM before restoring', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { maxResidentVmsPerHost: 1 })
    pool.seed('warm', { lastRealActivityAt: Date.now() - 10 * IDLE_MS })
    ;(pool as any).suspended.set('coming-back', {
      projectId: 'coming-back',
      snapshot: {
        vmId: 's-1',
        snapshotPath: join(dir, 'vmstate'),
        memFilePath: join(dir, 'mem'),
        rootfs: join(dir, 'rootfs'),
        net: {},
        vcpus: 2,
        memoryMB: 1024,
        createdAt: 0,
        bytesMem: 1,
        bytesState: 1,
        bytesRootfs: 1,
      },
      suspendedAt: 0,
      lastAccessAt: 0,
      suspendReason: 'evicted',
    })
    ;(pool as any).mgr.restoreVM = async () => ({
      id: 'vm-restored',
      agentUrl: `http://127.0.0.1:${guest.port}`,
      guestIp: '127.0.0.1',
      vmClass: 'standard',
    })

    const res = await pool.resume('coming-back')

    expect(pool.suspends.map((s) => s.projectId)).toEqual(['warm'])
    expect(res).not.toBeNull()
    // The evicted VM's own resume reports why its snapshot was taken, so the
    // control plane can label wake latency with it.
    expect(res!.suspendReason).toBe('evicted')
  })
})

describe('the reaper headroom pass', () => {
  test('keeps the configured slots free, longest-idle first', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { maxResidentVmsPerHost: 3, evictHeadroomSlots: 2 })
    const now = Date.now()
    pool.seed('idle-30', { lastRealActivityAt: now - 30 * IDLE_MS })
    pool.seed('idle-20', { lastRealActivityAt: now - 20 * IDLE_MS })
    pool.seed('idle-10', { lastRealActivityAt: now - 10 * IDLE_MS })

    // 3 resident, cap 3, want 2 slots free → evict 2.
    expect(await pool.evictForHeadroom()).toEqual(['idle-30', 'idle-20'])
    expect(pool.resident()).toEqual(['idle-10'])
  })

  test('does nothing when the host already has the headroom', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { maxResidentVmsPerHost: 10, evictHeadroomSlots: 2 })
    pool.seed('idle', { lastRealActivityAt: Date.now() - 30 * IDLE_MS })

    expect(await pool.evictForHeadroom()).toEqual([])
    expect(pool.suspends).toEqual([])
  })

  test('is off when METAL_EVICT_HEADROOM_SLOTS=0', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { maxResidentVmsPerHost: 1, evictHeadroomSlots: 0 })
    pool.seed('idle', { lastRealActivityAt: Date.now() - 30 * IDLE_MS })

    expect(await pool.evictForHeadroom()).toEqual([])
  })
})

describe('residency accounting', () => {
  test('active + evictable sum to assigned, and the split follows the window', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port)
    const now = Date.now()
    pool.seed('in-use', { lastRealActivityAt: now })
    pool.seed('warm', { lastRealActivityAt: now - 10 * IDLE_MS })
    pool.seed('paid', { lastRealActivityAt: now - 10 * IDLE_MS, alwaysOn: true })

    const s = pool.status()

    expect(s.liveness.active).toBe(2)
    expect(s.liveness.evictable).toBe(1)
    expect(s.liveness.active + s.liveness.evictable).toBe(s.assigned.length)
    expect(s.assigned.find((a) => a.projectId === 'warm')!.residency).toBe('evictable')
    expect(s.assigned.find((a) => a.projectId === 'in-use')!.residency).toBe('active')
  })

  test('with idle-suspend disabled nothing is evictable', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { idleSuspendMs: 0 })
    pool.seed('idle-forever', { lastRealActivityAt: Date.now() - 100 * IDLE_MS })

    expect(pool.status().liveness.evictable).toBe(0)
  })
})
