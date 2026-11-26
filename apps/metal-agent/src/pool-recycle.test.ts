// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool.recycle — replace a runtime's VM with a clean cold boot without losing
 * anything: back up from the live guest, and only then stop it WITHOUT a
 * snapshot and drop the snapshots (so the next open cannot resume the stuck
 * processes). A failed backup aborts before anything is removed.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool, type AssignedVm, type RepoExport } from './pool'
import type { FirecrackerVMManager, FcVmHandle } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const HANDLE = { id: 'vm-1', agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any

type Outcome<T> = T | Error

class TestPool extends MetalWarmPool {
  events: string[] = []
  source: Outcome<any> = { status: 'written', etag: '"s"' }
  repo: Outcome<any> = { status: 'written', etag: '"r"' }
  data: Outcome<any> = { status: 'written', etag: '"d"' }
  dataExport: any = { body: new Uint8Array([1]), tag: 't1' }
  guestMembers: string[] | null = null
  removed: string[] = []

  protected override async guestHasRepoBundles(): Promise<boolean> {
    return false
  }
  /** The checkpoint commit a recycle asks the guest for (SHO-399). */
  checkpointOutcome: string | null = null
  checkpointCalls = 0
  protected override async checkpointGuest(): Promise<string | null> {
    this.checkpointCalls += 1
    return this.checkpointOutcome
  }

  protected override async guestMountedMembers(): Promise<string[] | null> {
    return this.guestMembers
  }
  protected override async removeGuestMember(a: AssignedVm, projectId: string): Promise<void> {
    this.removed.push(`${a.projectId} ${projectId}`)
  }
  protected override async fetchExport(): Promise<Uint8Array | null> {
    return new Uint8Array([1])
  }
  protected override async fetchRepoExport(): Promise<RepoExport | null> {
    return { bytes: new Uint8Array([2]), rootCommitAt: null }
  }
  protected override async fetchDataExport(_h: FcVmHandle, _t?: string, known?: string): Promise<any> {
    if (this.dataExport instanceof Error) throw this.dataExport
    if (known && known === this.dataExport?.tag) return 'unchanged'
    return this.dataExport
  }
  protected override async uploadBackupGuarded(projectId: string): Promise<any> {
    this.events.push(`source ${projectId}`)
    if (this.source instanceof Error) throw this.source
    return this.source
  }
  protected override async uploadRepoGuarded(projectId: string): Promise<any> {
    this.events.push(`repo ${projectId}`)
    if (this.repo instanceof Error) throw this.repo
    return this.repo
  }
  protected override async uploadDataGuarded(projectId: string, _b: Uint8Array, opts: any): Promise<any> {
    this.events.push(`data ${projectId}`)
    if (this.data instanceof Error) throw this.data
    if (opts.lineage.kind === 'untrusted') return { status: 'refused', reason: opts.lineage.reason, quarantineKey: 'q' }
    return this.data
  }
  protected override async fetchHomeExport(): Promise<any> {
    return { body: new Uint8Array([3]), tag: 'h1' }
  }
  protected override async uploadHomeGuarded(projectId: string, _b: Uint8Array, opts: any): Promise<any> {
    this.events.push(`home ${projectId}`)
    if (opts.lineage.kind === 'untrusted') return { status: 'refused', reason: opts.lineage.reason, quarantineKey: 'q' }
    return { status: 'written', etag: '"h"' }
  }

  add(projectId: string, extra: Partial<AssignedVm> = {}): AssignedVm {
    const a = {
      projectId,
      handle: HANDLE,
      assignedAt: Date.now(),
      lastTouchedAt: Date.now(),
      runtimeToken: 'tok',
      workspaceOrigin: 'backup',
      backupParentEtag: '"s0"',
      ...extra,
    } as AssignedVm
    ;(this as any).assigned.set(projectId, a)
    return a
  }
}

let dir: string
let stopped: string[]
function makePool(): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    snapStore: 'none',
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = {
    procCount: () => 0,
    stopVM: async (h: FcVmHandle) => {
      stopped.push(h.id)
    },
  } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metal-recycle-'))
  stopped = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('pool.recycle', () => {
  test('backs up repo, source, data and home, then stops the VM without a snapshot', async () => {
    const pool = makePool()
    pool.add('p1')
    const r = await pool.recycle('p1', { reason: 'test' })
    expect(r.aborted).toBe(false)
    // Source goes LAST (SHO-399): `.shogo/sessions.db` travels in it, and a
    // release rotation stops background tasks first so their verdicts are in
    // the archive the next VM restores.
    expect(pool.events).toEqual(['repo p1', 'data p1', 'home p1', 'source p1'])
    expect(r.steps.map((s) => [s.step, s.ok])).toEqual([
      ['checkpoint', true],
      ['repo', true],
      ['data', true],
      ['home', true],
      ['source', true],
      ['destroy', true],
    ])
    // The checkpoint commit comes first: the repo step bundles commits that
    // already exist, so anything edited since the last auto-commit has to be
    // committed before it runs or it never reaches the durable copy.
    expect(pool.checkpointCalls).toBe(1)
    expect(stopped).toEqual(['vm-1'])
    expect(r.destroyed?.stoppedVm).toBe(true)
    expect(pool.getProjectStatus('p1').state).toBe('none')
  })

  test('a failed checkpoint commit aborts before anything is stopped (SHO-399)', async () => {
    const pool = makePool()
    pool.add('p1')
    pool.checkpointOutcome = 'checkpoint commit failed (500): index.lock exists'
    const r = await pool.recycle('p1')

    expect(r.aborted).toBe(true)
    expect(r.steps.find((s) => s.step === 'checkpoint')).toEqual({
      step: 'checkpoint',
      ok: false,
      detail: 'checkpoint commit failed (500): index.lock exists',
    })
    // Nothing was removed: the next rotation attempt retries.
    expect(stopped).toEqual([])
    expect(pool.getProjectStatus('p1').state).toBe('assigned')
  })

  test('a failed backup aborts and leaves the VM running', async () => {
    const pool = makePool()
    pool.add('p1')
    pool.source = new Error('S3 503')
    const r = await pool.recycle('p1')
    expect(r.aborted).toBe(true)
    expect(r.steps.find((s) => s.step === 'source')).toEqual({ step: 'source', ok: false, detail: 'S3 503' })
    expect(stopped).toEqual([])
    expect(pool.getProjectStatus('p1').state).toBe('assigned')
  })

  test('a quarantined (not promoted) source backup counts as a failure', async () => {
    const pool = makePool()
    pool.add('p1')
    pool.source = { status: 'conflict', reason: 'lineage', quarantineKey: 'conflict/p1/x.tar.gz' }
    const r = await pool.recycle('p1')
    expect(r.aborted).toBe(true)
    expect(r.steps.find((s) => s.step === 'source')?.detail).toBe('source quarantined')
  })

  test('an untrusted database aborts: the cold boot would restore an older archive', async () => {
    const pool = makePool()
    pool.add('p1', { dataUntrustedReason: 'writable-state hydrate failed' })
    const r = await pool.recycle('p1')
    expect(r.aborted).toBe(true)
    expect(r.steps.find((s) => s.step === 'data')?.detail).toMatch(/database not persisted/)
    expect(stopped).toEqual([])
  })

  /**
   * A database nobody can snapshot (SHO-541). Rotation needs a final backup,
   * so this aborts — and it must keep aborting: a VM that has never completed
   * an export can still be full of writes only it holds, which is exactly the
   * state Samsara's VM was in when it had been failing for four days.
   */
  describe('a database that cannot be snapshotted', () => {
    /** The guest answering `/pool/export-data` with the named failure. */
    function snapshotFailure(): Error {
      const err = new Error('Could not snapshot the project database: database disk image is malformed') as Error & {
        code: string
      }
      err.code = 'sqlite_snapshot_failed'
      return err
    }

    test('aborts a plain recycle, naming the failure instead of a bare 500', async () => {
      const pool = makePool()
      pool.add('p1', { dataParentEtag: '"arch"' })
      pool.dataExport = snapshotFailure()

      const r = await pool.recycle('p1')
      expect(r.aborted).toBe(true)
      const data = r.steps.find((s) => s.step === 'data')
      expect(data?.detail).toContain('database disk image is malformed')
      // Nothing was removed: the durable archive is untouched.
      expect(stopped).toEqual([])
      expect(pool.events).not.toContain('data p1')
    })

    test('still aborts a stale-rootfs rotation: a VM that never saved can be full of live writes', async () => {
      // The tempting shortcut — "it never completed an export, so nothing newer
      // than the archive can exist" — is false. Samsara's VM had 336 failed
      // exports and four days of users writing. Rotating would have swapped that
      // for a four-day-old archive and called it a repair.
      const pool = makePool()
      pool.add('p1', { dataParentEtag: '"arch"' })
      pool.dataExport = snapshotFailure()

      const r = await pool.recycle('p1', { reason: 'stale-rootfs' })
      expect(r.aborted).toBe(true)
      expect(r.steps.find((s) => s.step === 'data')?.detail).toMatch(/database disk image is malformed/)
      expect(stopped).toEqual([])
      expect(pool.events).not.toContain('data p1')
    })

    test('aborts even after the run saved its database once, and says why', async () => {
      const pool = makePool()
      pool.add('p1', { dataParentEtag: '"arch"', dataLastUploadAt: Date.now() - 60_000 })
      pool.dataExport = snapshotFailure()

      const r = await pool.recycle('p1', { reason: 'stale-rootfs' })
      expect(r.aborted).toBe(true)
      expect(r.steps.find((s) => s.step === 'data')?.detail).toMatch(/database not persisted/)
      expect(stopped).toEqual([])
    })

    test('aborts a workspace VM whose member database cannot be snapshotted', async () => {
      const pool = makePool()
      pool.add('ws:proj:m1', {
        workspaceMemberIds: ['m1'],
        memberData: { m1: { parentEtag: '"arch-m1"' } },
      })
      pool.dataExport = snapshotFailure()

      const r = await pool.recycle('ws:proj:m1')
      expect(r.aborted).toBe(true)
      expect(r.steps.find((s) => s.step === 'data')?.detail).toMatch(/database disk image is malformed/)
      expect(stopped).toEqual([])
    })
  })

  test('an untrusted home aborts: credentials set up since boot would be dropped', async () => {
    const pool = makePool()
    pool.add('p1', { homeUntrustedReason: 'home-state hydrate failed at assign' })
    const r = await pool.recycle('p1')
    expect(r.aborted).toBe(true)
    expect(r.steps.find((s) => s.step === 'home')?.detail).toMatch(/home directory not persisted/)
    expect(stopped).toEqual([])
  })

  test('force proceeds past failed steps and reports them', async () => {
    const pool = makePool()
    pool.add('p1')
    pool.data = new Error('S3 down')
    const r = await pool.recycle('p1', { force: true })
    expect(r.aborted).toBe(false)
    expect(r.forced).toBe(true)
    expect(r.steps.find((s) => s.step === 'data')?.ok).toBe(false)
    expect(stopped).toEqual(['vm-1'])
  })

  test('refuses to kill an agent turn in flight unless forced', async () => {
    const pool = makePool()
    pool.add('p1', { activeStreams: 1 })
    const r = await pool.recycle('p1')
    expect(r.aborted).toBe(true)
    expect(r.steps).toEqual([{ step: 'idle', ok: false, detail: '1 agent turn(s) in flight' }])
    expect(pool.events).toEqual([])
  })

  test('workspace runtimes back up their own member and its database', async () => {
    const pool = makePool()
    pool.add('ws:proj:m1', { workspaceMemberIds: ['m1'] })
    const r = await pool.recycle('ws:proj:m1')
    expect(r.aborted).toBe(false)
    expect(pool.events).toEqual(['repo ws:proj:m1', 'data m1', 'home ws:proj:m1', 'source m1'])
    expect(r.steps.find((s) => s.step === 'foreign_members')).toEqual({ step: 'foreign_members', ok: true })
    expect(pool.removed).toEqual([])
  })

  test("a legacy VM's foreign member is drained before the backups, then only the own member is backed up", async () => {
    const pool = makePool()
    const a = pool.add('ws:proj:m1', { workspaceMemberIds: ['m1', 'm2'] })
    const r = await pool.recycle('ws:proj:m1')
    expect(r.aborted).toBe(false)
    expect(pool.events).toEqual(['source m2', 'data m2', 'repo ws:proj:m1', 'data m1', 'home ws:proj:m1', 'source m1'])
    expect(pool.removed).toEqual(['ws:proj:m1 m2'])
    expect(a.workspaceMemberIds).toEqual(['m1'])
  })

  test('a foreign member whose export lands nowhere durable aborts and stays mounted', async () => {
    const pool = makePool()
    pool.add('ws:proj:m1', { workspaceMemberIds: ['m1', 'm2'] })
    pool.source = { status: 'skipped' }
    const r = await pool.recycle('ws:proj:m1')
    expect(r.aborted).toBe(true)
    expect(r.steps.find((s) => s.step === 'foreign_members')).toMatchObject({ ok: false, detail: expect.stringMatching(/^m2: .*not durable/) })
    expect(pool.removed).toEqual([])
    expect(stopped).toEqual([])
  })

  test('a failing workspace member aborts and names the member', async () => {
    const pool = makePool()
    pool.add('ws:proj:m1', { workspaceMemberIds: ['m1'] })
    pool.source = { status: 'conflict', reason: 'lineage', quarantineKey: 'q' }
    const r = await pool.recycle('ws:proj:m1')
    expect(r.aborted).toBe(true)
    expect(r.steps.find((s) => s.step === 'source')?.detail).toBe('m1: not promoted (conflict)')
  })

  test('a workspace runtime with no known members aborts instead of backing up nothing', async () => {
    const pool = makePool()
    pool.add('ws:proj:m1')
    const r = await pool.recycle('ws:proj:m1')
    expect(r.aborted).toBe(true)
    expect(r.steps.find((s) => s.step === 'members')).toMatchObject({ ok: false })
    expect(stopped).toEqual([])
  })

  test('a workspace session runtime holds no members, so it recycles without any', async () => {
    const pool = makePool()
    pool.add('ws:team')
    const r = await pool.recycle('ws:team')
    expect(r.aborted).toBe(false)
    expect(r.steps.find((s) => s.step === 'members')).toBeUndefined()
    expect(pool.events).toEqual(['repo ws:team', 'home ws:team'])
  })

  test('the guest supplies the own member the host lost track of', async () => {
    const pool = makePool()
    pool.add('ws:proj:site')
    pool.guestMembers = ['site']
    const r = await pool.recycle('ws:proj:site')
    expect(r.aborted).toBe(false)
    expect(pool.events).toContain('source site')
    expect(pool.events).toContain('data site')
  })

  test('a runtime that is not here and has no snapshot store just reports destroy', async () => {
    const pool = makePool()
    const r = await pool.recycle('ghost')
    expect(r.aborted).toBe(false)
    expect(r.state).toBe('none')
    expect(r.steps.map((s) => s.step)).toEqual(['destroy'])
  })

  test('a suspend refuses to start while a recycle is running', async () => {
    const pool = makePool()
    pool.add('p1')
    let release!: () => void
    pool.dataExport = { body: new Uint8Array([1]), tag: 't1' }
    const gate = new Promise<void>((r) => (release = r))
    const origRepo = (pool as any).fetchRepoExport.bind(pool)
    ;(pool as any).fetchRepoExport = async (...args: any[]) => {
      await gate
      return origRepo(...args)
    }
    const recycling = pool.recycle('p1')
    await expect(pool.suspend('p1')).rejects.toThrow(/being recycled/)
    release()
    expect((await recycling).aborted).toBe(false)
  })
})
