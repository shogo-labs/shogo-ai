// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool — write-side "save on stop" durability.
 *
 * The regression this guards: metal edits are only durable via the local/S3
 * SNAPSHOT. If a project resumes on a DIFFERENT metal machine that has no
 * snapshot (a genuine miss), the cold-boot fallback hydrates
 * `{projectId}/project-src.tar.gz` — which metal never refreshed, so the user
 * would see stale source. The fix pulls the latest source from the (still-live)
 * guest on suspend and uploads it host-side to that durable key.
 *
 * We drive the seams directly (`fetchExport` over a stubbed global `fetch`,
 * `uploadBackupGuarded` recorded) so no real guest / S3 / Firecracker is needed.
 *
 * The guard: `saveBackupToStore` must only overwrite the durable backup a
 * workspace descends from (lineage = `backupParentEtag`). A template-origin VM,
 * or one whose lineage no longer matches, is diverted to a quarantine key
 * (`conflict`) rather than clobbering the real backup — the data-loss incident
 * these tests pin down.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool, type AssignedVm } from './pool'
import { M, metrics } from './metrics'
import type { BackupWriteOutcome } from './workspace-archive'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const HANDLE = { id: 'vm-1', agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any

class TestPool extends MetalWarmPool {
  uploads: Array<{ projectId: string; bytes: Uint8Array; opts: { parentEtag?: string; adoptWhenUnknown?: boolean } }> = []
  outcome: BackupWriteOutcome = { status: 'written', etag: '"new"' }
  protected override uploadBackupGuarded(
    projectId: string,
    bytes: Uint8Array,
    opts: { parentEtag?: string; adoptWhenUnknown?: boolean },
  ): Promise<BackupWriteOutcome> {
    this.uploads.push({ projectId, bytes, opts })
    return Promise.resolve(this.outcome)
  }
  export(token?: string) {
    return (this as any).fetchExport(HANDLE, token) as Promise<Uint8Array | null>
  }
  save(projectId: string, runtimeToken?: string, extra: Partial<AssignedVm> = {}) {
    ;(this as any).assigned.set(projectId, {
      projectId,
      handle: HANDLE,
      assignedAt: Date.now(),
      lastTouchedAt: Date.now(),
      runtimeToken,
      ...extra,
    })
    return (this as any).saveBackupToStore((this as any).assigned.get(projectId))
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

describe('pool write-side backup (save on stop)', () => {
  let dir: string
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-backup-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  test('fetchExport POSTs to guest /pool/export with the runtime token', async () => {
    const pool = makePool(dir)
    const calls: Array<{ url: string; init: any }> = []
    globalThis.fetch = mock(async (url: any, init: any) => {
      calls.push({ url: String(url), init })
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }) as any

    const bytes = await pool.export('secret-token')
    expect(calls[0].url).toBe('http://10.0.0.9:8080/pool/export')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers.Authorization).toBe('Bearer secret-token')
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('fetchExport returns null on 204 (empty/new workspace)', async () => {
    const pool = makePool(dir)
    globalThis.fetch = mock(async () => new Response(null, { status: 204 })) as any
    expect(await pool.export('tok')).toBeNull()
  })

  test('fetchExport throws when the guest rejects', async () => {
    const pool = makePool(dir)
    globalThis.fetch = mock(async () => new Response('boom', { status: 500 })) as any
    await expect(pool.export('tok')).rejects.toThrow(/\/pool\/export failed \(500\)/)
  })

  test('saveBackupToStore uploads the packed source to the durable store', async () => {
    const pool = makePool(dir)
    globalThis.fetch = mock(async () => new Response(new Uint8Array([5, 6, 7, 8]), { status: 200 })) as any

    await pool.save('p1', 'tok', { workspaceOrigin: 'backup', backupParentEtag: '"parent"' })
    expect(pool.uploads).toHaveLength(1)
    expect(pool.uploads[0].projectId).toBe('p1')
    expect(pool.uploads[0].bytes).toEqual(new Uint8Array([5, 6, 7, 8]))
  })

  test('saveBackupToStore is a no-op upload when the guest has nothing to back up', async () => {
    const pool = makePool(dir)
    globalThis.fetch = mock(async () => new Response(null, { status: 204 })) as any

    await pool.save('empty', 'tok')
    expect(pool.uploads).toHaveLength(0)
  })

  test('passes the workspace lineage (parentEtag) to the guard, and does NOT adopt for a backup origin', async () => {
    const pool = makePool(dir)
    globalThis.fetch = mock(async () => new Response(new Uint8Array([1]), { status: 200 })) as any

    await pool.save('p1', 'tok', { workspaceOrigin: 'backup', backupParentEtag: '"parent"' })
    expect(pool.uploads[0].opts).toEqual({ parentEtag: '"parent"', adoptWhenUnknown: false })
  })

  test('allows a legacy snapshot origin (no stamped etag) to adopt on write', async () => {
    const pool = makePool(dir)
    globalThis.fetch = mock(async () => new Response(new Uint8Array([1]), { status: 200 })) as any

    await pool.save('p1', 'tok', { workspaceOrigin: 'snapshot' })
    expect(pool.uploads[0].opts).toEqual({ parentEtag: undefined, adoptWhenUnknown: true })
  })

  test('a template origin never adopts (adoptWhenUnknown:false)', async () => {
    const pool = makePool(dir)
    globalThis.fetch = mock(async () => new Response(new Uint8Array([1]), { status: 200 })) as any

    await pool.save('p1', 'tok', { workspaceOrigin: 'template' })
    expect(pool.uploads[0].opts.adoptWhenUnknown).toBe(false)
  })

  test('a successful write re-anchors the lineage to the new etag (so later suspends keep passing the guard)', async () => {
    const pool = makePool(dir)
    pool.outcome = { status: 'written', etag: '"fresh"' }
    globalThis.fetch = mock(async () => new Response(new Uint8Array([9]), { status: 200 })) as any

    await pool.save('p1', 'tok', { workspaceOrigin: 'backup', backupParentEtag: '"old"' })
    const a = pool.assignedEntry('p1')!
    expect(a.backupParentEtag).toBe('"fresh"')
    expect(a.workspaceOrigin).toBe('backup')
  })

  test('a conflict quarantines: bumps the metric and leaves the durable lineage UNCHANGED (no clobber)', async () => {
    const pool = makePool(dir)
    pool.outcome = { status: 'conflict', quarantineKey: 'p1/conflict/123-abc.tar.gz', currentEtag: '"real"' }
    globalThis.fetch = mock(async () => new Response(new Uint8Array([3, 3, 7]), { status: 200 })) as any

    const before = metrics.getCounter(M.backupConflict)
    await pool.save('p1', 'tok', { workspaceOrigin: 'template' })
    expect(metrics.getCounter(M.backupConflict)).toBe(before + 1)
    // Lineage must NOT be re-anchored on a conflict — the template did not
    // become the durable backup, so its "origin" stays template.
    const a = pool.assignedEntry('p1')!
    expect(a.workspaceOrigin).toBe('template')
    expect(a.backupParentEtag).toBeUndefined()
  })
})
