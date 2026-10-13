// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool — a `published:{id}` runtime is a read-only copy of its project.
 *
 * It must boot from the project's own `{id}/project-src.tar.gz` and never
 * write source, `.git` or project-data archives. Keyed by the runtime key it
 * restored `published:{id}/…` instead — archives only its own template boots
 * had written — so every cold boot served the starter app.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool, publishedSourceId } from './pool'
import type { ArchiveRef } from './archive-ref'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const HANDLE = { id: 'vm-1', agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any

class TestPool extends MetalWarmPool {
  sourceRefs: string[] = []
  repoRefs: string[] = []
  dataRefs: string[] = []
  uploads: string[] = []
  exports: string[] = []

  protected override async sourceRef(projectId: string): Promise<ArchiveRef | null> {
    this.sourceRefs.push(projectId)
    return { url: `https://store/${projectId}/project-src.tar.gz`, bytes: 10, etag: '"src-1"' } as ArchiveRef
  }
  protected override async repoRef(projectId: string): Promise<ArchiveRef | null> {
    this.repoRefs.push(projectId)
    return { url: `https://store/${projectId}/repo.git.tar.gz`, bytes: 10, etag: '"repo-1"' } as ArchiveRef
  }
  protected override async projectDataRef(projectId: string): Promise<ArchiveRef | null> {
    this.dataRefs.push(projectId)
    return { url: `https://store/${projectId}/project-data.tar.gz`, bytes: 10, etag: '"data-1"' } as ArchiveRef
  }
  protected override async fetchExport(): Promise<Uint8Array | null> {
    this.exports.push('source')
    return new Uint8Array([1])
  }
  protected override async fetchRepoExport() {
    this.exports.push('repo')
    return { bytes: new Uint8Array([1]), rootCommitAt: null }
  }
  protected override async uploadBackupGuarded(projectId: string): Promise<any> {
    this.uploads.push(`source:${projectId}`)
    return { status: 'written', etag: '"x"' }
  }
  protected override async uploadRepoGuarded(projectId: string): Promise<any> {
    this.uploads.push(`repo:${projectId}`)
    return { status: 'written', etag: '"x"' }
  }
  protected override async fetchDataExport(): Promise<any> {
    this.exports.push('data')
    return null
  }
  protected override async uploadDataGuarded(projectId: string): Promise<any> {
    this.uploads.push(`data:${projectId}`)
    return { status: 'written', etag: '"x"' }
  }
}

describe('publishedSourceId', () => {
  test('maps a published runtime key to its project', () => {
    expect(publishedSourceId('published:abc')).toBe('abc')
  })
  test('is null for every other key', () => {
    expect(publishedSourceId('abc')).toBeNull()
    expect(publishedSourceId('ws:proj:abc')).toBeNull()
    expect(publishedSourceId('ws:w1')).toBeNull()
    expect(publishedSourceId('published:')).toBeNull()
  })
})

describe('published runtime assign', () => {
  let dir: string
  let guest: ReturnType<typeof Bun.serve>
  let seen: Array<{ path: string; body: any }>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-pubsrc-'))
    seen = []
    guest = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname
        const text = req.method === 'POST' ? await req.text() : ''
        seen.push({ path, body: text.startsWith('{') ? JSON.parse(text) : null })
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })
  })
  afterEach(() => {
    guest.stop(true)
    rmSync(dir, { recursive: true, force: true })
  })

  function makePool(): TestPool {
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
    ;(pool as any).hydratePublishedData = async () => {}
    return pool
  }

  const PUBLISHED_ENV = { RUNTIME_AUTH_SECRET: 'tok', SHOGO_PUBLISHED_MODE: 'true', PUBLISHED_SUBDOMAIN: 'my-site' }

  test("boots from the project's own source archive, not published:{id}/", async () => {
    const pool = makePool()
    const a = await pool.assign('published:p1', PUBLISHED_ENV)

    expect(pool.sourceRefs).toEqual(['p1'])
    expect(seen.filter((s) => s.path === '/pool/hydrate-url').map((s) => s.body.url ?? s.body.urls)).toHaveLength(1)
    expect(a.workspaceOrigin).toBe('backup')
    expect(a.backupParentEtag).toBe('"src-1"')
  })

  test('skips the .git and project-data hydrates that would replace or leak into the site', async () => {
    const pool = makePool()
    await pool.assign('published:p1', PUBLISHED_ENV)

    expect(pool.repoRefs).toEqual([])
    expect(pool.dataRefs).toEqual([])
    expect(seen.map((s) => s.path)).not.toContain('/pool/repo-hydrated')
  })

  test('never exports or uploads source, .git or project data', async () => {
    const pool = makePool()
    const a = await pool.assign('published:p1', PUBLISHED_ENV)

    expect(await (pool as any).saveBackupToStore(a)).toBe('empty')
    expect(await pool.saveRepoToStore(a)).toBe(false)
    expect(await pool.saveProjectDataToStore(a, { final: true })).toBe(false)
    expect(await pool.exportAllRepos()).toBe(0)
    await pool.exportAllProjectData()
    expect(await (pool as any).storeRepoBytes(a, new Uint8Array([1]), null)).toBe('written')
    expect(await (pool as any).storeSource(a, new Uint8Array([1]))).toBe('written')

    expect(pool.exports).toEqual([])
    expect(pool.uploads).toEqual([])
  })

  test('a dev runtime still hydrates and backs up under its own key', async () => {
    const pool = makePool()
    const a = await pool.assign('p1', { RUNTIME_AUTH_SECRET: 'tok' })

    expect(pool.sourceRefs).toEqual(['p1'])
    expect(pool.repoRefs).toEqual(['p1'])
    expect(pool.dataRefs).toEqual(['p1'])
    await pool.saveRepoToStore(a)
    expect(pool.uploads).toContain('repo:p1')
  })

  test("the stale-snapshot gate compares a published snapshot against the project's source", async () => {
    const pool = makePool()
    pool.sourceRefs = []
    const stale = await (pool as any).snapshotBehindStore('published:p1', { backupEtag: '"src-1"' })
    expect(pool.sourceRefs).toEqual(['p1'])
    expect(stale).toBeNull()

    const behind = await (pool as any).snapshotBehindStore('published:p1', { backupEtag: '"older"' })
    expect(behind).toContain('source')
  })
})
