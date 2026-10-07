// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool — `.git` export cost: the periodic sweep skips a HEAD that is already
 * durable and backs off failures, and the guest's export is spooled to disk
 * under a size cap rather than buffered in the agent's heap.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import {
  ExportTooLargeError,
  MetalWarmPool,
  spoolResponse,
  type AssignedVm,
  type RepoExport,
} from './pool'
import type { RepoBody, RepoLineage, RepoWriteOutcome } from './repo-archive'
import type { FirecrackerVMManager, FcVmHandle } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const HANDLE = { id: 'vm-1', agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any

class SweepPool extends MetalWarmPool {
  exports = 0
  failExport: Error | null = null
  outcome: RepoWriteOutcome = { status: 'written', etag: '"e"' }

  protected override async fetchRepoExport(): Promise<RepoExport | null> {
    this.exports++
    if (this.failExport) throw this.failExport
    return { bytes: new Uint8Array([1, 2, 3]), rootCommitAt: null }
  }

  protected override async uploadRepoGuarded(): Promise<RepoWriteOutcome> {
    return this.outcome
  }

  add(projectId: string, extra: Partial<AssignedVm> = {}): AssignedVm {
    const a = {
      projectId,
      handle: HANDLE,
      assignedAt: Date.now(),
      lastTouchedAt: Date.now(),
      runtimeToken: 'tok',
      ...extra,
    } as AssignedVm
    ;(this as any).assigned.set(projectId, a)
    return a
  }
}

/** Uses the real `fetchRepoExport`; captures what reaches the uploader. */
class SpoolPool extends SweepPool {
  uploaded: Array<{ size: number; text: string; path?: string }> = []

  protected override fetchRepoExport(handle: FcVmHandle, token?: string): Promise<RepoExport | null> {
    return (MetalWarmPool.prototype as any).fetchRepoExport.call(this, handle, token)
  }

  protected override async uploadRepoGuarded(
    _projectId: string,
    bytes: RepoBody,
    _opts: { lineage: RepoLineage },
  ): Promise<RepoWriteOutcome> {
    if (bytes instanceof Uint8Array) throw new Error('expected a file-backed export')
    this.uploaded.push({ size: bytes.size, text: await bytes.text(), path: bytes.name })
    return this.outcome
  }

  get spoolDir(): string {
    return this.exportSpoolDir
  }
}

function makeCfg(dir: string): typeof config {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  return cfg
}

function makePool<T extends MetalWarmPool>(Ctor: new (...args: any[]) => T, dir: string): T {
  const fakeMgr = { procCount: () => 0, isRunning: () => true } as unknown as FirecrackerVMManager
  return new Ctor(fakeMgr, makeCfg(dir), { kind: 'none' } as unknown as SnapshotStore)
}

describe('exportAllRepos', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-repo-sweep-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('skips a VM whose reported HEAD is already durable', async () => {
    const pool = makePool(SweepPool, dir)
    const a = pool.add('p1', { repoParentEtag: '"old"', repoHeadSha: 'aaa' })

    expect(await pool.exportAllRepos()).toBe(1)
    expect(a.repoExportedHeadSha).toBe('aaa')
    expect(await pool.exportAllRepos()).toBe(0)
    expect(pool.exports).toBe(1)

    a.repoHeadSha = 'bbb'
    expect(await pool.exportAllRepos()).toBe(1)
    expect(pool.exports).toBe(2)
    expect(a.repoExportedHeadSha).toBe('bbb')
  })

  test('a guest that reports no HEAD is exported every sweep', async () => {
    const pool = makePool(SweepPool, dir)
    pool.add('p1', { repoParentEtag: '"old"' })
    await pool.exportAllRepos()
    await pool.exportAllRepos()
    expect(pool.exports).toBe(2)
  })

  test('a quarantined export also counts as handled for that HEAD', async () => {
    const pool = makePool(SweepPool, dir)
    pool.outcome = { status: 'conflict', quarantineKey: 'conflict/p1/x', reason: 'lineage' }
    const a = pool.add('p1', { repoParentEtag: '"old"', repoHeadSha: 'aaa' })
    await pool.exportAllRepos()
    await pool.exportAllRepos()
    expect(pool.exports).toBe(1)
    expect(a.repoExportedHeadSha).toBe('aaa')
  })

  test('a lost export is retried on the next sweep', async () => {
    const pool = makePool(SweepPool, dir)
    pool.outcome = { status: 'skipped' }
    const a = pool.add('p1', { repoParentEtag: '"old"', repoHeadSha: 'aaa' })
    await pool.exportAllRepos()
    await pool.exportAllRepos()
    expect(pool.exports).toBe(2)
    expect(a.repoExportedHeadSha).toBeUndefined()
  })

  test('failures back off exponentially and reset on success', async () => {
    const pool = makePool(SweepPool, dir)
    pool.failExport = new Error('timed out')
    const a = pool.add('p1', { repoParentEtag: '"old"', repoHeadSha: 'aaa' })
    const t0 = 1_000_000

    await pool.exportAllRepos(t0)
    expect(a.repoExportFailures).toBe(1)
    expect(a.repoExportRetryAt).toBe(t0 + 60_000)

    await pool.exportAllRepos(t0 + 30_000)
    expect(pool.exports).toBe(1)

    await pool.exportAllRepos(t0 + 60_000)
    expect(pool.exports).toBe(2)
    expect(a.repoExportRetryAt).toBe(t0 + 60_000 + 120_000)

    a.repoExportFailures = 10
    await pool.exportAllRepos(t0 + 10 * 60 * 60_000)
    expect(a.repoExportRetryAt).toBe(t0 + 10 * 60 * 60_000 + 30 * 60_000)

    pool.failExport = null
    await pool.exportAllRepos(t0 + 24 * 60 * 60_000)
    expect(a.repoExportFailures).toBe(0)
    expect(a.repoExportRetryAt).toBeUndefined()
    expect(a.repoExportedHeadSha).toBe('aaa')
  })
})

describe('spoolResponse', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-spool-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('writes a streamed body to disk and returns its size', async () => {
    const chunks = [new Uint8Array(1000).fill(1), new Uint8Array(500).fill(2)]
    const body = new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(ch)
        c.close()
      },
    })
    const path = join(dir, 'out')
    expect(await spoolResponse(new Response(body), path, 10_000)).toBe(1500)
    const written = new Uint8Array(await Bun.file(path).arrayBuffer())
    expect(written.byteLength).toBe(1500)
    expect(written[999]).toBe(1)
    expect(written[1000]).toBe(2)
  })

  test('refuses a declared Content-Length over the cap without reading', async () => {
    const res = new Response('x'.repeat(100), { headers: { 'content-length': '100' } })
    await expect(spoolResponse(res, join(dir, 'out'), 10)).rejects.toBeInstanceOf(ExportTooLargeError)
    expect(existsSync(join(dir, 'out'))).toBe(false)
  })

  test('stops reading a chunked body once it passes the cap', async () => {
    let pulled = 0
    const body = new ReadableStream({
      pull(c) {
        pulled++
        c.enqueue(new Uint8Array(64))
      },
    })
    const err = await spoolResponse(new Response(body), join(dir, 'out'), 200).catch((e) => e)
    expect(err).toBeInstanceOf(ExportTooLargeError)
    expect(err.bytes).toBe(256)
    expect(pulled).toBeLessThan(10)
  })
})

describe('fetchRepoExport spools to disk', () => {
  let dir: string
  let server: ReturnType<typeof Bun.serve>
  let reply: () => Response

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-repo-spool-'))
    server = Bun.serve({ port: 0, fetch: () => reply() })
  })
  afterEach(() => {
    server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  })

  const handle = () => ({ ...HANDLE, agentUrl: `http://127.0.0.1:${server.port}` })

  test('uploads the export from a spool file and removes it afterwards', async () => {
    reply = () => new Response('repo-bytes', { headers: { 'x-shogo-repo-root-commit-at': '0' } })
    const pool = makePool(SpoolPool, dir)
    const a = pool.add('p1', { handle: handle(), repoParentEtag: '"old"' })

    expect(await pool.saveRepoToStore(a)).toBe(true)
    expect(pool.uploaded).toHaveLength(1)
    expect(pool.uploaded[0].text).toBe('repo-bytes')
    expect(pool.uploaded[0].size).toBe(10)
    expect(pool.uploaded[0].path!.startsWith(pool.spoolDir)).toBe(true)
    expect(readdirSync(pool.spoolDir)).toEqual([])
  })

  test('an empty export uploads nothing and leaves no spool file', async () => {
    reply = () => new Response('')
    const pool = makePool(SpoolPool, dir)
    const a = pool.add('p1', { handle: handle(), repoParentEtag: '"old"' })

    expect(await pool.saveRepoToStore(a)).toBe(false)
    expect(pool.uploaded).toHaveLength(0)
    expect(readdirSync(pool.spoolDir)).toEqual([])
  })

  test('the spool file is removed when the upload throws', async () => {
    reply = () => new Response('repo-bytes')
    const pool = makePool(SpoolPool, dir)
    ;(pool as any).uploadRepoGuarded = async () => {
      throw new Error('s3 down')
    }
    const a = pool.add('p1', { handle: handle(), repoParentEtag: '"old"' })

    await expect(pool.saveRepoToStore(a)).rejects.toThrow('s3 down')
    expect(readdirSync(pool.spoolDir)).toEqual([])
  })

  test('a stale spool dir is emptied when the pool starts', () => {
    const cfg = makeCfg(dir)
    const stale = join(cfg.runDir, 'exports')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'old.tar.gz'), 'x')
    const fakeMgr = { procCount: () => 0, isRunning: () => true } as unknown as FirecrackerVMManager
    new SpoolPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
    expect(existsSync(stale)).toBe(false)
  })
})
