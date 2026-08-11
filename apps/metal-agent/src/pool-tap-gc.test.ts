// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The pool's half of tap-device lifecycle: releasing a /30 when the snapshot that
 * owned it goes away, and telling the GC sweep which indices are still in use.
 *
 * Both exist because of the same production failure. A host has 16384 /30 blocks;
 * a suspended VM keeps its `fctap<n>` so it can restore onto it cheaply, so
 * dropping a snapshot is the only moment that device becomes free. Every eviction
 * path used to leave it behind, the address space filled with devices belonging to
 * nothing, and the allocator eventually ran past the end of the /16 and derived
 * `172.16.8282.225/30` — every /assign 500ing, project runtimes hung on
 * "starting up…".
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CacheIndex, type CacheEntry } from './cache-index'
import { config } from './config'
import { metrics } from './metrics'
import { deriveNet } from './net'
import { MetalWarmPool } from './pool'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotMeta, SnapshotStore } from './snapshot-store'

class FakeStore implements SnapshotStore {
  readonly kind = 'fs' as const
  readonly slim = false
  removed: string[] = []
  async push(): Promise<void> {}
  async head(projectId: string): Promise<SnapshotMeta | null> {
    return {
      projectId,
      net: deriveNet(0),
      vcpus: 2,
      memoryMB: 1024,
      bytesMem: 1000,
      bytesState: 100,
      createdAt: 1,
      rootfsPath: `/run/${projectId}.rootfs.ext4`,
      rootfsIdentity: 'test-id',
      v: 1,
    }
  }
  async pull(): Promise<null> {
    return null
  }
  async remove(projectId: string): Promise<void> {
    this.removed.push(projectId)
  }
  async ensureBase(): Promise<void> {}
  async pullBase(): Promise<boolean> {
    return false
  }
}

function makePool(dir: string, mgrOver: Partial<FirecrackerVMManager> = {}) {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    dmCowDir: join(dir, 'cow'),
    rootfsCow: 'full' as const,
    rootfsIdentity: 'test-id',
    durableActiveWindowMs: 1000,
  }
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const releasedTaps: string[] = []
  const fakeMgr = {
    releaseRootfs: (p: string) => rmSync(p, { force: true }),
    releaseTap: (net: { tap: string }) => releasedTaps.push(net.tap),
    rootfsDeviceMapped: () => false,
    procCount: () => 0,
    reapOrphans: () => 0,
    reconcileOrphanTaps: () => ({ removed: 0, suspected: 0, inUse: 0 }),
    ...mgrOver,
  } as unknown as FirecrackerVMManager
  return { pool: new MetalWarmPool(fakeMgr, cfg, new FakeStore()), cfg, releasedTaps }
}

/** A suspended project holding tap index `n`. */
function seed(cfg: any, projectId: string, n: number) {
  const snapshotPath = join(cfg.snapDir, `${projectId}.vmstate`)
  const memFilePath = join(cfg.snapDir, `${projectId}.mem`)
  const rootfs = join(cfg.runDir, `${projectId}.rootfs.ext4`)
  for (const p of [snapshotPath, memFilePath, rootfs]) writeFileSync(p, 'x')
  const e: CacheEntry = {
    projectId,
    vmId: `vm-${projectId}`,
    snapshotPath,
    memFilePath,
    rootfs,
    net: deriveNet(n),
    vcpus: 2,
    memoryMB: 1024,
    bytesMem: 1000,
    bytesState: 100,
    bytesRootfs: 5000,
    createdAt: 1,
    suspendedAt: 100,
    lastAccessAt: 100,
    rootfsIdentity: 'test-id',
    v: 1,
  }
  new CacheIndex(cfg.snapDir).put(e)
}

describe('pool tap lifecycle', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-tap-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('evicting a snapshot releases its /30', async () => {
    const { pool, cfg, releasedTaps } = makePool(dir)
    seed(cfg, 'a', 12)
    pool.rehydrate()

    expect(await pool.evictForGc('a')).toBe(true)
    expect(releasedTaps).toEqual(['fctap12'])
  })

  test('destroying a suspended project releases its /30', async () => {
    const { pool, cfg, releasedTaps } = makePool(dir)
    seed(cfg, 'a', 30)
    pool.rehydrate()

    await pool.destroy('a')
    expect(releasedTaps).toEqual(['fctap30'])
  })

  test('does NOT release a tap a running VM restored onto', async () => {
    // A resumed project can still carry a `suspended` entry pointing at the net
    // its live VM is now using. Tearing that device down would cut a running
    // guest's network — strictly worse than leaking one /30.
    const { pool, cfg, releasedTaps } = makePool(dir)
    seed(cfg, 'a', 7)
    pool.rehydrate()
    ;(pool as any).assigned.set('a', {
      projectId: 'a',
      handle: { id: 'fcr-a', net: deriveNet(7) },
      assignedAt: Date.now(),
    })

    await pool.evictForGc('a').catch(() => {})
    ;(pool as any).evictLocal('a')

    expect(releasedTaps).toEqual([])
  })

  test('the sweep is told every index a warm, assigned or suspended VM holds', () => {
    let keep = new Set<number>()
    const { pool, cfg } = makePool(dir, {
      reconcileOrphanTaps: ((k: Set<number>) => {
        keep = k
        return { removed: 0, suspected: 0, inUse: k.size }
      }) as any,
    })
    seed(cfg, 'suspended-proj', 4)
    pool.rehydrate()
    ;(pool as any).available.push({ handle: { id: 'fcvm-1', net: deriveNet(1) } })
    ;(pool as any).assigned.set('running', {
      projectId: 'running',
      handle: { id: 'fcvm-2', net: deriveNet(2) },
      assignedAt: Date.now(),
    })

    pool.reapOrphanTaps()

    // 4 is the load-bearing one: a suspended VM has no process, so nothing else
    // vouches for its index — and handing that index to a fresh VM means the
    // resume's setupTap yanks the device out from under a live guest.
    expect([...keep].sort((a, b) => a - b)).toEqual([1, 2, 4])
  })

  test('reports reclaimed taps and publishes the capacity gauge', () => {
    const { pool } = makePool(dir, {
      reconcileOrphanTaps: (() => ({ removed: 3, suspected: 5, inUse: 40 })) as any,
    })

    expect(pool.reapOrphanTaps()).toBe(3)
    const { counters, gauges } = metrics.snapshot()
    expect(counters.metal_gc_taps_reclaimed_total).toBeGreaterThanOrEqual(3)
    expect(gauges.metal_taps_in_use).toBe(40)
    expect(gauges.metal_tap_capacity).toBe(16384)
  })
})
