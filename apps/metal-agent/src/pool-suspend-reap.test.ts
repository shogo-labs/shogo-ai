// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The dead-VM reaper must not race a suspend.
 *
 * Production, 2026-09-28: after a rootfs rollout the re-warm job suspended
 * hundreds of workspaces while the liveness sweep ran every 15s. A suspend
 * stops the Firecracker process when it takes the snapshot, but only drops the
 * project from `assigned` afterwards. The sweep saw "fc process gone" in that
 * window, rescued and quarantined the disk, and the suspend then failed its
 * durable push with "snapshot artifact rootfs missing/empty".
 *
 * Driven with fakes — no real Firecracker host.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { FcSnapshot, FcVmHandle, FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

class TestPool extends MetalWarmPool {
  rescued: string[] = []

  protected override async rescueWorkspace(a: AssignedVm, why: string): Promise<void> {
    this.rescued.push(`${a.projectId}:${why}`)
  }

  protected override async callGuestHook(): Promise<boolean> {
    return true
  }

  seed(projectId: string, handle: FcVmHandle): void {
    const now = Date.now()
    ;(this as any).assigned.set(projectId, { projectId, handle, assignedAt: now, lastTouchedAt: now } satisfies AssignedVm)
  }

  isAssigned(projectId: string): boolean {
    return (this as any).assigned.has(projectId)
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metal-suspend-reap-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function handleFor(id: string): FcVmHandle {
  return {
    id,
    agentUrl: 'http://172.16.0.9:8080',
    guestIp: '172.16.0.9',
    net: { tap: 'fctap1', guestIp: '172.16.0.9' },
    rootfs: join(dir, `${id}.cow`),
    vcpus: 2,
    memoryMB: 1024,
    vmClass: 'standard',
  } as unknown as FcVmHandle
}

/**
 * `snapshotVM` stops the process (as Firecracker does) and then waits on
 * `snapshotted` so the test can run the reaper inside the suspend's window.
 */
function makePool() {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    poolSize: 0,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })

  const alive = new Set<string>()
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let reached!: () => void
  const snapshotted = new Promise<void>((r) => (reached = r))

  const mgr = {
    procCount: () => alive.size,
    isRunning: (h: FcVmHandle) => alive.has(h.id),
    stopVM: async (h: FcVmHandle) => void alive.delete(h.id),
    snapshotVM: async (h: FcVmHandle): Promise<FcSnapshot> => {
      alive.delete(h.id)
      reached()
      await gate
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
  for (const m of ['saveBackupToStore', 'saveWorkspaceMembersToStore', 'saveProjectDataToStore', 'saveRepoToStore']) {
    ;(pool as any)[m] = async () => undefined
  }
  return { pool, alive, pushed, snapshotted, release: () => release() }
}

describe('reapDeadAssigned() during a suspend', () => {
  test('leaves a suspending VM to the suspend, which then pushes its snapshot', async () => {
    const { pool, alive, pushed, snapshotted, release } = makePool()
    const handle = handleFor('fcvm-15027')
    alive.add(handle.id)
    pool.seed('ws:29a33728', handle)

    const suspending = pool.suspend('ws:29a33728')
    await snapshotted
    expect(alive.has(handle.id)).toBe(false)

    expect(await pool.reapDeadAssigned()).toEqual([])
    expect(pool.rescued).toEqual([])

    release()
    await suspending
    expect(pool.isAssigned('ws:29a33728')).toBe(false)
    expect(pushed).toEqual(['ws:29a33728'])
    expect(pool.rescued).toEqual([])
  })

  test('still reaps a VM that died with nothing in flight', async () => {
    const { pool, alive } = makePool()
    const live = handleFor('fcvm-live')
    alive.add(live.id)
    pool.seed('alive', live)
    pool.seed('crashed', handleFor('fcvm-crashed'))

    expect(await pool.reapDeadAssigned()).toEqual(['crashed'])
    expect(pool.rescued).toEqual(['crashed:reaper: fc process gone'])
    expect(pool.isAssigned('alive')).toBe(true)
    expect(pool.isAssigned('crashed')).toBe(false)
  })
})
