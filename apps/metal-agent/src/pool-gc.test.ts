// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pool-level GC tests that DON'T need a real Firecracker host: they drive the
 * cache index, orphan reclaim, rehydrate, and guarded/forced eviction with a
 * fake VM manager (release = delete the file) and a fake durable store. The
 * live-VM lifecycle (boot/suspend/restore) is covered by e2e-lifecycle.ts on
 * the bare-metal host.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { CacheIndex, type CacheEntry } from './cache-index'
import { MetalWarmPool } from './pool'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotMeta, SnapshotStore } from './snapshot-store'

const net = {
  tap: 'fctap0',
  hostIp: '172.16.0.1',
  guestIp: '172.16.0.2',
  netmask: '255.255.255.252',
  guestMac: '06:00:AC:10:00:02',
  bootIpArg: 'ip=...',
}

class FakeStore implements SnapshotStore {
  readonly kind = 'fs' as const
  readonly slim = false
  removed: string[] = []
  constructor(
    private identity: string,
    private present = true,
  ) {}
  async push(): Promise<void> {}
  async head(projectId: string): Promise<SnapshotMeta | null> {
    if (!this.present) return null
    return {
      projectId,
      net,
      vcpus: 2,
      memoryMB: 1024,
      bytesMem: 1000,
      bytesState: 100,
      createdAt: 1,
      rootfsPath: `/run/${projectId}.rootfs.ext4`,
      rootfsIdentity: this.identity,
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

function makePool(
  dir: string,
  store: SnapshotStore,
  over: Partial<typeof config> = {},
  mgrOver: Partial<FirecrackerVMManager> = {},
) {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    dmCowDir: join(dir, 'cow'),
    rootfsCow: 'full' as const,
    rootfsIdentity: 'test-id',
    durableActiveWindowMs: 1000,
    ...over,
  }
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = {
    releaseRootfs: (p: string) => rmSync(p, { force: true }),
    // Default: no dm devices are mapped (so dm-mode orphan cow files reclaim).
    rootfsDeviceMapped: () => false,
    ...mgrOver,
  } as unknown as FirecrackerVMManager
  return { pool: new MetalWarmPool(fakeMgr, cfg, store), cfg }
}

/** Write an index entry plus its (real) artifact files so rehydrate accepts it. */
function seed(cfg: any, projectId: string, lastAccessAt: number) {
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
    net,
    vcpus: 2,
    memoryMB: 1024,
    bytesMem: 1000,
    bytesState: 100,
    bytesRootfs: 5000,
    createdAt: 1,
    suspendedAt: lastAccessAt,
    lastAccessAt,
    rootfsIdentity: 'test-id',
    v: 1,
  }
  new CacheIndex(cfg.snapDir).put(e)
  return { snapshotPath, memFilePath, rootfs }
}

describe('pool GC', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-pool-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('rehydrate restores locality from the index and drops entries with missing artifacts', () => {
    const { pool, cfg } = makePool(dir, new FakeStore('test-id'))
    seed(cfg, 'live', 100)
    // An index entry whose artifacts don't exist must be dropped on rehydrate.
    new CacheIndex(cfg.snapDir).put({
      ...(new CacheIndex(cfg.snapDir).get('live') as CacheEntry),
      projectId: 'ghost',
      snapshotPath: join(cfg.snapDir, 'ghost.vmstate'),
      memFilePath: join(cfg.snapDir, 'ghost.mem'),
      rootfs: join(cfg.runDir, 'ghost.rootfs.ext4'),
    })
    const n = pool.rehydrate()
    expect(n).toBe(1)
    const s = pool.status()
    expect(s.suspended.map((x) => x.projectId)).toEqual(['live'])
    expect(new CacheIndex(cfg.snapDir).get('ghost')).toBeNull()
  })

  test('reclaimOrphans deletes unreferenced files but keeps rehydrated ones', () => {
    const { pool, cfg } = makePool(dir, new FakeStore('test-id'))
    const live = seed(cfg, 'live', 100)
    pool.rehydrate()
    // Orphans: files no cache entry / running VM references. Backdate them past
    // the in-flight grace window so they qualify as genuine orphans.
    const orphanState = join(cfg.snapDir, 'fcvm-99.vmstate')
    const orphanMem = join(cfg.snapDir, 'fcvm-99.mem')
    const orphanRoot = join(cfg.runDir, 'fcvm-99.rootfs.ext4')
    const old = new Date(Date.now() - 10 * 60_000)
    for (const p of [orphanState, orphanMem, orphanRoot]) {
      writeFileSync(p, 'x')
      utimesSync(p, old, old)
    }

    const removed = pool.reclaimOrphans()
    expect(removed).toBe(3)
    expect(existsSync(orphanState)).toBe(false)
    expect(existsSync(orphanRoot)).toBe(false)
    // Rehydrated snapshot's artifacts are protected.
    expect(existsSync(live.snapshotPath)).toBe(true)
    expect(existsSync(live.rootfs)).toBe(true)
  })

  test('reclaimOrphans spares young in-flight artifacts (cold-boot/assign window)', () => {
    // Regression: a VM's rootfs/mem/vmstate exist on disk before the project is
    // recorded in `assigned`/`suspended` (mid cold-boot or mid-snapshot). A
    // map-only guard deleted them, torpedoing the subsequent durable push
    // ("artifact missing/empty"). Fresh (just-written) orphan-looking files
    // must be left alone until they age past the grace window.
    const { pool, cfg } = makePool(dir, new FakeStore('test-id'))
    pool.rehydrate()
    const youngState = join(cfg.snapDir, 'fcvm-inflight.vmstate')
    const youngMem = join(cfg.snapDir, 'fcvm-inflight.mem')
    const youngRoot = join(cfg.runDir, 'fcvm-inflight.rootfs.ext4')
    for (const p of [youngState, youngMem, youngRoot]) writeFileSync(p, 'x') // mtime = now

    const removed = pool.reclaimOrphans()
    expect(removed).toBe(0)
    expect(existsSync(youngState)).toBe(true)
    expect(existsSync(youngMem)).toBe(true)
    expect(existsSync(youngRoot)).toBe(true)
  })

  test('reclaimOrphans (dm) never reclaims a CoW whose mapper device is still live', () => {
    // Regression for the staging cold-start: a pooled VM claimed mid-assign is
    // briefly in neither `available` nor `assigned`, and its CoW mtime is
    // already past the age gate. The map+age guards alone unlinked that live
    // CoW, breaking the durable push ("rootfs missing/empty") and the local
    // resume ("dm CoW store missing") → forced cold boot. The live-device check
    // must spare it while a genuinely-detached CoW is still reclaimed.
    const liveVm = 'fcvm-102-live'
    const orphanVm = 'fcvm-77-orphan'
    const { pool, cfg } = makePool(
      dir,
      new FakeStore('test-id'),
      { rootfsCow: 'dm' as const },
      { rootfsDeviceMapped: (vmId: string) => vmId === liveVm },
    )
    mkdirSync(cfg.dmCowDir, { recursive: true })
    const liveCow = join(cfg.dmCowDir, `${liveVm}.cow`)
    const orphanCow = join(cfg.dmCowDir, `${orphanVm}.cow`)
    // Both aged well past the in-flight grace window (mtime cannot save them).
    const old = new Date(Date.now() - 10 * 60_000)
    for (const p of [liveCow, orphanCow]) {
      writeFileSync(p, 'x')
      utimesSync(p, old, old)
    }

    const removed = pool.reclaimOrphans()
    expect(removed).toBe(1)
    expect(existsSync(liveCow)).toBe(true) // device mapped → spared
    expect(existsSync(orphanCow)).toBe(false) // device gone → reclaimed
  })

  test('evictForGc refuses when the durable copy is absent (only local copy)', async () => {
    const { pool, cfg } = makePool(dir, new FakeStore('test-id', /*present*/ false))
    const a = seed(cfg, 'a', 100)
    pool.rehydrate()
    const ok = await pool.evictForGc('a')
    expect(ok).toBe(false)
    expect(existsSync(a.snapshotPath)).toBe(true) // not evicted
  })

  test('evictForGc drops local files + index when durably backed', async () => {
    const { pool, cfg } = makePool(dir, new FakeStore('test-id'))
    const a = seed(cfg, 'a', 100)
    pool.rehydrate()
    const ok = await pool.evictForGc('a')
    expect(ok).toBe(true)
    expect(existsSync(a.snapshotPath)).toBe(false)
    expect(existsSync(a.rootfs)).toBe(false)
    expect(new CacheIndex(cfg.snapDir).get('a')).toBeNull()
  })

  test('forced gcSweep evicts all backed entries; stale ones also drop the durable copy', async () => {
    const store = new FakeStore('test-id')
    const { pool, cfg } = makePool(dir, store, { durableActiveWindowMs: 1000 })
    const now = Date.now()
    seed(cfg, 'fresh', now) // within active window → keep durable
    seed(cfg, 'stale', now - 10_000) // older than window → drop durable too
    pool.rehydrate()

    const report = await pool.gcSweep({ force: true })
    expect(report.evicted.sort()).toEqual(['fresh', 'stale'])
    // Durable tiering: only the stale project's durable snapshot is removed.
    expect(store.removed).toEqual(['stale'])
    expect(pool.status().suspended).toEqual([])
  })
})
