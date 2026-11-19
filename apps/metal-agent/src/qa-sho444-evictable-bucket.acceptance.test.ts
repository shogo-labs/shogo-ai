// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * QA acceptance tests for SHO-444 — the metal "ready to suspend" bucket.
 *
 * These are written from the card's acceptance criteria, not from the
 * implementation, and they deliberately go through the surfaces the control
 * plane and the operator actually see:
 *
 *   - the real heartbeat POST body (`load.active` / `load.evictable` / `idle`),
 *   - the real `assign()` → `suspendOrRetire()` → `resume()` path (no stubbed
 *     suspend), so an evicted VM is proven to keep its state,
 *   - the Prometheus counters the runbook and the SigNoz panels read.
 *
 * The unit-level rules (when a host is full, which VM gives up its slot) are
 * pinned in `evict.test.ts` / `pool-evict.test.ts`; this file is the gate.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config, type MetalConfig } from './config'
import type { FcVmConfig, FcVmHandle, FirecrackerVMManager } from './firecracker-vm-manager'
import { _resetIdleDirective, setIdleDirective } from './idle-policy'
import { M, metrics } from './metrics'
import { MetalWarmPool, RepoNotDurableError, type AssignedVm } from './pool'
import { announceRestarting } from './register'
import type { SnapshotStore } from './snapshot-store'

const IDLE_MS = 1000
const RELAXED_MS = 4 * 60 * 60 * 1000

class TestPool extends MetalWarmPool {
  /** ProjectIds this pool suspended, in order, with the reason it was given. */
  suspends: Array<{ projectId: string; reason?: string }> = []
  mem: { totalMiB: number; availableMiB: number } | undefined
  /** Projects whose stop SHO-442 refuses (HEAD not in the durable repo). */
  refuse = new Set<string>()

  protected override hostMemoryNow() {
    return this.mem
  }

  override async suspend(projectId: string, opts: { reason?: any } = {}): Promise<any> {
    if (this.refuse.has(projectId)) {
      throw new RepoNotDurableError(`HEAD of ${projectId} is not in the durable repo`)
    }
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

  resident(): string[] {
    return [...(this as any).assigned.keys()]
  }
}

let dir: string
const cleanups: Array<() => void> = []
/**
 * `config` is `as const`, so its knobs are readonly. The test env has no
 * METAL_IDLE_SUSPEND_MS and no control plane, so these two have to be set per
 * test; a mutable view keeps that explicit instead of casting at each site.
 */
const cfg = config as { -readonly [K in keyof typeof config]: (typeof config)[K] }
const savedControlPlane = cfg.controlPlaneUrl
const savedIdleSuspendMs = cfg.idleSuspendMs

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qa-sho444-'))
  // The heartbeat only reports an idle window when the reaper is on, and the
  // test env has no METAL_IDLE_SUSPEND_MS.
  cfg.idleSuspendMs = IDLE_MS
})

afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  rmSync(dir, { recursive: true, force: true })
  cfg.controlPlaneUrl = savedControlPlane
  cfg.idleSuspendMs = savedIdleSuspendMs
  _resetIdleDirective()
})

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

/** Capture the next heartbeat POST body on a fake control plane. */
function fakeControlPlane(): { url: string; bodies: any[] } {
  const bodies: any[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push(await req.json())
      return Response.json({ ok: true })
    },
  })
  cleanups.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}`, bodies }
}

// --- AC5: the heartbeat carries the residency split -------------------------

describe('AC5 — the heartbeat reports active/evictable, and the idle window keys off active', () => {
  test('load.active + load.evictable sum to load.assigned, and the split follows the window', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port)
    const now = Date.now()
    // Two VMs past the evictable window, one still in use, one paid.
    pool.seed('warm-1', { lastRealActivityAt: now - 10 * IDLE_MS })
    pool.seed('warm-2', { lastRealActivityAt: now - 5 * IDLE_MS })
    pool.seed('in-use', { lastRealActivityAt: now })
    pool.seed('paid', { lastRealActivityAt: now - 100 * IDLE_MS, alwaysOn: true })

    const cp = fakeControlPlane()
    cfg.controlPlaneUrl = cp.url
    await announceRestarting(pool)

    expect(cp.bodies).toHaveLength(1)
    const load = cp.bodies[0].load
    expect(load.assigned).toBe(4)
    expect(load.active).toBe(2) // in-use + always-on
    expect(load.evictable).toBe(2) // warm-1 + warm-2
    expect(load.active + load.evictable).toBe(load.assigned)
  })

  test('a host full of evictable VMs stays on the RELAXED window (the host guard counts active)', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port)
    const now = Date.now()
    // 79 of 80 slots resident, but only one is in use: the host is nearly empty
    // in the only sense that matters, so it must not narrow its own window.
    for (let i = 0; i < 79; i++) pool.seed(`warm-${i}`, { lastRealActivityAt: now - 10 * IDLE_MS })
    pool.seed('in-use', { lastRealActivityAt: now })

    const cp = fakeControlPlane()
    cfg.controlPlaneUrl = cp.url
    setIdleDirective({ idleMs: RELAXED_MS, tier: 'relaxed' })
    await announceRestarting(pool)

    const idle = cp.bodies[0].idle
    expect(idle.tier).toBe('relaxed')
    expect(idle.reason).toBe('directive')
    expect(idle.idleMs).toBe(RELAXED_MS)
  })

  test('the same host narrows to AGGRESSIVE once the ACTIVE VMs reach the guard', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port)
    const now = Date.now()
    // 80 resident, all in use: this host really is full of work.
    for (let i = 0; i < 80; i++) pool.seed(`busy-${i}`, { lastRealActivityAt: now })

    const cp = fakeControlPlane()
    cfg.controlPlaneUrl = cp.url
    setIdleDirective({ idleMs: RELAXED_MS, tier: 'relaxed' })
    await announceRestarting(pool)

    const idle = cp.bodies[0].idle
    expect(idle.tier).toBe('aggressive')
    expect(idle.reason).toBe('host_guard')
    expect(idle.idleMs).toBe(IDLE_MS)
  })
})

// --- AC1 + AC8: an assign on a full host evicts, and says so ----------------

describe('AC1/AC8 — assign on a full host evicts the longest-idle VM and counts it', () => {
  test('the assign succeeds here, and metal_evictions_total{reason="slots"} moves', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { maxResidentVmsPerHost: 2 })
    const now = Date.now()
    pool.seed('idle-30s', { lastRealActivityAt: now - 30 * IDLE_MS })
    pool.seed('idle-5s', { lastRealActivityAt: now - 5 * IDLE_MS })
    const before = metrics.getCounter(`${M.evictions}{reason="slots"}`)

    const a = await pool.assign('incoming')

    expect(a.projectId).toBe('incoming')
    expect(pool.suspends).toEqual([{ projectId: 'idle-30s', reason: 'evicted' }])
    expect(pool.resident().sort()).toEqual(['idle-5s', 'incoming'])
    expect(metrics.getCounter(`${M.evictions}{reason="slots"}`)).toBe(before + 1)
  })

  test('the memory trigger labels its eviction `mem`', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { evictMemReserveMiB: 2048 })
    pool.mem = { totalMiB: 8192, availableMiB: 3000 }
    pool.seed('warm', { lastRealActivityAt: Date.now() - 10 * IDLE_MS })
    const before = metrics.getCounter(`${M.evictions}{reason="mem"}`)

    await pool.assign('incoming')

    expect(pool.suspends.map((s) => s.projectId)).toEqual(['warm'])
    expect(metrics.getCounter(`${M.evictions}{reason="mem"}`)).toBe(before + 1)
  })
})

// --- AC4: nothing evictable never fails an assign ---------------------------

describe('AC4 — a host full of WORK still accepts the assign, and says why', () => {
  test('the assign succeeds and metal_evict_none_available_total increments', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { maxResidentVmsPerHost: 1 })
    pool.seed('mid-turn', { lastRealActivityAt: Date.now(), activeStreams: 1 })
    const before = metrics.getCounter(M.evictNoneAvailable)

    const a = await pool.assign('incoming')

    expect(a.projectId).toBe('incoming')
    expect(pool.suspends).toEqual([])
    expect(pool.resident().sort()).toEqual(['incoming', 'mid-turn'])
    expect(metrics.getCounter(M.evictNoneAvailable)).toBe(before + 1)
  })
})

// --- AC2: the VMs that must never be evicted --------------------------------

describe('AC2 — active, busy and always-on VMs are never evicted', () => {
  test('a host holding only those three still serves the assign without evicting', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { maxResidentVmsPerHost: 3 })
    const now = Date.now()
    pool.seed('just-used', { lastRealActivityAt: now - IDLE_MS / 2 })
    pool.seed('mid-turn', { lastRealActivityAt: now - 100 * IDLE_MS, activeStreams: 1 })
    pool.seed('paid', { lastRealActivityAt: now - 100 * IDLE_MS, alwaysOn: true })

    const a = await pool.assign('incoming')

    expect(a.projectId).toBe('incoming')
    expect(pool.suspends).toEqual([])
    expect(pool.resident().sort()).toEqual(['incoming', 'just-used', 'mid-turn', 'paid'])
  })
})

// --- Risks: a refused stop (SHO-442) is not an eviction ---------------------

describe('a stop SHO-442 refuses is skipped, not counted as an eviction', () => {
  test('the next-longest-idle VM is evicted, the refused one keeps running, and the assign still succeeds', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { maxResidentVmsPerHost: 2 })
    const now = Date.now()
    // The longest-idle VM is the one whose HEAD is not durable yet: SHO-442
    // refuses to stop it, so it must keep running and the next candidate goes.
    pool.seed('idle-30s', { lastRealActivityAt: now - 30 * IDLE_MS })
    pool.seed('idle-5s', { lastRealActivityAt: now - 5 * IDLE_MS })
    pool.refuse.add('idle-30s')
    const evicted: string[] = []
    pool.onEvicted = (id) => evicted.push(id)
    const before = metrics.getCounter(`${M.evictions}{reason="slots"}`)

    const a = await pool.assign('incoming')

    expect(a.projectId).toBe('incoming')
    expect(pool.suspends).toEqual([{ projectId: 'idle-5s', reason: 'evicted' }])
    // The refused VM never left, so it is neither counted nor reported gone.
    expect(pool.resident().sort()).toEqual(['idle-30s', 'incoming'])
    expect(evicted).toEqual(['idle-5s'])
    expect(metrics.getCounter(`${M.evictions}{reason="slots"}`)).toBe(before + 1)
  })

  test('when every candidate refuses, the assign still succeeds and nothing is counted', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { maxResidentVmsPerHost: 1 })
    pool.seed('idle-30s', { lastRealActivityAt: Date.now() - 30 * IDLE_MS })
    pool.refuse.add('idle-30s')
    const evicted: string[] = []
    pool.onEvicted = (id) => evicted.push(id)
    const before = metrics.getCounter(`${M.evictions}{reason="slots"}`)

    const a = await pool.assign('incoming')

    expect(a.projectId).toBe('incoming')
    expect(pool.suspends).toEqual([])
    expect(pool.resident().sort()).toEqual(['idle-30s', 'incoming'])
    expect(evicted).toEqual([])
    expect(metrics.getCounter(`${M.evictions}{reason="slots"}`)).toBe(before)
  })

  test('a suspend that throws is skipped the same way, not retried on the same VM', async () => {
    const guest = makeGuest()
    const pool = makePool(guest.port, { maxResidentVmsPerHost: 2 })
    const now = Date.now()
    pool.seed('idle-30s', { lastRealActivityAt: now - 30 * IDLE_MS })
    pool.seed('idle-5s', { lastRealActivityAt: now - 5 * IDLE_MS })
    const realSuspend = pool.suspend.bind(pool)
    let attempts = 0
    pool.suspend = async (projectId: string, opts: any = {}) => {
      if (projectId === 'idle-30s') {
        attempts++
        throw new Error('snapshot failed')
      }
      return realSuspend(projectId, opts)
    }

    const a = await pool.assign('incoming')

    expect(a.projectId).toBe('incoming')
    // One attempt on the failing VM, then the next candidate — not the same VM
    // three times while the cap burns.
    expect(attempts).toBe(1)
    expect(pool.suspends).toEqual([{ projectId: 'idle-5s', reason: 'evicted' }])
    expect(pool.resident().sort()).toEqual(['idle-30s', 'incoming'])
  })
})
