// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Periodic source backups for long-resident VMs (pool.exportAllSource), and the
 * per-runtime serialization that keeps them from racing the suspend-time one.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { KeyedMutex } from './concurrency'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { FcVmHandle, FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const EVERY = 60_000

class TestPool extends MetalWarmPool {
  exports: string[] = []
  stored: Array<{ projectId: string; bytes: string }> = []
  exportDelayMs = 0
  private seq = 0

  protected override async fetchExport(handle: FcVmHandle): Promise<Uint8Array | null> {
    const n = ++this.seq
    this.exports.push(handle.id)
    if (this.exportDelayMs) await Bun.sleep(this.exportDelayMs)
    return new TextEncoder().encode(`export-${n}`)
  }

  constructor(...args: ConstructorParameters<typeof MetalWarmPool>) {
    super(...args)
    ;(this as any).storeSource = async (a: AssignedVm, bytes: Uint8Array) => {
      this.stored.push({ projectId: a.projectId, bytes: new TextDecoder().decode(bytes) })
      return 'written'
    }
  }

  seed(projectId: string, fields: Partial<AssignedVm>): AssignedVm {
    const now = Date.now()
    const a: AssignedVm = {
      projectId,
      handle: { id: `vm-${projectId}`, agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any,
      assignedAt: now,
      lastTouchedAt: now,
      lastRealActivityAt: now,
      alwaysOn: false,
      ...fields,
    }
    ;(this as any).assigned.set(projectId, a)
    return a
  }

  backup(projectId: string): Promise<string> {
    return (this as any).saveBackupToStore((this as any).assigned.get(projectId))
  }
}

function makePool(dir: string, sourceBackupIntervalMs = EVERY): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    sourceBackupIntervalMs,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = { procCount: () => 0, isRunning: () => true } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

describe('exportAllSource', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-periodic-src-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('backs up a VM resident past the interval that has seen activity, once per interval', async () => {
    const pool = makePool(dir)
    const now = Date.now()
    pool.seed('busy', { assignedAt: now - 2 * EVERY, lastRealActivityAt: now - 1000 })

    expect(await pool.exportAllSource(now)).toBe(1)
    expect(pool.stored.map((s) => s.projectId)).toEqual(['busy'])
    // Same pass window again: nothing new to do.
    expect(await pool.exportAllSource(now + 1000)).toBe(0)
    expect(pool.stored).toHaveLength(1)
  })

  test('skips VMs that are new, or idle since their last backup', async () => {
    const pool = makePool(dir)
    const now = Date.now()
    pool.seed('fresh', { assignedAt: now - 1000, lastRealActivityAt: now })
    pool.seed('idle-tail', { assignedAt: now - 10 * EVERY, lastRealActivityAt: now - 10 * EVERY })
    const backedUp = pool.seed('unchanged', {
      assignedAt: now - 10 * EVERY,
      lastRealActivityAt: now - 5 * EVERY,
      lastPeriodicSourceBackupAt: now - 2 * EVERY,
    })

    expect(await pool.exportAllSource(now)).toBe(0)
    expect(pool.exports).toEqual([])
    expect(backedUp.lastPeriodicSourceBackupAt).toBe(now - 2 * EVERY)
  })

  test('is off at interval 0', async () => {
    const pool = makePool(dir, 0)
    pool.seed('busy', { assignedAt: Date.now() - 10 * EVERY })
    expect(await pool.exportAllSource()).toBe(0)
  })

  test('a suspend-time backup started during a periodic one exports its own, newer bytes after it', async () => {
    const pool = makePool(dir)
    const now = Date.now()
    pool.seed('busy', { assignedAt: now - 2 * EVERY, lastRealActivityAt: now - 1000 })
    pool.exportDelayMs = 20

    const periodic = pool.exportAllSource(now)
    await Bun.sleep(5)
    const atSuspend = pool.backup('busy')
    await Promise.all([periodic, atSuspend])

    expect(pool.stored.map((s) => s.bytes)).toEqual(['export-1', 'export-2'])
  })
})

describe('KeyedMutex', () => {
  test('serializes per key, runs every call, and survives a throw', async () => {
    const m = new KeyedMutex()
    const order: string[] = []
    const slow = (tag: string, ms: number) => async () => {
      order.push(`${tag}:start`)
      await Bun.sleep(ms)
      order.push(`${tag}:end`)
      return tag
    }
    const a = m.run('k', slow('a', 15))
    const b = m.run('k', async () => {
      throw new Error('boom')
    })
    const c = m.run('k', slow('c', 1))
    const other = m.run('other', slow('o', 1))

    expect(await a).toBe('a')
    await expect(b).rejects.toThrow('boom')
    expect(await c).toBe('c')
    expect(await other).toBe('o')
    expect(order.indexOf('c:start')).toBeGreaterThan(order.indexOf('a:end'))
    expect(order.indexOf('o:start')).toBeLessThan(order.indexOf('a:end'))
  })
})
