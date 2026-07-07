// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool.destroy / pool.getProjectStatus — the node-agent side of the substrate
 * lifecycle parity (project DELETE + status). Driven with a fake VM manager and
 * durable store (no real Firecracker host), same harness as pool-gc.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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
  constructor(private identity: string) {}
  async push(): Promise<void> {}
  async head(projectId: string): Promise<SnapshotMeta | null> {
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

function makePool(dir: string, store: SnapshotStore) {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    dmCowDir: join(dir, 'cow'),
    rootfsCow: 'full' as const,
    rootfsIdentity: 'test-id',
    ...({} as Partial<typeof config>),
  }
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = {
    releaseRootfs: (p: string) => rmSync(p, { force: true }),
    rootfsDeviceMapped: () => false,
    procCount: () => 0,
    reapOrphans: () => 0,
  } as unknown as FirecrackerVMManager
  return { pool: new MetalWarmPool(fakeMgr, cfg, store), cfg }
}

function seed(cfg: any, projectId: string) {
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
    suspendedAt: 100,
    lastAccessAt: 100,
    rootfsIdentity: 'test-id',
    v: 1,
  }
  new CacheIndex(cfg.snapDir).put(e)
  return { snapshotPath, memFilePath, rootfs }
}

describe('pool.destroy / getProjectStatus', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-destroy-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('destroy removes a suspended project locally AND durably', async () => {
    const store = new FakeStore('test-id')
    const { pool, cfg } = makePool(dir, store)
    const a = seed(cfg, 'p1')
    pool.rehydrate()

    const report = await pool.destroy('p1')
    expect(report.removedLocal).toBe(true)
    expect(report.removedDurable).toBe(true)
    expect(existsSync(a.snapshotPath)).toBe(false)
    expect(existsSync(a.rootfs)).toBe(false)
    expect(new CacheIndex(cfg.snapDir).get('p1')).toBeNull()
    expect(store.removed).toEqual(['p1'])
    expect(pool.status().suspended).toEqual([])
  })

  test('destroy of an absent project is a harmless no-op', async () => {
    const store = new FakeStore('test-id')
    const { pool } = makePool(dir, store)
    const report = await pool.destroy('never-existed')
    expect(report.stoppedVm).toBe(false)
    expect(report.removedLocal).toBe(false)
    // With a durable store present, remove() is still attempted (idempotent).
    expect(report.removedDurable).toBe(true)
  })

  test('destroy does not attempt a durable remove when the store is disabled', async () => {
    // store=none path: no durable copy to remove.
    const { pool, cfg } = makePool(dir, { kind: 'none' } as unknown as SnapshotStore)
    seed(cfg, 'p1')
    pool.rehydrate()
    const report = await pool.destroy('p1')
    expect(report.removedLocal).toBe(true)
    expect(report.removedDurable).toBe(false)
  })

  test('getProjectStatus reflects suspended vs absent', async () => {
    const store = new FakeStore('test-id')
    const { pool, cfg } = makePool(dir, store)
    seed(cfg, 'p1')
    pool.rehydrate()

    expect(pool.getProjectStatus('p1')).toEqual({ exists: true, ready: false, replicas: 0, state: 'suspended' })
    expect(pool.getProjectStatus('nope')).toEqual({ exists: false, ready: false, replicas: 0, state: 'none' })
  })
})
