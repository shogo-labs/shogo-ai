// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool — saving a VM's workspace before it is discarded, and refusing to
 * resume a snapshot that durable storage has moved past.
 *
 * Reproduces the 2026-09 data loss: a guest OOM'd under headless Chromium, the
 * health gate discarded the VM with a plain stop, and the next open resumed the
 * last suspend snapshot — silently rolling the project back by a day of work.
 *
 * Driven with fakes — no real Firecracker host, S3, or mount.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ArchiveRef } from './archive-ref'
import { config } from './config'
import { M, metrics } from './metrics'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { RepoLineage, RepoWriteOutcome } from './repo-archive'
import type { FcVmHandle, FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotMeta, SnapshotStore } from './snapshot-store'
import type { BackupWriteOutcome } from './workspace-archive'

type Calls = {
  stops: Array<{ id: string; keepRootfs: boolean }>
  released: string[]
  quarantined: string[]
  extracted: string[]
}

function fakeMgr(alive: Set<string>, calls: Calls, extract: (outDir: string) => Promise<any>) {
  return {
    procCount: () => alive.size,
    isRunning: (h: FcVmHandle) => alive.has(h.id),
    stopVM: async (h: FcVmHandle, opts: { keepRootfs?: boolean } = {}) => {
      alive.delete(h.id)
      calls.stops.push({ id: h.id, keepRootfs: !!opts.keepRootfs })
    },
    extractWorkspaceFromRootfs: async (rootfs: string, outDir: string) => {
      calls.extracted.push(rootfs)
      return extract(outDir)
    },
    releaseRootfs: (rootfs: string) => {
      calls.released.push(rootfs)
    },
    quarantineRootfs: (rootfs: string, label: string) => {
      calls.quarantined.push(rootfs)
      return join(tmpdir(), `q-${label}`)
    },
  } as unknown as FirecrackerVMManager
}

class TestPool extends MetalWarmPool {
  guestOk = true
  guestHangs = false
  repoUploads: Uint8Array[] = []
  sourceUploads: Uint8Array[] = []
  repoOutcome: RepoWriteOutcome = { status: 'written', etag: '"r2"' }
  sourceOutcome: BackupWriteOutcome = { status: 'written', etag: '"s2"' }
  refs: Record<'source' | 'repo' | 'data', string | null> = { source: null, repo: null, data: null }

  private guest<T>(v: T): Promise<T> {
    if (this.guestHangs) return new Promise(() => {})
    return this.guestOk ? Promise.resolve(v) : Promise.reject(new Error('ECONNRESET'))
  }
  protected override fetchRepoExport(): Promise<Uint8Array | null> {
    return this.guest(new Uint8Array([7]))
  }
  protected override fetchExport(): Promise<Uint8Array | null> {
    return this.guest(new Uint8Array([8]))
  }
  override saveProjectDataToStore(): Promise<boolean> {
    return this.guest(true)
  }
  protected override async uploadRepoGuarded(
    _p: string,
    bytes: Uint8Array,
    _o: { lineage: RepoLineage; preserveOnRefusal?: boolean },
  ): Promise<RepoWriteOutcome> {
    this.repoUploads.push(bytes)
    return this.repoOutcome
  }
  protected override async uploadBackupGuarded(_p: string, bytes: Uint8Array): Promise<BackupWriteOutcome> {
    this.sourceUploads.push(bytes)
    return this.sourceOutcome
  }
  private ref(etag: string | null): ArchiveRef | null {
    return etag ? ({ etag, bytes: 1 } as unknown as ArchiveRef) : null
  }
  protected override async sourceRef(): Promise<ArchiveRef | null> {
    return this.ref(this.refs.source)
  }
  protected override async repoRef(): Promise<ArchiveRef | null> {
    return this.ref(this.refs.repo)
  }
  protected override async projectDataRef(): Promise<ArchiveRef | null> {
    return this.ref(this.refs.data)
  }

  seed(projectId: string, vmId: string, extra: Partial<AssignedVm> = {}): AssignedVm {
    const a = {
      projectId,
      handle: { id: vmId, agentUrl: 'http://10.0.0.9:8080', rootfs: `/dev/mapper/mvm-${vmId}` } as unknown as FcVmHandle,
      assignedAt: Date.now(),
      lastTouchedAt: Date.now(),
      runtimeToken: 'tok',
      backupParentEtag: '"s1"',
      repoParentEtag: '"r1"',
      ...extra,
    } as AssignedVm
    ;(this as any).assigned.set(projectId, a)
    return a
  }

  rescue(a: AssignedVm): Promise<void> {
    return this.rescueWorkspace(a, 'test')
  }
  behind(projectId: string, stamps: Partial<SnapshotMeta>): Promise<string | null> {
    return this.snapshotBehindStore(projectId, stamps)
  }
}

describe('pool.rescueWorkspace', () => {
  let dir: string
  let alive: Set<string>
  let calls: Calls
  let extract: (outDir: string) => Promise<any>

  const makePool = () => {
    const cfg = {
      ...config,
      work: dir,
      snapDir: join(dir, 'snap'),
      runDir: join(dir, 'run'),
      rescueGuestTimeoutMs: 50,
    } as typeof config
    mkdirSync(cfg.snapDir, { recursive: true })
    mkdirSync(cfg.runDir, { recursive: true })
    return new TestPool(fakeMgr(alive, calls, (o) => extract(o)), cfg, { kind: 'none' } as unknown as SnapshotStore)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-rescue-'))
    alive = new Set()
    calls = { stops: [], released: [], quarantined: [], extracted: [] }
    extract = async (outDir) => {
      writeFileSync(join(outDir, 'source.tar.gz'), 'SRC')
      writeFileSync(join(outDir, 'repo.tar.gz'), 'GIT')
      return { source: join(outDir, 'source.tar.gz'), repo: join(outDir, 'repo.tar.gz') }
    }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('a live guest exports itself, then the VM is stopped normally', async () => {
    const pool = makePool()
    const a = pool.seed('p1', 'vm-live')
    alive.add('vm-live')

    await pool.rescue(a)

    expect(pool.repoUploads).toHaveLength(1)
    expect(pool.sourceUploads).toHaveLength(1)
    expect(calls.extracted).toEqual([])
    expect(calls.stops).toEqual([{ id: 'vm-live', keepRootfs: false }])
  })

  test('a mute guest (export hangs) falls back to reading its disk', async () => {
    const pool = makePool()
    const a = pool.seed('p1', 'vm-mute')
    alive.add('vm-mute')
    pool.guestHangs = true
    const before = metrics.getCounter(M.rescueDisk)

    await pool.rescue(a)

    expect(calls.stops).toEqual([{ id: 'vm-mute', keepRootfs: true }])
    expect(calls.extracted).toEqual(['/dev/mapper/mvm-vm-mute'])
    expect(new TextDecoder().decode(pool.repoUploads.at(-1))).toBe('GIT')
    expect(new TextDecoder().decode(pool.sourceUploads.at(-1))).toBe('SRC')
    expect(calls.released).toEqual(['/dev/mapper/mvm-vm-mute'])
    expect(calls.quarantined).toEqual([])
    expect(metrics.getCounter(M.rescueDisk)).toBe(before + 1)
    // Lineage advanced to what the rescue wrote, so the next writer descends from it.
    expect(a.repoParentEtag).toBe('"r2"')
    expect(a.backupParentEtag).toBe('"s2"')
  })

  test('a dead VM (FC process gone) goes straight to the disk', async () => {
    const pool = makePool()
    const a = pool.seed('p1', 'vm-dead')

    await pool.rescue(a)

    expect(pool.repoUploads.map((b) => new TextDecoder().decode(b))).toEqual(['GIT'])
    expect(calls.stops).toEqual([{ id: 'vm-dead', keepRootfs: true }])
    expect(calls.released).toEqual(['/dev/mapper/mvm-vm-dead'])
  })

  test('a lineage conflict still counts as saved when the bytes were quarantined', async () => {
    const pool = makePool()
    const a = pool.seed('p1', 'vm-dead')
    pool.repoOutcome = { status: 'conflict', quarantineKey: 'conflict/p1/x-repo.tar.gz', reason: 'lineage' }

    await pool.rescue(a)

    expect(calls.released).toEqual(['/dev/mapper/mvm-vm-dead'])
    expect(calls.quarantined).toEqual([])
  })

  test('when nothing can be saved the disk is quarantined, never released', async () => {
    const pool = makePool()
    const a = pool.seed('p1', 'vm-dead')
    extract = async () => {
      throw new Error('mount: wrong fs type')
    }
    const before = metrics.getCounter(M.rescueFailed)

    await pool.rescue(a)

    expect(calls.released).toEqual([])
    expect(calls.quarantined).toEqual(['/dev/mapper/mvm-vm-dead'])
    expect(metrics.getCounter(M.rescueFailed)).toBe(before + 1)
  })

  test('an upload that lands nowhere durable is treated as a failed rescue', async () => {
    const pool = makePool()
    const a = pool.seed('p1', 'vm-dead')
    pool.repoOutcome = { status: 'too-large', bytes: 10, limit: 1 }

    await pool.rescue(a)

    expect(calls.released).toEqual([])
    expect(calls.quarantined).toEqual(['/dev/mapper/mvm-vm-dead'])
  })

  test('quarantine writes a recovery note next to the kept disk', async () => {
    const pool = makePool()
    const a = pool.seed('p-note', 'vm-dead')
    extract = async () => {
      throw new Error('boom')
    }
    const kept = join(dir, 'kept.cow')
    ;(pool as any).mgr.quarantineRootfs = () => kept

    await pool.rescue(a)

    expect(existsSync(`${kept}.json`)).toBe(true)
    const note = JSON.parse(readFileSync(`${kept}.json`, 'utf8'))
    expect(note.projectId).toBe('p-note')
    expect(note.repoParentEtag).toBe('"r1"')
  })
})

describe('pool.snapshotBehindStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-stale-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const makePool = () =>
    new TestPool(
      fakeMgr(new Set(), { stops: [], released: [], quarantined: [], extracted: [] }, async () => ({})),
      { ...config, work: dir, snapDir: join(dir, 'snap'), runDir: join(dir, 'run') } as typeof config,
      { kind: 'none' } as unknown as SnapshotStore,
    )

  test('fresh when every stamped archive is still the current object', async () => {
    const pool = makePool()
    pool.refs = { source: '"s1"', repo: '"r1"', data: '"d1"' }
    expect(await pool.behind('p1', { backupEtag: '"s1"', repoEtag: '"r1"', dataEtag: '"d1"' })).toBeNull()
  })

  test('stale when the repo moved on after the snapshot (VM ran, then died unsuspended)', async () => {
    const pool = makePool()
    pool.refs = { source: '"s1"', repo: '"r9"', data: '"d1"' }
    const why = await pool.behind('p1', { backupEtag: '"s1"', repoEtag: '"r1"', dataEtag: '"d1"' })
    expect(why).toContain('repo')
  })

  test('stale when a rescue rewrote the source backup', async () => {
    const pool = makePool()
    pool.refs = { source: '"s9"', repo: null, data: null }
    expect(await pool.behind('p1', { backupEtag: '"s1"' })).toContain('source')
  })

  test('compares ETags regardless of quoting', async () => {
    const pool = makePool()
    pool.refs = { source: 's1', repo: null, data: null }
    expect(await pool.behind('p1', { backupEtag: '"s1"' })).toBeNull()
  })

  test('unstamped (legacy) snapshots and unreachable stores never block a resume', async () => {
    const pool = makePool()
    pool.refs = { source: '"s9"', repo: '"r9"', data: '"d9"' }
    expect(await pool.behind('p1', {})).toBeNull()
    ;(pool as any).repoRef = () => Promise.reject(new Error('503'))
    expect(await pool.behind('p1', { repoEtag: '"r1"' })).toBeNull()
  })
})

describe('pool.resume stale-snapshot gate', () => {
  test('a durable snapshot behind storage is skipped without pulling it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metal-resume-stale-'))
    try {
      let pulled = 0
      const store = {
        kind: 's3',
        head: async () => ({ projectId: 'p1', repoEtag: '"r1"', rootfsIdentity: 'x' }) as unknown as SnapshotMeta,
        pull: async () => {
          pulled++
          return null
        },
      } as unknown as SnapshotStore
      const pool = new TestPool(
        fakeMgr(new Set(), { stops: [], released: [], quarantined: [], extracted: [] }, async () => ({})),
        { ...config, work: dir, snapDir: join(dir, 'snap'), runDir: join(dir, 'run') } as typeof config,
        store,
      )
      pool.refs = { source: null, repo: '"r2"', data: null }
      const before = metrics.getCounter(M.staleSnapshotSkipped)

      expect(await pool.resume('p1')).toBeNull()
      expect(pulled).toBe(0)
      expect(metrics.getCounter(M.staleSnapshotSkipped)).toBe(before + 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
