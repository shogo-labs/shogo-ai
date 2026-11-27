// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-593 acceptance: the export ceiling is per destination, and a failed upload
 * never strands a spool file.
 *
 * Why this exists. The first cut of the spool used ONE 4 GiB ceiling for every
 * export kind. 4 GiB is the writable-state STORE's limit, and a workspace source
 * archive never goes there — it lands in workspace storage, which has no such
 * limit — so the largest real workspace on staging (a 4.33 GiB source export)
 * had its own backup refused on every suspend. That is worse than the memory
 * burst it replaced: silent, permanent, and only for the biggest customers.
 *
 * These cases pin the split at the seam that decides it (`spoolExport` via the
 * per-kind fetchers), not at a constant, so collapsing the two ceilings back
 * into one fails here.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { metrics, M } from './metrics'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const MiB = 1024 * 1024
const HANDLE = { id: 'vm-593', agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any

class TestPool extends MetalWarmPool {
  uploadHomeError: Error | null = null

  /** The three per-kind export seams, as `pool.ts` calls them. */
  sourceExport(handle: any) {
    return this.fetchExport(handle)
  }
  dataExport(handle: any) {
    return this.fetchDataExport(handle)
  }

  protected override uploadHomeGuarded(): Promise<any> {
    if (this.uploadHomeError) return Promise.reject(this.uploadHomeError)
    return Promise.resolve({ status: 'written' })
  }

  spoolFiles(): string[] {
    try {
      return readdirSync(this.exportSpoolDir)
    } catch {
      return []
    }
  }
  spoolDirSize(): number {
    return this.spoolFiles().length
  }
}

function makePool(dir: string, overrides: Partial<typeof config> = {}): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    hydrateTimeoutMs: 5000,
    // The shape that broke: writable state's store limit is the smaller number.
    exportMaxBytes: 1 * MiB,
    exportSourceMaxBytes: 3 * MiB,
    ...overrides,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = { procCount: () => 0 } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

const bodyOf = (mib: number) => new Uint8Array(mib * MiB)

describe('SHO-593 export ceilings are per destination', () => {
  let dir: string
  const realFetch = globalThis.fetch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qa-sho593-ceil-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  const stubExport = (url: string, mib: number) => {
    globalThis.fetch = (async (input: any) => {
      const target = String(input?.url ?? input)
      if (!target.endsWith(url)) throw new Error(`unexpected fetch ${target}`)
      return new Response(bodyOf(mib), { headers: { etag: '"tag-1"' } })
    }) as typeof fetch
  }

  test('the shipped defaults keep the source ceiling above the store’s limit', () => {
    // 4 GiB is the writable-state store's limit; a source archive is bigger by
    // nature (4.33 GiB measured on staging), so the two must not be equal.
    expect(config.exportSourceMaxBytes).toBeGreaterThan(config.exportMaxBytes)
    expect(config.exportSourceMaxBytes).toBeGreaterThan(4 * 1024 * MiB)
  })

  test('a source export larger than the writable-state limit is still backed up', async () => {
    const pool = makePool(dir)
    // 2 MiB: over `exportMaxBytes` (1 MiB), under `exportSourceMaxBytes` (3 MiB).
    stubExport('/pool/export', 2)

    const body = await pool.sourceExport(HANDLE)

    expect(body).not.toBeNull()
    expect((body as any).size).toBe(2 * MiB)
    // It really is on disk, not in memory.
    expect(pool.spoolFiles()).toHaveLength(1)
    rmSync((body as any).name, { force: true })
  })

  test('a writable-state export over the store limit is still refused', async () => {
    const pool = makePool(dir)
    stubExport('/pool/export-data', 2)
    const before = metrics.snapshot().counters[M.exportTooLarge] ?? 0

    // Refused loudly, not quietly: the caller records the failed backup.
    await expect(pool.dataExport(HANDLE)).rejects.toThrow(/export exceeds/)

    expect((metrics.snapshot().counters[M.exportTooLarge] ?? 0) - before).toBe(1)
    // A refused body leaves nothing behind to fill the spool.
    expect(pool.spoolFiles()).toHaveLength(0)
  })

  test('a source export over its own ceiling is refused and leaves nothing behind', async () => {
    const pool = makePool(dir)
    stubExport('/pool/export', 4) // over the 3 MiB source ceiling
    const before = metrics.snapshot().counters[M.exportTooLarge] ?? 0

    await expect(pool.sourceExport(HANDLE)).rejects.toThrow(/export exceeds/)

    expect((metrics.snapshot().counters[M.exportTooLarge] ?? 0) - before).toBe(1)
    expect(pool.spoolFiles()).toHaveLength(0)
  })

  test('a failed upload disposes the spool instead of stranding it', async () => {
    const pool = makePool(dir, { exportMaxBytes: 3 * MiB })
    pool.uploadHomeError = new Error('s3 put failed')
    stubExport('/pool/export-home', 2)
    const vm = {
      projectId: 'proj-593',
      handle: HANDLE,
      runtimeToken: 'tok',
      assignedAt: Date.now(),
      lastTouchedAt: Date.now(),
    } as unknown as AssignedVm

    await expect(pool.saveHomeStateToStore(vm, { final: true })).rejects.toThrow('s3 put failed')

    // The whole point of the `finally`: the multi-GiB spool is gone after a
    // throw, not left until the agent restarts.
    expect(pool.spoolDirSize()).toBe(0)
  })
})
