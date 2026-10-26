// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Warm-pool refill after failed boots. Right after an agent restart the host
 * is busy re-adopting its VMs and warm boots often fail. Nothing retried
 * them, and a claim only refilled the pool when it found a VM, so the pool
 * stayed empty and every open cold-booted until the next restart.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config, type MetalConfig } from './config'
import type { FcVmConfig, FcVmHandle } from './firecracker-vm-manager'
import { MetalWarmPool } from './pool'
import type { SnapshotStore } from './snapshot-store'

const dirs: string[] = []
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeGuest() {
  const server = Bun.serve({ port: 0, fetch: () => new Response('ok') })
  cleanups.push(() => server.stop(true))
  return server
}

/** A manager whose first `failFirst` boots fail the way a busy host does. */
function flakyMgr(guestPort: number, failFirst: number) {
  let n = 0
  return {
    async startVM(cfg: FcVmConfig = {}): Promise<FcVmHandle> {
      n++
      if (n <= failFirst) throw new Error(`FC API socket never appeared: /tmp/fake-${n}.sock`)
      return {
        id: `vm-${n}`,
        agentUrl: `http://127.0.0.1:${guestPort}`,
        guestIp: '127.0.0.1',
        pid: 1000 + n,
        platform: 'linux',
        net: { tap: `fctap${n}`, guestIp: '127.0.0.1' } as any,
        rootfs: `/tmp/fake-rootfs-${n}`,
        socketPath: `/tmp/fake-${n}.sock`,
        serialLog: `/tmp/fake-${n}.serial`,
        vcpus: cfg.cpus ?? 2,
        memoryMB: cfg.memoryMB ?? 1024,
        vmClass: cfg.vmClass ?? 'standard',
      }
    },
    async stopVM(): Promise<void> {},
    isRunning: () => true,
    procCount: () => 0,
    reapHostOrphans: () => 0,
    adoptVM: () => {},
    durableRootfs: () => ({ path: '/tmp/x.rootfs', mode: 'full' }),
    restoreRootfsArtifactPath: (p: string) => p,
  }
}

function makeCfg(poolSize: number): MetalConfig {
  const dir = mkdtempSync(join(tmpdir(), 'poolrefill-'))
  dirs.push(dir)
  const snapDir = join(dir, 'snap')
  const runDir = join(dir, 'run')
  mkdirSync(snapDir, { recursive: true })
  mkdirSync(runDir, { recursive: true })
  const baseRootfs = join(dir, 'rootfs.ext4')
  writeFileSync(baseRootfs, Buffer.alloc(1024))
  return {
    ...config,
    work: dir,
    snapDir,
    runDir,
    baseRootfs,
    poolSize,
    poolBootConcurrency: 2,
    snapStore: 'none',
    dockerClass: { ...config.dockerClass, baseRootfs: '', poolSize: 0 },
  } as MetalConfig
}

function standardAvailable(pool: MetalWarmPool): number {
  return pool.status().classes.find((c) => c.vmClass === 'standard')!.available
}

describe('warm pool refill', () => {
  test('a claim that finds the pool empty refills it', async () => {
    const guest = makeGuest()
    const pool = new MetalWarmPool(flakyMgr(guest.port, 2) as any, makeCfg(2), { kind: 'none' } as unknown as SnapshotStore)
    await pool.start()
    expect(standardAvailable(pool)).toBe(0)

    expect((pool as any).claim('standard')).toBeNull()
    await (pool as any).reconciling
    expect(standardAvailable(pool)).toBe(2)
  })

  test('reconcile retries a fill whose boots failed', async () => {
    const guest = makeGuest()
    const pool = new MetalWarmPool(flakyMgr(guest.port, 2) as any, makeCfg(2), { kind: 'none' } as unknown as SnapshotStore)
    await pool.start()
    expect(standardAvailable(pool)).toBe(0)

    await pool.reconcile()
    expect(standardAvailable(pool)).toBe(2)
  })

  test('a claim that takes a VM replaces it', async () => {
    const guest = makeGuest()
    const pool = new MetalWarmPool(flakyMgr(guest.port, 0) as any, makeCfg(2), { kind: 'none' } as unknown as SnapshotStore)
    await pool.start()
    expect(standardAvailable(pool)).toBe(2)

    expect((pool as any).claim('standard')).not.toBeNull()
    await (pool as any).reconciling
    expect(standardAvailable(pool)).toBe(2)
  })
})
