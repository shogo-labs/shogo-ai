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
import { MetalWarmPool, REPO_STAGING_DIR, type AssignedVm } from './pool'
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

  describe('cold-boot repo hydrate', () => {
    const ref = { url: 'https://store/p1/repo.git.tar.gz', bytes: 10, etag: '"r1"' } as any

    async function hydrate(pool: TestPool, guest: (path: string, body: any) => Response) {
      const seen: Array<{ path: string; body: any }> = []
      const realFetch = globalThis.fetch
      globalThis.fetch = mock((url: string, init?: RequestInit) => {
        const path = new URL(url).pathname
        const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null
        seen.push({ path, body })
        return Promise.resolve(guest(path, body))
      }) as any
      ;(pool as any).repoRef = async () => ref
      try {
        const r = await (pool as any).hydrateRepo('p1', HANDLE, { RUNTIME_AUTH_SECRET: 'tok' })
        return { r, seen }
      } finally {
        globalThis.fetch = realFetch
      }
    }

    test('stages the durable .git and has the guest swap it in and reset to HEAD', async () => {
      const pool = makePool(dir)
      const { r, seen } = await hydrate(pool, () => new Response('{}', { status: 200 }))

      expect(r).toEqual({ hydrated: true, parentEtag: '"r1"' })
      expect(seen.map((s) => s.path)).toEqual(['/pool/repo-hydrated', '/pool/hydrate-url', '/pool/repo-hydrated'])
      expect(seen[0].body).toEqual({ probe: true })
      expect(seen[1].body.destDir).toBe(REPO_STAGING_DIR)
      expect(seen[2].body).toEqual({ stagingDir: REPO_STAGING_DIR })
    })

    test('an older guest (no /pool/repo-hydrated) gets the legacy overlay and never a staged .git', async () => {
      const pool = makePool(dir)
      const { r, seen } = await hydrate(pool, (path) =>
        new Response('{}', { status: path === '/pool/repo-hydrated' ? 404 : 200 }),
      )

      expect(r.hydrated).toBe(true)
      expect(seen.map((s) => s.path)).toEqual(['/pool/repo-hydrated', '/pool/hydrate-url'])
      expect(seen[1].body.destDir).toBeUndefined()
    })

    test('a failed swap surfaces so assign() distrusts the repo', async () => {
      const pool = makePool(dir)
      await expect(
        hydrate(pool, (path, body) =>
          new Response('{"error":"reset failed"}', { status: path === '/pool/repo-hydrated' && body?.stagingDir ? 500 : 200 }),
        ),
      ).rejects.toThrow('/pool/repo-hydrated failed (500)')
    })
  })

  describe('workspace runtime assign', () => {
    function assignWorkspace(repoRef: object | null) {
      const seen: string[] = []
      const guest = Bun.serve({
        port: 0,
        fetch: (req) => {
          seen.push(new URL(req.url).pathname)
          return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
        },
      })
      const cfg = { ...config, work: dir, snapDir: join(dir, 'snap'), runDir: join(dir, 'run'), poolSize: 0 } as typeof config
      mkdirSync(cfg.snapDir, { recursive: true })
      mkdirSync(cfg.runDir, { recursive: true })
      const mgr = {
        startVM: async () => ({ ...HANDLE, agentUrl: `http://127.0.0.1:${guest.port}`, rootfs: '/tmp/fake', vmClass: 'standard' }),
        stopVM: async () => {},
        isRunning: () => true,
        procCount: () => 0,
      } as unknown as FirecrackerVMManager
      const pool = new TestPool(mgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
      ;(pool as any).sourceRef = async () => null
      ;(pool as any).repoRef = async () => repoRef
      const run = pool
        .assign('ws:proj:p1', { RUNTIME_AUTH_SECRET: 'tok', WORKSPACE_PROJECT_IDS: 'p1' })
        .finally(() => guest.stop(true))
      return { pool, seen, run }
    }

    test('hydrates the durable merged-root .git so later exports descend from it', async () => {
      const { pool, seen, run } = assignWorkspace({ url: 'https://store/ws/repo.git.tar.gz', bytes: 10, etag: '"ws-r1"' })
      const a = await run
      expect(seen).toContain('/pool/repo-hydrated')
      expect(a.repoParentEtag).toBe('"ws-r1"')

      await pool.saveRepoToStore(a)
      expect(pool.uploads[0].opts.lineage).toEqual({ kind: 'descends', etag: '"ws-r1"' })
    })

    test('stays create-only when no durable repo exists yet', async () => {
      const { pool, seen, run } = assignWorkspace(null)
      const a = await run
      expect(seen).not.toContain('/pool/repo-hydrated')
      expect(a.repoParentEtag).toBeUndefined()

      await pool.saveRepoToStore(a)
      expect(pool.uploads[0].opts.lineage).toEqual({ kind: 'create-only' })
    })
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
