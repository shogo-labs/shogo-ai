// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool — host-mediated `.git` durability wiring (`repo.git.tar.gz`).
 *
 * Metal guests hold no S3 credentials, so the host pulls `/pool/export-repo`
 * and uploads under the same lineage guard as writable state.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { RepoLineage, RepoWriteOutcome } from './repo-archive'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const HANDLE = { id: 'vm-1', agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any

class TestPool extends MetalWarmPool {
  uploads: Array<{ projectId: string; bytes: Uint8Array; opts: { lineage: RepoLineage } }> = []
  outcome: RepoWriteOutcome = { status: 'written', etag: '"new-repo"' }
  exportBytes: Uint8Array | null = new Uint8Array([1, 2, 3])

  protected override async fetchRepoExport(): Promise<Uint8Array | null> {
    return this.exportBytes
  }

  protected override async uploadRepoGuarded(
    projectId: string,
    bytes: Uint8Array,
    opts: { lineage: RepoLineage; preserveOnRefusal?: boolean },
  ): Promise<RepoWriteOutcome> {
    this.uploads.push({ projectId, bytes, opts })
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

function makePool(dir: string): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = { procCount: () => 0, isRunning: () => true } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

describe('pool host-mediated repo persist', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-repo-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('a descending VM uploads with If-Match lineage', async () => {
    const pool = makePool(dir)
    const a = pool.add('p1', { repoParentEtag: '"old"' })
    expect(await pool.saveRepoToStore(a)).toBe(true)
    expect(pool.uploads).toHaveLength(1)
    expect(pool.uploads[0].opts.lineage).toEqual({ kind: 'descends', etag: '"old"' })
    expect(a.repoParentEtag).toBe('"new-repo"')
  })

  test('an untrusted VM never uploads', async () => {
    const pool = makePool(dir)
    const a = pool.add('p1', { repoUntrustedReason: 'hydrate failed' })
    expect(await pool.saveRepoToStore(a)).toBe(false)
    expect(pool.uploads).toHaveLength(0)
  })

  test('a brand-new VM is create-only', async () => {
    const pool = makePool(dir)
    pool.outcome = { status: 'created', etag: '"first"' }
    const a = pool.add('p1')
    expect(await pool.saveRepoToStore(a)).toBe(true)
    expect(pool.uploads[0].opts.lineage).toEqual({ kind: 'create-only' })
  })

  test('pollActivity exports when repoHeadSha changes', async () => {
    const pool = makePool(dir)
    const a = pool.add('p1', { repoHeadSha: 'aaa' })
    const realFetch = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ lastRequestAt: 1, activeStreams: 0, repoHeadSha: 'bbb' }), { status: 200 }),
      ),
    ) as any
    try {
      await pool.pollActivity()
      await Bun.sleep(10)
      expect(a.repoHeadSha).toBe('bbb')
      expect(pool.uploads.length).toBeGreaterThanOrEqual(1)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
