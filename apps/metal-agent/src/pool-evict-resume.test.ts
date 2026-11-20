// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * An evicted VM keeps its state (SHO-444, acceptance 3).
 *
 * The whole point of the "ready to suspend" bucket is that an early suspend is
 * cheap for the user: the VM goes to a snapshot, and the next open restores it
 * — `mode: 'resumed'`, not a cold boot that re-hydrates source from S3. This
 * file drives the REAL suspend path (no `suspend()` override) so the snapshot,
 * the cache index entry and the resume result are the ones production would
 * produce, and pins that the resume reports `suspendReason: 'evicted'` so the
 * control plane can label its wake latency.
 *
 * Driven with fakes — no real Firecracker host, no S3.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config, type MetalConfig } from './config'
import type { FcSnapshot, FcVmHandle, FirecrackerVMManager } from './firecracker-vm-manager'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { SnapshotStore } from './snapshot-store'

const IDLE_MS = 1000

class TestPool extends MetalWarmPool {
  /** Port of the fake guest, so a seeded VM's handle points at something real. */
  guestPort = 0

  seed(projectId: string, fields: Partial<AssignedVm> = {}): AssignedVm {
    const now = Date.now()
    const a: AssignedVm = {
      projectId,
      handle: {
        id: `vm-${projectId}`,
        agentUrl: `http://127.0.0.1:${this.guestPort}`,
        guestIp: '127.0.0.1',
        vmClass: 'standard',
      } as any,
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

  suspendedEntry(projectId: string): any {
    return (this as any).suspended.get(projectId)
  }
}

let dir: string
const cleanups: Array<() => void> = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metal-evict-resume-'))
})
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  rmSync(dir, { recursive: true, force: true })
})

/** A guest that accepts /pool/assign, /pool/refresh-env and the hooks. */
function makeGuest(): { port: number } {
  const server = Bun.serve({ port: 0, fetch: () => new Response('ok') })
  cleanups.push(() => server.stop(true))
  if (server.port === undefined) throw new Error('guest server did not bind a port')
  return { port: server.port }
}

function makePool(guestPort: number, over: Partial<MetalConfig> = {}): { pool: TestPool; pushed: string[] } {
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
    rehydrateTimeoutMs: 5000,
    ...over,
  } as MetalConfig
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })

  let n = 0
  const mgr = {
    async startVM(): Promise<FcVmHandle> {
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
        vcpus: 2,
        memoryMB: 1024,
        vmClass: 'standard',
      }
    },
    async snapshotVM(h: FcVmHandle): Promise<FcSnapshot> {
      return {
        vmId: h.id,
        snapshotPath: join(dir, `${h.id}.vmstate`),
        memFilePath: join(dir, `${h.id}.mem`),
        net: h.net,
        rootfs: h.rootfs,
        vcpus: h.vcpus,
        memoryMB: h.memoryMB,
        createdAt: Date.now(),
        bytesMem: 0,
        bytesState: 0,
        bytesRootfs: 0,
        vmClass: h.vmClass,
      } as FcSnapshot
    },
    async restoreVM(): Promise<FcVmHandle> {
      return {
        id: 'vm-restored',
        agentUrl: `http://127.0.0.1:${guestPort}`,
        guestIp: '127.0.0.1',
        vmClass: 'standard',
      } as any
    },
    async stopVM(): Promise<void> {},
    isRunning: () => true,
    procCount: () => 0,
    durableRootfs: (p: string) => ({ path: p, mode: 'full' }),
    restoreRootfsArtifactPath: (p: string) => p,
  } as unknown as FirecrackerVMManager

  const pushed: string[] = []
  const store = {
    kind: 's3',
    slim: false,
    push: async (_files: unknown, meta: { projectId: string }) => void pushed.push(meta.projectId),
    head: async () => null,
    pull: async () => null,
    remove: async () => {},
  } as unknown as SnapshotStore

  const pool = new TestPool(mgr, cfg, store)
  pool.guestPort = guestPort
  // The durable sidecars and the guest hooks are not what this file is about:
  // stub them so suspend() reaches the snapshot and resume() reaches the result.
  for (const m of [
    'saveBackupToStore',
    'saveProjectDataToStore',
    'saveRepoToStore',
    'saveHomeStateToStore',
    'saveWorkspaceMembersToStore',
    'drainForeignMembersOf',
    'hydrateFromBackup',
    'hydrateProjectData',
    'hydrateRepoAtAssign',
    'hydrateHomeState',
    'hydratePublishedData',
  ]) {
    ;(pool as any)[m] = async () => ({ hydrated: false })
  }
  ;(pool as any).waitForHealth = async () => 1
  ;(pool as any).callGuestHook = async () => true
  return { pool, pushed }
}

describe('an evicted VM resumes from its snapshot, not a cold boot', () => {
  test('assign evicts → the snapshot is marked evicted → resume restores it', async () => {
    const guest = makeGuest()
    const { pool, pushed } = makePool(guest.port, { maxResidentVmsPerHost: 1 })
    pool.seed('warm', { lastRealActivityAt: Date.now() - 10 * IDLE_MS })

    // The incoming assign needs the only slot: `warm` is suspended for real.
    const a = await pool.assign('incoming')
    expect(a.projectId).toBe('incoming')
    expect(pool.resident()).toEqual(['incoming'])

    // The snapshot exists and carries why it was taken.
    const entry = pool.suspendedEntry('warm')
    expect(entry).toBeDefined()
    expect(entry.suspendReason).toBe('evicted')
    expect(pushed).toContain('warm')

    // Its next open is a resume of that snapshot — the user's files are the
    // ones the VM had, not a re-hydrate from the durable backup.
    const res = await pool.open('warm')
    expect(res.mode).toBe('resumed')
    expect(res.suspendReason).toBe('evicted')
    expect(pool.resident().sort()).toEqual(['incoming', 'warm'])
  })

  test('an idle-suspended VM reports `idle`, so the two are distinguishable', async () => {
    const guest = makeGuest()
    const { pool } = makePool(guest.port)
    pool.seed('quiet', { lastRealActivityAt: Date.now() - 10 * IDLE_MS })

    await pool.suspend('quiet', { reason: 'idle' })
    expect(pool.suspendedEntry('quiet').suspendReason).toBe('idle')

    const res = await pool.open('quiet')
    expect(res.mode).toBe('resumed')
    expect(res.suspendReason).toBe('idle')
  })

  test('a snapshot taken before this shipped resumes with no reason at all', async () => {
    const guest = makeGuest()
    const { pool } = makePool(guest.port)
    pool.seed('legacy', { lastRealActivityAt: Date.now() - 10 * IDLE_MS })

    // No `reason` passed: exactly what an older agent wrote.
    await pool.suspend('legacy')
    expect(pool.suspendedEntry('legacy').suspendReason).toBeUndefined()

    const res = await pool.open('legacy')
    expect(res.mode).toBe('resumed')
    expect(res.suspendReason).toBeUndefined()
  })
})
