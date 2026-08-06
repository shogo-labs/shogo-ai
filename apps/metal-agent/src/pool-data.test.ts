// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool — writable-state durability wiring (database + uploads).
 *
 * Companion to pool-backup.test.ts, which covers the SOURCE archive. Source
 * durability was never enough: a snapshot is not a backup, so when a
 * golden-rootfs rebuild invalidated every snapshot at once, the cold boot that
 * followed restored code over an empty database and the user's data was gone.
 *
 * These drive the seams directly (`fetchDataExport` over a stubbed global
 * `fetch`, `uploadDataGuarded` recorded), so no real guest / S3 / Firecracker
 * is needed.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool, type AssignedVm } from './pool'
import { M, metrics } from './metrics'
import type { DataWriteOutcome } from './project-data-archive'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const HANDLE = { id: 'vm-1', agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any

class TestPool extends MetalWarmPool {
  uploads: Array<{ projectId: string; bytes: Uint8Array; opts: { parentEtag?: string } }> = []
  outcome: DataWriteOutcome = { status: 'written', etag: '"new"' }
  protected override uploadDataGuarded(
    projectId: string,
    bytes: Uint8Array,
    opts: { parentEtag?: string },
  ): Promise<DataWriteOutcome> {
    this.uploads.push({ projectId, bytes, opts })
    return Promise.resolve(this.outcome)
  }
  exportData(token?: string) {
    return (this as any).fetchDataExport(HANDLE, token) as Promise<Uint8Array | null>
  }
  save(projectId: string, runtimeToken?: string, extra: Partial<AssignedVm> = {}) {
    if (!(this as any).assigned.has(projectId)) {
      ;(this as any).assigned.set(projectId, {
        projectId,
        handle: HANDLE,
        assignedAt: Date.now(),
        lastTouchedAt: Date.now(),
        runtimeToken,
        ...extra,
      })
    }
    return this.saveProjectDataToStore((this as any).assigned.get(projectId)) as Promise<boolean>
  }
  assignedEntry(projectId: string): AssignedVm | undefined {
    return (this as any).assigned.get(projectId)
  }
}

function makePool(dir: string): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    hydrateTimeoutMs: 5000,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = { procCount: () => 0 } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

describe('pool writable-state durability', () => {
  let dir: string
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-data-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  test('fetchDataExport POSTs to guest /pool/export-data with the runtime token', async () => {
    const pool = makePool(dir)
    const calls: Array<{ url: string; init: any }> = []
    globalThis.fetch = mock(async (url: any, init: any) => {
      calls.push({ url: String(url), init })
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }) as any

    const bytes = await pool.exportData('secret-token')
    expect(calls[0].url).toBe('http://10.0.0.9:8080/pool/export-data')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers.Authorization).toBe('Bearer secret-token')
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('fetchDataExport returns null on 204 (project has no writable state)', async () => {
    const pool = makePool(dir)
    globalThis.fetch = mock(async () => new Response(null, { status: 204 })) as any
    expect(await pool.exportData('tok')).toBeNull()
  })

  test('fetchDataExport throws when the guest rejects', async () => {
    const pool = makePool(dir)
    globalThis.fetch = mock(async () => new Response('boom', { status: 500 })) as any
    await expect(pool.exportData('tok')).rejects.toThrow(/\/pool\/export-data failed \(500\)/)
  })

  test('a project with no writable state uploads nothing', async () => {
    const pool = makePool(dir)
    globalThis.fetch = mock(async () => new Response(null, { status: 204 })) as any

    expect(await pool.save('p1', 'tok')).toBe(false)
    expect(pool.uploads).toHaveLength(0)
  })

  test('saveProjectDataToStore uploads the packed writable state with its lineage', async () => {
    const pool = makePool(dir)
    globalThis.fetch = mock(async () => new Response(new Uint8Array([5, 6, 7, 8]), { status: 200 })) as any

    await pool.save('p1', 'tok', { dataParentEtag: '"parent"' })
    expect(pool.uploads).toHaveLength(1)
    expect(pool.uploads[0].projectId).toBe('p1')
    expect(pool.uploads[0].bytes).toEqual(new Uint8Array([5, 6, 7, 8]))
    expect(pool.uploads[0].opts).toEqual({ parentEtag: '"parent"' })
  })

  test('a successful write re-anchors lineage so later exports keep passing the guard', async () => {
    const pool = makePool(dir)
    pool.outcome = { status: 'written', etag: '"fresh"' }
    globalThis.fetch = mock(async () => new Response(new Uint8Array([9]), { status: 200 })) as any

    await pool.save('p1', 'tok', { dataParentEtag: '"old"' })
    expect(pool.assignedEntry('p1')!.dataParentEtag).toBe('"fresh"')
  })

  test('unchanged writable state is skipped on the next cycle (periodic export stays cheap)', async () => {
    const pool = makePool(dir)
    globalThis.fetch = mock(async () => new Response(new Uint8Array([1, 1, 1]), { status: 200 })) as any

    expect(await pool.save('p1', 'tok')).toBe(true)
    expect(await pool.save('p1', 'tok')).toBe(false)
    expect(pool.uploads).toHaveLength(1)
  })

  test('changed writable state uploads again', async () => {
    const pool = makePool(dir)
    let body = new Uint8Array([1, 1, 1])
    globalThis.fetch = mock(async () => new Response(body, { status: 200 })) as any

    await pool.save('p1', 'tok')
    body = new Uint8Array([2, 2, 2])
    expect(await pool.save('p1', 'tok')).toBe(true)
    expect(pool.uploads).toHaveLength(2)
  })

  test('a collapse conflict bumps BOTH metrics and leaves lineage UNCHANGED (no clobber)', async () => {
    const pool = makePool(dir)
    pool.outcome = {
      status: 'conflict',
      quarantineKey: 'conflict/p1/123-abc-data.tar.gz',
      currentEtag: '"real"',
      reason: 'collapse',
    }
    globalThis.fetch = mock(async () => new Response(new Uint8Array([3, 3, 7]), { status: 200 })) as any

    const conflictBefore = metrics.getCounter(M.dataConflict)
    const collapseBefore = metrics.getCounter(M.dataCollapseBlocked)
    // A VM that cold-booted with a fresh database and no data lineage — the
    // exact shape of the loss this guard exists to stop.
    expect(await pool.save('p1', 'tok')).toBe(false)
    expect(metrics.getCounter(M.dataConflict)).toBe(conflictBefore + 1)
    expect(metrics.getCounter(M.dataCollapseBlocked)).toBe(collapseBefore + 1)
    expect(pool.assignedEntry('p1')!.dataParentEtag).toBeUndefined()
  })

  test('a lineage conflict bumps only the conflict metric', async () => {
    const pool = makePool(dir)
    pool.outcome = {
      status: 'conflict',
      quarantineKey: 'conflict/p1/456-def-data.tar.gz',
      currentEtag: '"real"',
      reason: 'lineage',
    }
    globalThis.fetch = mock(async () => new Response(new Uint8Array([4]), { status: 200 })) as any

    const collapseBefore = metrics.getCounter(M.dataCollapseBlocked)
    const conflictBefore = metrics.getCounter(M.dataConflict)
    await pool.save('p1', 'tok', { dataParentEtag: '"stale"' })
    expect(metrics.getCounter(M.dataConflict)).toBe(conflictBefore + 1)
    expect(metrics.getCounter(M.dataCollapseBlocked)).toBe(collapseBefore)
  })

  test('a conflict does NOT mark the content as uploaded — the next cycle retries', async () => {
    const pool = makePool(dir)
    pool.outcome = {
      status: 'conflict',
      quarantineKey: 'conflict/p1/789-ghi-data.tar.gz',
      currentEtag: '"real"',
      reason: 'lineage',
    }
    globalThis.fetch = mock(async () => new Response(new Uint8Array([8]), { status: 200 })) as any

    await pool.save('p1', 'tok')
    await pool.save('p1', 'tok')
    expect(pool.uploads).toHaveLength(2)
  })

  test('an oversized archive is metered and not persisted', async () => {
    const pool = makePool(dir)
    pool.outcome = { status: 'too-large', bytes: 2 * 1024 * 1024 * 1024, limit: 1024 * 1024 * 1024 }
    globalThis.fetch = mock(async () => new Response(new Uint8Array([1]), { status: 200 })) as any

    const before = metrics.getCounter(M.dataTooLarge)
    expect(await pool.save('p1', 'tok')).toBe(false)
    expect(metrics.getCounter(M.dataTooLarge)).toBe(before + 1)
    expect(pool.assignedEntry('p1')!.dataParentEtag).toBeUndefined()
  })

  test('exportAllProjectData covers every live VM, not just published ones', async () => {
    const pool = makePool(dir)
    globalThis.fetch = mock(async () => new Response(new Uint8Array([7]), { status: 200 })) as any
    for (const id of ['p1', 'p2', 'p3']) {
      ;(pool as any).assigned.set(id, {
        projectId: id,
        handle: HANDLE,
        assignedAt: Date.now(),
        lastTouchedAt: Date.now(),
        runtimeToken: 'tok',
      })
    }

    expect(await pool.exportAllProjectData()).toBe(3)
    expect(pool.uploads.map((u) => u.projectId).sort()).toEqual(['p1', 'p2', 'p3'])
  })

  test('one project failing does not stop the rest of the periodic sweep', async () => {
    const pool = makePool(dir)
    // Route by guest address: p1 sits on a host that errors, p2 on a healthy one.
    globalThis.fetch = mock(async (url: any) =>
      String(url).includes('10.0.0.9')
        ? new Response(new Uint8Array([7]), { status: 200 })
        : new Response('boom', { status: 500 }),
    ) as any
    ;(pool as any).assigned.set('p1', {
      projectId: 'p1',
      handle: { ...HANDLE, agentUrl: 'http://10.0.0.1:8080' },
      assignedAt: Date.now(),
      lastTouchedAt: Date.now(),
      runtimeToken: 'tok',
    })
    ;(pool as any).assigned.set('p2', {
      projectId: 'p2',
      handle: HANDLE,
      assignedAt: Date.now(),
      lastTouchedAt: Date.now(),
      runtimeToken: 'tok',
    })

    // p1's guest errors; p2 still gets persisted.
    expect(await pool.exportAllProjectData()).toBe(1)
    expect(pool.uploads.map((u) => u.projectId)).toEqual(['p2'])
  })
})
