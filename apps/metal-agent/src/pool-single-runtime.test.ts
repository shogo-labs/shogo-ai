// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool — a project is online ONLY in its own runtime.
 *
 * Staging, 2026-10-14: project 21f917c2 was live in `ws:proj:21f917c2` and, as
 * a workspace member, in `ws:proj:25e2bd0f` for most of an hour. After an agent
 * restart lost the second VM's member list, that VM picked the member up from
 * its guest with unknown lineage, adopted it, and overwrote the backup the
 * anchor had just written; the anchor's next write was quarantined, and the
 * extra writes made its snapshot "behind durable storage" (a 39s cold boot).
 *
 * Now `ws:proj:X` holds only X and `ws:<workspaceId>` holds nothing: foreign
 * members are stripped from assign env, refused on live mount, never backed up
 * or adopted, drained off legacy VMs, and keep a legacy snapshot from resuming.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import type { FirecrackerVMManager, FcVmHandle } from './firecracker-vm-manager'
import { M, metrics } from './metrics'
import {
  ForeignMemberError,
  MetalWarmPool,
  ownMemberIds,
  restrictToOwnMembers,
  type AssignedVm,
} from './pool'
import type { SnapshotStore } from './snapshot-store'
import { FakeHost, FakeS3, fakeHostConfig, tarOf, untar, useFakeS3Env } from './test-harness/fake-metal-host'
import {
  uploadWorkspaceArchiveGuarded,
  type BackupWriteOutcome,
} from './workspace-archive'

type UploadOpts = { parentEtag?: string; adoptWhenUnknown?: boolean; untrusted?: boolean }

/** Pool with every guest and S3 touchpoint replaced by in-memory fakes. */
class TestPool extends MetalWarmPool {
  uploads: Array<{ projectId: string; opts: UploadOpts }> = []
  outcomes: Record<string, BackupWriteOutcome> = {}
  mounted: Record<string, string[] | null> = {}
  removed: string[] = []

  protected override async uploadBackupGuarded(
    projectId: string,
    _bytes: Uint8Array,
    opts: UploadOpts,
  ): Promise<BackupWriteOutcome> {
    this.uploads.push({ projectId, opts })
    return this.outcomes[projectId] ?? { status: opts.parentEtag ? 'written' : 'created', etag: `"${projectId}-new"` }
  }
  protected override async guestMountedMembers(a: AssignedVm): Promise<string[] | null> {
    return this.mounted[a.projectId] ?? null
  }
  protected override async fetchExport(): Promise<Uint8Array | null> {
    return new Uint8Array([1, 2, 3])
  }
  protected override async fetchDataExport(): Promise<null> {
    return null
  }
  protected override async removeGuestMember(a: AssignedVm, projectId: string): Promise<void> {
    this.removed.push(`${a.projectId} ${projectId}`)
    this.mounted[a.projectId] = (this.mounted[a.projectId] ?? []).filter((id) => id !== projectId)
  }
  protected override async sourceRef(): Promise<null> {
    return null
  }
  protected override async projectDataRef(): Promise<null> {
    return null
  }

  add(key: string, extra: Partial<AssignedVm> = {}): AssignedVm {
    const a = {
      projectId: key,
      handle: { id: `vm-${key}`, agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' },
      assignedAt: Date.now(),
      lastTouchedAt: Date.now(),
      runtimeToken: 'tok',
      ...extra,
    } as AssignedVm
    ;(this as any).assigned.set(key, a)
    return a
  }

  saveMembers(a: AssignedVm) {
    return (this as any).saveWorkspaceMembersToStore(a) as Promise<Array<{ projectId: string; reason: string }>>
  }
}

let dir: string
function makePool(mgr: Record<string, unknown> = {}): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    hydrateTimeoutMs: 5000,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = { procCount: () => 0, isRunning: () => true, ...mgr } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const { error, warn, log } = console
  console.error = console.warn = console.log = () => {}
  return fn().finally(() => {
    console.error = error
    console.warn = warn
    console.log = log
  })
}

const realFetch = globalThis.fetch
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metal-single-runtime-'))
})
afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
})

describe('which members a runtime may hold', () => {
  test('a project runtime holds only itself; a workspace session runtime holds nothing', () => {
    expect(ownMemberIds('ws:proj:A')).toEqual(['A'])
    expect(ownMemberIds('ws:W')).toEqual([])
    expect(ownMemberIds('A')).toEqual([])
  })

  test('foreign ids are stripped from every member list in the env and the bind', () => {
    const r = restrictToOwnMembers(
      'ws:proj:A',
      { WORKSPACE_PROJECT_IDS: 'A,B', WORKSPACE_NEW_PROJECT_IDS: 'B', WORKSPACE_READONLY_PROJECT_IDS: 'C', OTHER: 'x' },
      { workspaceId: 'W', attachedProjectIds: ['A', 'B'] },
    )
    expect(r.env).toEqual({ WORKSPACE_PROJECT_IDS: 'A', WORKSPACE_NEW_PROJECT_IDS: '', WORKSPACE_READONLY_PROJECT_IDS: '', OTHER: 'x' })
    expect(r.bind).toEqual({ workspaceId: 'W', attachedProjectIds: ['A'] })
    expect(r.foreign.sort()).toEqual(['B', 'C'])
  })

  test('a non-workspace key is left alone', () => {
    const env = { WORKSPACE_PROJECT_IDS: 'B' }
    expect(restrictToOwnMembers('A', env)).toEqual({ env, bind: undefined, foreign: [] })
  })
})

describe('mountWorkspaceMember', () => {
  test('refuses a foreign member before touching the guest or the store', async () => {
    const pool = makePool()
    pool.add('ws:proj:A')
    pool.add('ws:W')
    const calls: string[] = []
    globalThis.fetch = mock(async (url: any) => {
      calls.push(String(url))
      return Response.json({ ok: true })
    }) as any
    const before = metrics.getCounter(M.foreignMemberMountRefused)

    await expect(pool.mountWorkspaceMember('ws:proj:A', 'B', '/app/workspace/B')).rejects.toBeInstanceOf(ForeignMemberError)
    await expect(pool.mountWorkspaceMember('ws:W', 'A', '/app/workspace/A')).rejects.toThrow(/only online in its own runtime/)
    expect(calls).toEqual([])
    expect(metrics.getCounter(M.foreignMemberMountRefused)).toBe(before + 2)
  })

  test('mounts the runtime’s own project', async () => {
    const pool = makePool()
    const a = pool.add('ws:proj:A')
    const calls: string[] = []
    globalThis.fetch = mock(async (url: any, init: any) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`)
      return Response.json({ ok: true })
    }) as any
    expect(await quiet(() => pool.mountWorkspaceMember('ws:proj:A', 'A', '/app/workspace/A'))).toEqual({ hydrated: false })
    expect(calls).toEqual(['POST /internal/workspace/members'])
    expect(a.workspaceMemberIds).toEqual(['A'])
  })
})

describe('backups only ever export the own member', () => {
  test('a foreign member the guest reports mounted is never uploaded, on any save', async () => {
    const pool = makePool()
    const a = pool.add('ws:proj:A', { workspaceMemberIds: ['A'] })
    pool.mounted['ws:proj:A'] = ['A', 'B']
    await quiet(() => pool.saveMembers(a))
    await quiet(() => pool.saveMembers(a))
    expect(pool.uploads.map((u) => u.projectId)).toEqual(['A', 'A'])
    expect(a.workspaceMemberIds).toEqual(['A'])
    expect(a.memberData?.B).toBeUndefined()
  })

  test('a workspace session runtime exports nothing even if its guest holds projects', async () => {
    const pool = makePool()
    const a = pool.add('ws:W', { workspaceMemberIds: ['A'] })
    pool.mounted['ws:W'] = ['A', 'B']
    expect(await quiet(() => pool.saveMembers(a))).toEqual([])
    expect(pool.uploads).toEqual([])
  })
})

describe('unknown member lineage is adopted only for the own project of a legacy snapshot', () => {
  test('own member of a resumed legacy snapshot: adopt', async () => {
    const pool = makePool()
    const a = pool.add('ws:proj:A', { workspaceOrigin: 'snapshot', workspaceMemberIds: ['A'] })
    await quiet(() => pool.saveMembers(a))
    expect(pool.uploads).toEqual([{ projectId: 'A', opts: { parentEtag: undefined, adoptWhenUnknown: true, untrusted: false } }])
  })

  test('own member this VM hydrated (create-only), or of a cold-booted VM: never adopt', async () => {
    const pool = makePool()
    const linked = pool.add('ws:proj:A', {
      workspaceOrigin: 'snapshot',
      workspaceMemberIds: ['A'],
      memberData: { A: { sourceLinked: true } },
    })
    await quiet(() => pool.saveMembers(linked))
    const cold = pool.add('ws:proj:C', { workspaceOrigin: 'backup', workspaceMemberIds: ['C'] })
    await quiet(() => pool.saveMembers(cold))
    expect(pool.uploads.map((u) => [u.projectId, u.opts.adoptWhenUnknown])).toEqual([
      ['A', false],
      ['C', false],
    ])
  })

  test('a foreign member picked up from the guest: never adopt, so it quarantines instead of overwriting', async () => {
    const pool = makePool()
    pool.add('ws:proj:A', { workspaceOrigin: 'snapshot', workspaceMemberIds: ['A'] })
    pool.mounted['ws:proj:A'] = ['A', 'B']
    await quiet(() => pool.drainForeignMembers())
    expect(pool.uploads).toEqual([{ projectId: 'B', opts: { parentEtag: undefined, adoptWhenUnknown: false, untrusted: false } }])
  })
})

describe('adopt-on-restart', () => {
  test('restores the member list, so a restart cannot turn a tracked member into an untracked one', async () => {
    const before = makePool()
    const socketPath = join(dir, 'fc.sock')
    writeFileSync(socketPath, '')
    const a = before.add('ws:proj:A', { workspaceMemberIds: ['A'], memberData: { A: { sourceParentEtag: '"e1"', sourceLinked: true } } })
    a.handle = { ...a.handle, pid: process.pid, socketPath, net: {} } as unknown as FcVmHandle
    ;(before as any).writeLive(a)

    globalThis.fetch = mock(async () => Response.json({ ok: true })) as any
    const after = makePool({ adoptVM: () => {}, reapHostOrphans: () => 0 })
    expect((await quiet(() => after.adopt())).adopted).toEqual(['ws:proj:A'])
    const adopted = after.getAssigned('ws:proj:A')!
    expect(adopted.workspaceMemberIds).toEqual(['A'])
    expect(adopted.memberData?.A).toEqual({ sourceParentEtag: '"e1"', sourceLinked: true })
  })
})

describe('drainForeignMembers', () => {
  test('exports each foreign member once under its lineage, unmounts it, and leaves the own member alone', async () => {
    const pool = makePool()
    const a = pool.add('ws:proj:A', { workspaceMemberIds: ['A', 'B'] })
    pool.mounted['ws:proj:A'] = ['A', 'B', 'C']
    pool.add('ws:W', { workspaceMemberIds: [] })
    pool.mounted['ws:W'] = ['D']
    pool.add('P', {})
    pool.outcomes.C = { status: 'conflict', quarantineKey: 'conflict/C/1.tar.gz', currentEtag: '"c0"', reason: 'lineage' }
    const before = metrics.getCounter(`${M.foreignMemberDrained}{outcome="conflict"}`)

    const results = await quiet(() => pool.drainForeignMembers())

    expect(results).toEqual([
      { runtimeKey: 'ws:proj:A', projectId: 'B', outcome: 'exported', detail: 'created' },
      { runtimeKey: 'ws:proj:A', projectId: 'C', outcome: 'conflict', detail: 'quarantined at conflict/C/1.tar.gz' },
      { runtimeKey: 'ws:W', projectId: 'D', outcome: 'exported', detail: 'created' },
    ])
    expect(pool.uploads.map((u) => u.projectId)).toEqual(['B', 'C', 'D'])
    expect(pool.removed).toEqual(['ws:proj:A B', 'ws:proj:A C', 'ws:W D'])
    expect(a.workspaceMemberIds).toEqual(['A'])
    expect(metrics.getCounter(`${M.foreignMemberDrained}{outcome="conflict"}`)).toBe(before + 1)

    // Nothing foreign left: a second drain is a no-op.
    expect(await quiet(() => pool.drainForeignMembers())).toEqual([])
    expect(pool.uploads).toHaveLength(3)
  })

  test('a member whose export lands nowhere durable is reported failed and stays mounted', async () => {
    const pool = makePool()
    pool.add('ws:proj:A', { workspaceMemberIds: ['A'] })
    pool.mounted['ws:proj:A'] = ['A', 'B']
    pool.outcomes.B = { status: 'skipped' }
    const results = await quiet(() => pool.drainForeignMembers())
    expect(results).toMatchObject([{ runtimeKey: 'ws:proj:A', projectId: 'B', outcome: 'failed' }])
    expect(results[0].detail).toMatch(/not durable/)
    expect(pool.removed).toEqual([])
  })

  test('the holders of a project shrink to its own runtime once drained', async () => {
    const pool = makePool()
    pool.add('ws:proj:B', { workspaceMemberIds: ['B'] })
    pool.mounted['ws:proj:B'] = ['B']
    pool.add('ws:proj:A', { workspaceMemberIds: ['A'] })
    pool.mounted['ws:proj:A'] = ['A', 'B']
    pool.add('ws:W', { workspaceMemberIds: ['B'] })

    expect(await pool.memberHolders('B')).toEqual(['ws:W', 'ws:proj:A', 'ws:proj:B'])
    await quiet(() => pool.drainForeignMembers())
    expect(await pool.memberHolders('B')).toEqual(['ws:proj:B'])
    expect(await pool.memberHolders('Z')).toEqual([])
  })
})

describe('compare-and-swap source uploads', () => {
  test('a writer that lands between the lineage check and the PUT is not overwritten', async () => {
    const restore = useFakeS3Env()
    const s3 = new FakeS3()
    const realFetch = globalThis.fetch
    try {
      const cfg = fakeHostConfig(dir, s3)
      const created = await uploadWorkspaceArchiveGuarded('p1', tarOf({ 'App.tsx': 'v1\n' }), {}, cfg)
      expect(created.status).toBe('created')
      const etag = (created as { etag: string | null }).etag

      let raced = false
      globalThis.fetch = (async (input: any, init?: any) => {
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
        const url = String(input instanceof Request ? input.url : input)
        if (!raced && method === 'PUT' && url.includes('p1/project-src.tar.gz')) {
          raced = true
          s3.put('p1/project-src.tar.gz', tarOf({ 'App.tsx': 'other writer\n' }))
        }
        return realFetch(input, init)
      }) as typeof fetch

      const out = await uploadWorkspaceArchiveGuarded('p1', tarOf({ 'App.tsx': 'v2\n' }), { parentEtag: etag }, cfg)
      expect(raced).toBe(true)
      expect(out).toMatchObject({ status: 'conflict', reason: 'lineage' })
      expect(untar(s3.body('p1/project-src.tar.gz')!)['App.tsx']).toBe('other writer\n')
      const qkey = (out as { quarantineKey: string }).quarantineKey
      expect(untar(s3.body(qkey)!)['App.tsx']).toBe('v2\n')
    } finally {
      globalThis.fetch = realFetch
      s3.stop()
      restore()
    }
  })
})

describe('end to end on a fake host', () => {
  const ENV = { RUNTIME_AUTH_SECRET: 'tok' }
  let restoreEnv: () => void
  const cleanups: Array<() => void> = []
  beforeAll(() => {
    restoreEnv = useFakeS3Env()
  })
  afterAll(() => restoreEnv())
  afterEach(() => {
    for (const c of cleanups.splice(0).reverse()) c()
  })

  function rig() {
    const s3 = new FakeS3()
    const host = new FakeHost()
    const hostDir = mkdtempSync(join(tmpdir(), 'single-runtime-host-'))
    cleanups.push(() => s3.stop(), () => host.stopAll(), () => rmSync(hostDir, { recursive: true, force: true }))
    const pool = new MetalWarmPool(host.manager(), fakeHostConfig(hostDir, s3), { kind: 'none' } as unknown as SnapshotStore)
    return { s3, host, pool }
  }

  test('assign of ws:proj:A with WORKSPACE_PROJECT_IDS=A,B boots with only A', async () => {
    const { s3, host, pool } = rig()
    s3.put('B/project-src.tar.gz', tarOf({ 'App.tsx': 'B\n' }))
    const before = metrics.getCounter(M.foreignMembersStripped)
    const errors: string[] = []
    const error = console.error
    console.error = (...args: any[]) => void errors.push(args.join(' '))
    try {
      await pool.open('ws:proj:A', { ...ENV, WORKSPACE_PROJECT_IDS: 'A,B' }, { workspaceId: 'W', attachedProjectIds: ['A', 'B'] })
    } finally {
      console.error = error
    }
    const a = pool.getAssigned('ws:proj:A')!
    const guest = host.guestFor(a.handle)!
    expect(guest.env.WORKSPACE_PROJECT_IDS).toBe('A')
    expect(guest.env.WORKSPACE_NEW_PROJECT_IDS).toBe('A')
    expect(a.workspaceMemberIds).toEqual(['A'])
    expect(a.memberData?.B).toBeUndefined()
    expect(existsSync(join(guest.ws, 'B'))).toBe(false)
    expect(metrics.getCounter(M.foreignMembersStripped)).toBe(before + 1)
    expect(errors).toContain(
      '[pool] refusing foreign workspace members for ws:proj:A: B (a project is only online in its own runtime)',
    )
  })

  test('a workspace session runtime boots with no members at all', async () => {
    const { host, pool } = rig()
    const before = metrics.getCounter(M.foreignMembersStripped)
    await quiet(() => pool.open('ws:W', { ...ENV, WORKSPACE_PROJECT_IDS: 'A,B' }))
    const a = pool.getAssigned('ws:W')!
    expect(host.guestFor(a.handle)!.env.WORKSPACE_PROJECT_IDS).toBe('')
    expect(a.workspaceMemberIds).toEqual([])
    expect(metrics.getCounter(M.foreignMembersStripped)).toBe(before + 2)
  })

  test('a clean snapshot resumes; one stamped with a foreign member cold-boots instead', async () => {
    const { host, pool } = rig()
    const env = { ...ENV, WORKSPACE_PROJECT_IDS: 'A' }
    await quiet(() => pool.open('ws:proj:A', env))
    host.guestFor(pool.getAssigned('ws:proj:A')!.handle)!.edit('A/App.tsx', 'v1\n')
    await quiet(async () => {
      await (pool as any).saveWorkspaceMembersToStore(pool.getAssigned('ws:proj:A'))
      await pool.suspend('ws:proj:A')
    })
    expect((await quiet(() => pool.open('ws:proj:A', env))).mode).toBe('resumed')

    await quiet(() => pool.suspend('ws:proj:A'))
    const s = (pool as any).suspended.get('ws:proj:A')
    s.memberSourceEtags = { ...s.memberSourceEtags, B: '"legacy"' }
    const r = await quiet(() => pool.open('ws:proj:A', env))
    expect(r.mode).toBe('assigned')
    expect(r.staleReason).toBe('foreign_members')
    expect((pool as any).suspended.has('ws:proj:A')).toBe(false)
  })
})
