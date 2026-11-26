// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-584 — one VM adopted mid-open could never back up or suspend, and every
 * retry re-quarantined 525 MB: 10,391 identical copies in six days.
 *
 * Four independent guarantees are pinned here:
 *   1. a non-forced recycle that fails one step does NOT run the remaining
 *      exports (so it cannot re-quarantine anything);
 *   2. a suspend that will be refused for a non-durable HEAD exports nothing;
 *   3. a corrupt `.git` blocks rotation for six hours, alerts once, and the
 *      backoff survives an adopt;
 *   4. the shared quarantine helper dedupes identical bytes and caps a project
 *      per UTC day, and a capped copy is reported as NOT SAVED.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { LiveRegistry, type LiveVmEntry } from './live-registry'
import { memoryBody, quarantinedCopy, type QuarantineState } from './quarantine'
import { MetalWarmPool, ROTATE_BLOCKED_RETRY_MS, RepoBundleLfsPendingError, RepoCorruptError, type AssignedVm, type RepoExport } from './pool'
import type { FirecrackerVMManager, FcVmHandle } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const HANDLE = { id: 'vm-1', agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9', vmClass: 'standard' } as any

// The quarantine cap is per UTC day and this file pins day boundaries as
// literals, so the clock is pinned to match them (check:test-clock, SHO-505).
beforeAll(() => setSystemTime(new Date(Date.UTC(2026, 10, 25, 12))))
afterAll(() => setSystemTime())

type Outcome<T> = T | Error

class TestPool extends MetalWarmPool {
  events: string[] = []
  source: Outcome<any> = { status: 'written', etag: '"s"' }
  repo: Outcome<any> = { status: 'written', etag: '"r"' }
  data: Outcome<any> = { status: 'written', etag: '"d"' }
  dataExport: any = { body: new Uint8Array([1]), tag: 't1' }
  repoExports = 0

  protected override async guestHasRepoBundles(): Promise<boolean> {
    return false
  }
  protected override async checkpointGuest(): Promise<string | null> {
    return null
  }
  protected override async guestMountedMembers(): Promise<string[] | null> {
    return []
  }
  protected override async removeGuestMember(): Promise<void> {}
  protected override async fetchExport(): Promise<Uint8Array | null> {
    return new Uint8Array([1])
  }
  protected override async fetchRepoExport(): Promise<RepoExport | null> {
    this.repoExports += 1
    if (this.repo instanceof RepoCorruptError) throw this.repo
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
  protected override async uploadDataGuarded(projectId: string): Promise<any> {
    this.events.push(`data ${projectId}`)
    if (this.data instanceof Error) throw this.data
    return this.data
  }
  protected override async fetchHomeExport(): Promise<any> {
    return { body: new Uint8Array([3]), tag: 'h1' }
  }
  protected override async uploadHomeGuarded(projectId: string): Promise<any> {
    this.events.push(`home ${projectId}`)
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

function makeCfg(over: Partial<typeof config> = {}) {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    snapStore: 'none',
    ...over,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  return cfg
}

function makePool(over: Partial<typeof config> = {}): TestPool {
  const fakeMgr = {
    procCount: () => 0,
    stopVM: async (h: FcVmHandle) => {
      stopped.push(h.id)
    },
    adoptVM: () => {},
    reapHostOrphans: () => 0,
  } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, makeCfg(over), { kind: 'none' } as unknown as SnapshotStore)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sho584-'))
  stopped = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('SHO-584 · a recycle that cannot succeed stops exporting', () => {
  test('a failed repo step skips data, home and the 525 MB source export', async () => {
    const pool = makePool()
    pool.add('p1', { repoHeadSha: 'abc123' })
    pool.repo = new Error('bad object 9f82099d')

    const r = await pool.recycle('p1', { reason: 'stale-rootfs' })

    expect(r.aborted).toBe(true)
    // The one export that ran is the repo's; nothing else touched the guest.
    expect(pool.events).toEqual(['repo p1'])
    expect(r.steps.filter((s) => s.ok).map((s) => s.step)).toEqual(['checkpoint'])
    for (const step of ['data', 'home', 'source']) {
      expect(r.steps.find((s) => s.step === step)?.detail).toBe('skipped: repo failed')
    }
    expect(stopped).toEqual([])
  })

  test('force keeps running every step (operator-initiated recycle)', async () => {
    const pool = makePool()
    pool.add('p1', { repoHeadSha: 'abc123' })
    pool.repo = new Error('bad object 9f82099d')

    const r = await pool.recycle('p1', { reason: 'operator', force: true })

    expect(r.forced).toBe(true)
    expect(pool.events).toEqual(['repo p1', 'data p1', 'home p1', 'source p1'])
  })
})

describe('SHO-584 · a suspend that will be refused exports nothing', () => {
  test('a non-durable HEAD refuses before source, data and home exports', async () => {
    const pool = makePool()
    // A HEAD the durable repo does not have, and a repo write that conflicts:
    // the export cannot make it durable, so the suspend is going to be refused.
    pool.add('p1', { repoHeadSha: 'deadbeef', repoExportedHeadSha: 'old-care' })
    pool.repo = { status: 'conflict', quarantineKey: null, reason: 'lineage' }

    await expect(pool.suspend('p1', { reason: 'idle' })).rejects.toThrow(/not in the durable repo/)
    // Only the repo was attempted — the fix it could not apply. The 525 MB
    // source, the database and the home tree were never pulled.
    expect(pool.events).toEqual(['repo p1'])
    expect(stopped).toEqual([])
  })
})

describe('SHO-584 · a corrupt .git is permanent, not retryable', () => {
  const STALE = { bootRootfsIdentity: 'a-superseded-image', repoHeadSha: 'abc123', lastRealActivityAt: 0 }

  test('blocks rotation for six hours, alerts once, and does not re-export', async () => {
    const pool = makePool({ rolloutIdleMs: 60_000, rolloutDeadlineMs: 24 * 3_600_000 })
    const a = pool.add('p1', { ...STALE })
    pool.repo = new RepoCorruptError('bad object 9f82099d')

    const now = Date.now()
    const first = await pool.rotateStale(now)
    expect(first.retired).toEqual([])

    const blocked = pool.getProjectStatus('p1').rotationBlocked
    expect(blocked?.code).toBe('stale_rootfs_blocked')
    expect(blocked?.reason).toMatch(/corrupt/i)
    expect(a.repoCorruptFailure?.code).toBe('repo-corrupt')
    expect(a.rotateRetryAt).toBeGreaterThanOrEqual(now + ROTATE_BLOCKED_RETRY_MS - 1_000)

    // The alert fired once: the second failure inside the streak does not re-log.
    expect(a.repoCorruptFailure?.attempts).toBe(1)
    const exportsAfterFirst = pool.repoExports

    // A minute later the rotation is BLOCKED, so it does not even ask the guest.
    const second = await pool.rotateStale(now + 60_000)
    expect(second.retired).toEqual([])
    expect(pool.repoExports).toBe(exportsAfterFirst)
  })

  test('the block survives an agent restart (adopt keeps repoCorruptFailure)', async () => {
    const cfg = makeCfg({ rolloutIdleMs: 60_000, rolloutDeadlineMs: 24 * 3_600_000 })
    const reg = new LiveRegistry(cfg.runDir)
    const child = Bun.spawn(['sleep', '30'])
    const guest = Bun.serve({ port: 0, fetch: () => new Response('ok') })
    const retryAt = Date.now() + ROTATE_BLOCKED_RETRY_MS
    const sock = join(cfg.runDir, 'p1.sock')
    writeFileSync(sock, '')
    reg.put({
      projectId: 'p1',
      vmId: 'fcvm-p1',
      pid: child.pid,
      guestIp: '127.0.0.1',
      agentUrl: `http://localhost:${guest.port}`,
      socketPath: sock,
      serialLog: join(cfg.runDir, 'p1.serial'),
      net: { tap: 'fctap0', guestIp: '127.0.0.1' } as any,
      rootfs: join(cfg.runDir, 'p1.rootfs.ext4'),
      vcpus: 2,
      memoryMB: 4096,
      assignedAt: 1000,
      lastTouchedAt: 2000,
      bootRootfsIdentity: 'a-superseded-image',
      repoHeadSha: 'abc123',
      openState: 'ready',
      repoCorruptFailure: { code: 'repo-corrupt', message: 'bad object', since: 1, attempts: 3, retryAt },
      v: 1,
    } as LiveVmEntry)

    const fakeMgr = {
      adoptVM: () => {},
      reapHostOrphans: () => 0,
      procCount: () => 0,
    } as unknown as FirecrackerVMManager
    const pool = new TestPool(fakeMgr, cfg as any, { kind: 'none' } as unknown as SnapshotStore)
    try {
      await pool.adopt()
      const adopted = pool.getAssigned('p1')
      expect(adopted?.repoCorruptFailure?.retryAt).toBe(retryAt)
      expect(adopted?.repoCorruptFailure?.attempts).toBe(3)

      // Still inside the block: rotation does not try the export again.
      await pool.rotateStale(retryAt - 60_000)
      expect(pool.repoExports).toBe(0)
    } finally {
      child.kill('SIGKILL')
      guest.stop(true)
    }
  })
  test('a corrupt .git reported on the tarball endpoint is classified there too', async () => {
    // The bundle endpoint is not the only export path: a project with no
    // manifest on a legacy guest still exports through `/pool/export-repo`, and
    // a corrupt `.git` must record the same block from that path (SHO-584).
    const guest = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: 'fatal: bad object 9f82099d', code: 'repo-corrupt' }, { status: 500 }),
    })
    try {
      const pool = makePool()
      const handle = { ...HANDLE, agentUrl: `http://localhost:${guest.port}` }
      const realExport = (MetalWarmPool.prototype as any).fetchRepoExport as (
        this: any,
        h: FcVmHandle,
        token?: string,
      ) => Promise<RepoExport | null>
      await expect(realExport.call(pool, handle, 'tok')).rejects.toBeInstanceOf(RepoCorruptError)
    } finally {
      guest.stop(true)
    }
  })
})

describe('SHO-584 · a final export that did not persist fails the step', () => {
  test('an over-size final data export throws instead of reporting "not written"', async () => {
    // `false` used to mean both "nothing changed, already durable" and "this was
    // never saved". A recycle treats the second as success and rotates the VM on
    // data that exists only in its own snapshot — a capped or over-limit final
    // copy must fail the step instead (SHO-584).
    const pool = makePool()
    const a = pool.add('p1')
    pool.data = { status: 'too-large', bytes: 900_000_000, limit: 500_000_000 }

    await expect(pool.saveProjectDataToStore(a, { final: true })).rejects.toThrow(/over the/)
    // The periodic sweep keeps its quiet "not saved" answer; only the final
    // export — the one a recycle depends on — throws.
    expect(await pool.saveProjectDataToStore(a)).toBe(false)
  })
})

describe('SHO-584 · a pending LFS push is a retry, not a broken repo', () => {
  class PendingLfsPool extends TestPool {
    pushes = 0
    protected override async guestHasRepoBundles(): Promise<boolean> {
      return true
    }
    protected override async exportRepoBundle(): Promise<any> {
      this.pushes += 1
      throw new RepoBundleLfsPendingError('an lfs push for p1 is still in flight')
    }
  }

  test('it records nothing permanent, so the next sweep exports again', async () => {
    const cfg = makeCfg({ rolloutIdleMs: 60_000, rolloutDeadlineMs: 24 * 3_600_000 })
    const fakeMgr = { adoptVM: () => {}, reapHostOrphans: () => 0, procCount: () => 0 } as unknown as FirecrackerVMManager
    const pool = new PendingLfsPool(fakeMgr, cfg as any, { kind: 'none' } as unknown as SnapshotStore)
    const a = pool.add('p1', { repoHeadSha: 'abc123' })

    await expect(pool.saveRepoToStore(a)).rejects.toThrow(/still in flight/)
    // A push that has not finished is not a corrupt `.git`: marking it would
    // block rotation for six hours over a push that completes on its own.
    expect(a.repoCorruptFailure).toBeUndefined()
    expect(a.rotateRetryAt).toBeUndefined()
    expect(a.rotationBlocked).toBeUndefined()

    // The next sweep asks the guest again — the export was never skipped.
    await expect(pool.saveRepoToStore(a)).rejects.toThrow(/still in flight/)
    expect(pool.pushes).toBe(2)
  })
})

describe('SHO-584 · a VM adopted mid-open is never a normal VM', () => {
  function seedLive(cfg: any, projectId: string, pid: number, agentUrl: string, extra: Partial<LiveVmEntry> = {}) {
    const reg = new LiveRegistry(cfg.runDir)
    const sock = join(cfg.runDir, `${projectId}.sock`)
    writeFileSync(sock, '')
    reg.put({
      projectId,
      vmId: `fcvm-${projectId}`,
      pid,
      guestIp: '127.0.0.1',
      agentUrl,
      socketPath: sock,
      serialLog: join(cfg.runDir, `${projectId}.serial`),
      net: { tap: 'fctap0', guestIp: '127.0.0.1' } as any,
      rootfs: join(cfg.runDir, `${projectId}.rootfs.ext4`),
      vcpus: 2,
      memoryMB: 4096,
      assignedAt: 1000,
      lastTouchedAt: 2000,
      workspaceOrigin: 'template',
      v: 1,
      ...extra,
    } as LiveVmEntry)
    return reg
  }

  test('untrusted on every archive, then retired without a snapshot', async () => {
    const cfg = makeCfg()
    const child = Bun.spawn(['sleep', '30'])
    const guest = Bun.serve({ port: 0, fetch: () => new Response('ok') })
    seedLive(cfg, 'mid-open', child.pid, `http://localhost:${guest.port}`, { openState: 'opening' })

    const fakeMgr = {
      adoptVM: () => {},
      reapHostOrphans: () => 0,
      procCount: () => 0,
      stopVM: async (h: FcVmHandle) => {
        stopped.push(h.id)
      },
    } as unknown as FirecrackerVMManager
    const pool = new TestPool(fakeMgr, cfg as any, { kind: 'none' } as unknown as SnapshotStore)
    try {
      const res = await pool.adopt()
      // It was adopted (its firecracker process is real and must not be reaped),
      // then retired: gone from the assigned set, stopped, and its registry entry
      // dropped so the next open cold-boots from the durable backup.
      expect(res.adopted).toEqual(['mid-open'])
      expect(pool.getAssigned('mid-open')).toBeUndefined()
      expect(stopped).toEqual(['fcvm-mid-open'])
      expect(new LiveRegistry(cfg.runDir).get('mid-open')).toBeNull()
    } finally {
      child.kill('SIGKILL')
      guest.stop(true)
    }
  })

  test('a person used it: kept running, and every archive is still untrusted', async () => {
    const cfg = makeCfg()
    const child = Bun.spawn(['sleep', '30'])
    const guest = Bun.serve({ port: 0, fetch: () => new Response('ok') })
    seedLive(cfg, 'used-mid-open', child.pid, `http://localhost:${guest.port}`, {
      openState: 'opening',
      // Someone opened it after the interrupted assign: their work is only here.
      userSeenSinceAssign: true,
    })

    const fakeMgr = {
      adoptVM: () => {},
      reapHostOrphans: () => 0,
      procCount: () => 0,
      stopVM: async (h: FcVmHandle) => {
        stopped.push(h.id)
      },
    } as unknown as FirecrackerVMManager
    const pool = new TestPool(fakeMgr, cfg as any, { kind: 'none' } as unknown as SnapshotStore)
    try {
      await pool.adopt()
      const a = pool.getAssigned('used-mid-open')
      expect(a).toBeDefined()
      expect(stopped).toEqual([])
      // Nothing it holds can overwrite a durable archive, however this ends.
      expect(a?.sourceUntrustedReason).toMatch(/mid-open/)
      expect(a?.dataUntrustedReason).toMatch(/mid-open/)
      expect(a?.homeUntrustedReason).toMatch(/mid-open/)
      expect(a?.repoUntrustedReason).toMatch(/mid-open/)
    } finally {
      child.kill('SIGKILL')
      guest.stop(true)
    }
  })

  test('a COMPLETE open is adopted as a normal VM', async () => {
    const cfg = makeCfg()
    const child = Bun.spawn(['sleep', '30'])
    const guest = Bun.serve({ port: 0, fetch: () => new Response('ok') })
    seedLive(cfg, 'ready', child.pid, `http://localhost:${guest.port}`, { openState: 'ready' })

    const fakeMgr = {
      adoptVM: () => {},
      reapHostOrphans: () => 0,
      procCount: () => 0,
      stopVM: async (h: FcVmHandle) => {
        stopped.push(h.id)
      },
    } as unknown as FirecrackerVMManager
    const pool = new TestPool(fakeMgr, cfg as any, { kind: 'none' } as unknown as SnapshotStore)
    try {
      await pool.adopt()
      const a = pool.getAssigned('ready')
      expect(a).toBeDefined()
      expect(stopped).toEqual([])
      expect(a?.sourceUntrustedReason).toBeUndefined()
      expect(a?.repoCorruptFailure).toBeUndefined()
    } finally {
      child.kill('SIGKILL')
      guest.stop(true)
    }
  })
})

describe('SHO-584 · quarantine dedupes and caps per project per day', () => {
  let writes: string[] = []
  beforeEach(() => {
    writes = []
  })
  const opts = (
    bytes: Uint8Array,
    state: QuarantineState,
    dailyCap: number,
    now?: number,
    kind: 'source' | 'data' | 'home' | 'repo' = 'source',
  ) => ({
    projectId: 'p1',
    kind,
    body: memoryBody(bytes),
    key: `conflict/p1/${writes.length}-${Math.random().toString(36).slice(2)}.tar.gz`,
    write: async (key: string) => {
      writes.push(key)
    },
    state,
    dailyCap,
    now,
  })

  test('identical bytes upload once and return the earlier key', async () => {
    const state: QuarantineState = {}
    const bytes = new TextEncoder().encode('the same half-open tree')
    const first = await quarantinedCopy(opts(bytes, state, 24))
    const second = await quarantinedCopy(opts(bytes, state, 24))

    expect(writes).toHaveLength(1)
    expect(second).toBe(first)
    // Different bytes for the same kind are a new copy.
    const third = await quarantinedCopy(opts(new TextEncoder().encode('other'), state, 24))
    expect(writes).toHaveLength(2)
    expect(third).not.toBe(first)
  })

  test('dedupe is per kind, so a repo copy never masks a source copy', async () => {
    const state: QuarantineState = {}
    const bytes = new TextEncoder().encode('same bytes, different archive')
    await quarantinedCopy(opts(bytes, state, 24, undefined, 'source'))
    await quarantinedCopy(opts(bytes, state, 24, undefined, 'repo'))
    expect(writes).toHaveLength(2)
  })

  test('N+1 quarantines in one UTC day write N and return null for the rest', async () => {
    const state: QuarantineState = {}
    const now = Date.UTC(2026, 10, 25, 12)
    const results: Array<string | null> = []
    for (let i = 0; i < 4; i++) {
      const bytes = new TextEncoder().encode(`copy ${i}`)
      results.push(await quarantinedCopy(opts(bytes, state, 3, now)))
    }
    expect(writes).toHaveLength(3)
    expect(results.slice(0, 3).every((k) => typeof k === 'string')).toBe(true)
    // Over the cap: nothing written, and the caller is told it is NOT saved.
    expect(results[3]).toBeNull()
    expect(state.writes).toBe(3)
  })

  test('the cap resets on the next UTC day (and the dedupe slot does not)', async () => {
    const state: QuarantineState = {}
    const day1 = Date.UTC(2026, 10, 25, 23, 59)
    await quarantinedCopy(opts(new TextEncoder().encode('a'), state, 1, day1))
    // Still 2026-11-25: over the cap.
    expect(await quarantinedCopy(opts(new TextEncoder().encode('b'), state, 1, day1 + 30_000))).toBeNull()

    const day2 = Date.UTC(2026, 10, 26, 0, 1)
    expect(await quarantinedCopy(opts(new TextEncoder().encode('c'), state, 1, day2))).not.toBeNull()
    expect(state.day).toBe('2026-11-26')
  })
})
