// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool — writable-state durability for WORKSPACE runtimes (`ws:` keys).
 *
 * A workspace runtime mounts each member project in its own subfolder
 * (`/app/workspace/<memberId>`), so each member's database must be exported
 * from that folder and backed up under the MEMBER's id, with its own lineage.
 * Exporting the runtime root (the single-project path) never finds a database,
 * which left every workspace project's data durable only inside its snapshot.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { ArchiveRef } from './archive-ref'
import type { DataLineage, DataWriteOutcome } from './project-data-archive'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const HANDLE = { id: 'vm-1', agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any
const KEY = 'ws:proj:anchor'

class TestPool extends MetalWarmPool {
  uploads: Array<{ projectId: string; bytes: Uint8Array; lineage: DataLineage }> = []
  outcomes: Record<string, DataWriteOutcome> = {}
  refs: Record<string, ArchiveRef | null | Error> = {}
  applied: Array<{ what: string; destDir?: string }> = []
  applyFails = new Set<string>()

  protected override async uploadDataGuarded(
    projectId: string,
    bytes: Uint8Array,
    opts: { lineage: DataLineage; preserveOnRefusal?: boolean },
  ): Promise<DataWriteOutcome> {
    this.uploads.push({ projectId, bytes, lineage: opts.lineage })
    return this.outcomes[projectId] ?? { status: 'written', etag: `"${projectId}-new"` }
  }

  protected override async projectDataRef(projectId: string): Promise<ArchiveRef | null> {
    const r = this.refs[projectId]
    if (r instanceof Error) throw r
    return r ?? null
  }

  add(extra: Partial<AssignedVm> = {}): AssignedVm {
    const a = {
      projectId: KEY,
      handle: HANDLE,
      assignedAt: Date.now(),
      lastTouchedAt: Date.now(),
      runtimeToken: 'tok',
      workspaceMemberIds: ['m1', 'm2'],
      ...extra,
    } as AssignedVm
    ;(this as any).assigned.set(KEY, a)
    ;(this as any).applyArchive = async (_h: any, _env: any, _ref: any, what: string, destDir?: string) => {
      if ([...this.applyFails].some((id) => what.startsWith(id))) throw new Error('guest rejected')
      this.applied.push({ what, destDir })
    }
    return a
  }

  hydrate(a: AssignedVm) {
    return (this as any).hydrateWorkspaceMemberData(a, { RUNTIME_AUTH_SECRET: 'tok' })
  }

  snapshotEtags(a: AssignedVm) {
    return (this as any).trustedMemberDataEtags(a)
  }

  behind(stamps: any) {
    return this.snapshotBehindStore(KEY, stamps)
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

/** Guest answering /pool/export-data per member dir; records each request. */
function memberGuest(
  byDir: Record<string, { status: number; body?: Uint8Array; etag?: string }>,
  calls: Array<{ dir?: string; ifNoneMatch?: string }>,
) {
  globalThis.fetch = mock(async (_url: any, init: any) => {
    const dir = init?.body ? JSON.parse(init.body).dir : undefined
    calls.push({ dir, ifNoneMatch: init?.headers?.['If-None-Match'] })
    const r = byDir[dir] ?? { status: 204 }
    return new Response(r.body ?? null, {
      status: r.status,
      headers: r.etag ? { ETag: r.etag } : undefined,
    })
  }) as any
}

describe('workspace member writable-state durability', () => {
  let dir: string
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-member-data-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  test('exports each member from its own folder and stores it under the member id', async () => {
    const pool = makePool(dir)
    const a = pool.add()
    const calls: Array<{ dir?: string }> = []
    memberGuest(
      {
        '/app/workspace/m1': { status: 200, body: new Uint8Array([1]), etag: 't1' },
        '/app/workspace/m2': { status: 200, body: new Uint8Array([2]), etag: 't2' },
      },
      calls,
    )

    expect(await pool.saveProjectDataToStore(a)).toBe(true)
    expect(calls.map((c) => c.dir)).toEqual(['/app/workspace/m1', '/app/workspace/m2'])
    expect(pool.uploads.map((u) => u.projectId)).toEqual(['m1', 'm2'])
    expect(a.memberData?.m1.parentEtag).toBe('"m1-new"')
    expect(a.memberData?.m2.parentEtag).toBe('"m2-new"')
    // Never the runtime key, and never the top-level lineage.
    expect(pool.uploads.some((u) => u.projectId === KEY)).toBe(false)
    expect(a.dataParentEtag).toBeUndefined()
  })

  test('each member claims its own lineage', async () => {
    const pool = makePool(dir)
    const a = pool.add({
      memberData: { m1: { parentEtag: '"p1"' }, m2: { untrustedReason: 'hydrate failed' } },
    })
    memberGuest({ '/app/workspace/m1': { status: 200, body: new Uint8Array([1]) } }, [])

    await pool.saveProjectDataToStore(a)
    // m2 is untrusted, so a periodic export never even asks for its bytes.
    expect(pool.uploads).toEqual([
      { projectId: 'm1', bytes: new Uint8Array([1]), lineage: { kind: 'descends', etag: '"p1"' } },
    ])
  })

  test('change tags are tracked per member', async () => {
    const pool = makePool(dir)
    const a = pool.add()
    const calls: Array<{ dir?: string; ifNoneMatch?: string }> = []
    memberGuest(
      {
        '/app/workspace/m1': { status: 200, body: new Uint8Array([1]), etag: 't1' },
        '/app/workspace/m2': { status: 200, body: new Uint8Array([2]), etag: 't2' },
      },
      calls,
    )
    await pool.saveProjectDataToStore(a)
    calls.length = 0
    await pool.saveProjectDataToStore(a)
    expect(calls).toEqual([
      { dir: '/app/workspace/m1', ifNoneMatch: 't1' },
      { dir: '/app/workspace/m2', ifNoneMatch: 't2' },
    ])
  })

  test('one failing member does not skip the others, and the error still surfaces', async () => {
    const pool = makePool(dir)
    const a = pool.add()
    memberGuest(
      {
        '/app/workspace/m1': { status: 500, body: new TextEncoder().encode('boom') },
        '/app/workspace/m2': { status: 200, body: new Uint8Array([2]) },
      },
      [],
    )
    await expect(pool.saveProjectDataToStore(a)).rejects.toThrow(/export-data failed \(500\)/)
    expect(pool.uploads.map((u) => u.projectId)).toEqual(['m2'])
  })

  test('a conflict distrusts only that member', async () => {
    const pool = makePool(dir)
    const a = pool.add({ memberData: { m1: { parentEtag: '"old"' } } })
    pool.outcomes.m1 = { status: 'conflict', reason: 'lineage-mismatch', currentEtag: '"other"' } as any
    memberGuest(
      {
        '/app/workspace/m1': { status: 200, body: new Uint8Array([1]) },
        '/app/workspace/m2': { status: 200, body: new Uint8Array([2]) },
      },
      [],
    )
    await pool.saveProjectDataToStore(a)
    expect(a.memberData?.m1.untrustedReason).toMatch(/no longer matches/)
    expect(a.memberData?.m2.untrustedReason).toBeUndefined()
    expect(a.dataUntrustedReason).toBeUndefined()
  })

  describe('cold-boot hydrate', () => {
    test('restores each member archive into its folder and claims descent', async () => {
      const pool = makePool(dir)
      const a = pool.add()
      pool.refs.m1 = { url: 'u1', bytes: 10, etag: '"e1"' } as ArchiveRef
      await pool.hydrate(a)
      expect(pool.applied).toEqual([{ what: 'm1 member writable state', destDir: '/app/workspace/m1' }])
      expect(a.memberData?.m1).toEqual({ parentEtag: '"e1"' })
      // No archive yet: create-only, nothing to lose.
      expect(a.memberData?.m2).toEqual({})
    })

    test('a failed hydrate distrusts only that member and never fails the open', async () => {
      const pool = makePool(dir)
      const a = pool.add()
      pool.refs.m1 = { url: 'u1', bytes: 10, etag: '"e1"' } as ArchiveRef
      pool.refs.m2 = { url: 'u2', bytes: 10, etag: '"e2"' } as ArchiveRef
      pool.applyFails.add('m1')
      await pool.hydrate(a)
      expect(a.memberData?.m1.untrustedReason).toMatch(/hydrate failed/)
      expect(a.memberData?.m2).toEqual({ parentEtag: '"e2"' })
    })
  })

  describe('snapshots', () => {
    test('only trusted member lineage is stamped into a snapshot', () => {
      const pool = makePool(dir)
      const a = pool.add({
        memberData: { m1: { parentEtag: '"e1"' }, m2: { parentEtag: '"e2"', untrustedReason: 'bad' } },
      })
      expect(pool.snapshotEtags(a)).toEqual({ m1: '"e1"' })
    })

    test('a member archive newer than the snapshot makes the snapshot stale', async () => {
      const pool = makePool(dir)
      pool.refs.m1 = { url: 'u1', bytes: 10, etag: '"newer"' } as ArchiveRef
      expect(await pool.behind({ memberDataEtags: { m1: '"e1"' } })).toMatch(/member m1 data archive/)
      pool.refs.m1 = { url: 'u1', bytes: 10, etag: '"e1"' } as ArchiveRef
      expect(await pool.behind({ memberDataEtags: { m1: '"e1"' } })).toBeNull()
    })
  })
})
