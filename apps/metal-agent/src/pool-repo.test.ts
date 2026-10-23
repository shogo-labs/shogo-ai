// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool — host-mediated `.git` durability wiring (`repo.git.tar.gz`).
 *
 * Metal guests hold no S3 credentials, so the host pulls `/pool/export-repo`
 * and uploads under the same lineage guard as writable state.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import {
  MetalWarmPool,
  RepoBundleLfsPushError,
  REPO_STAGING_DIR,
  RepoHydrateRefusedError,
  repoKeepPaths,
  type AssignedVm,
  type RepoExport,
} from './pool'
import type { RepoLineage, RepoWriteOutcome } from './repo-archive'
import { parseRepoManifest, type RepoManifest } from './vendor/repo-bundles'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const HANDLE = { id: 'vm-1', agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any

class TestPool extends MetalWarmPool {
  uploads: Array<{ projectId: string; bytes: Uint8Array; opts: { lineage: RepoLineage } }> = []
  outcome: RepoWriteOutcome = { status: 'written', etag: '"new-repo"' }
  /** Per-call outcomes, consumed before falling back to `outcome`. */
  outcomes: RepoWriteOutcome[] = []
  exportBytes: Uint8Array | null = new Uint8Array([1, 2, 3])
  exportRootCommitAt: number | null = null
  durable: { etag: string | null; lastModified: number | null } | null = null
  statCalls = 0
  preserved: string[] = []
  preserveKey: string | null = 'conflict/p1/superseded-repo.tar.gz'

  protected override async guestHasRepoBundles(): Promise<boolean> {
    return false
  }

  protected override async statDurableRepo() {
    this.statCalls++
    return this.durable
  }

  protected override async preserveDurableRepo(projectId: string) {
    this.preserved.push(projectId)
    return this.preserveKey
  }

  protected override async fetchRepoExport(): Promise<RepoExport | null> {
    return this.exportBytes ? { bytes: this.exportBytes, rootCommitAt: this.exportRootCommitAt } : null
  }

  protected override async uploadRepoGuarded(
    projectId: string,
    bytes: Uint8Array,
    opts: { lineage: RepoLineage; preserveOnRefusal?: boolean },
  ): Promise<RepoWriteOutcome> {
    this.uploads.push({ projectId, bytes, opts })
    return this.outcomes.shift() ?? this.outcome
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

describe('repoKeepPaths', () => {
  test('keeps only the paths whose source backup is not older than the repo', () => {
    expect(repoKeepPaths({ m2: 3_000, m1: 5_000, m3: 1_000, m4: 1_999 }, 2_000)).toEqual(['m1', 'm2'])
  })

  test('a same-second tie keeps the source (S3 Last-Modified is second-granular)', () => {
    expect(repoKeepPaths({ '.': 2_000 }, 2_000)).toEqual(['.'])
  })

  test('an unknown age on either side keeps nothing (the full reset)', () => {
    expect(repoKeepPaths({ '.': 5_000 }, null)).toEqual([])
    expect(repoKeepPaths({ m1: null }, 1_000)).toEqual([])
  })
})

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

  describe('an unlinked VM whose export hits an existing durable repo', () => {
    const conflict: RepoWriteOutcome = { status: 'conflict', quarantineKey: 'conflict/p1/q.tar.gz', reason: 'raced-create' }
    const HOUR = 60 * 60_000
    const STATE_SINCE = 1_790_000_000_000
    const OLD_ROOT = STATE_SINCE - 48 * HOUR

    test('supersedes a repo nobody wrote since its state began, keeping the old archive', async () => {
      const pool = makePool(dir)
      pool.outcomes = [conflict, { status: 'written', etag: '"promoted"' }]
      pool.durable = { etag: '"stale"', lastModified: STATE_SINCE - HOUR }
      pool.exportRootCommitAt = OLD_ROOT
      const a = pool.add('ws:proj:p1', { stateSince: STATE_SINCE })

      expect(await pool.saveRepoToStore(a)).toBe(true)
      expect(pool.preserved).toEqual(['ws:proj:p1'])
      expect(pool.uploads[1].opts.lineage).toEqual({ kind: 'descends', etag: '"stale"' })
      expect(a.repoParentEtag).toBe('"promoted"')

      pool.outcomes = []
      pool.exportBytes = new Uint8Array([4, 5, 6])
      await pool.saveRepoToStore(a)
      expect(pool.uploads[2].opts.lineage).toEqual({ kind: 'descends', etag: '"promoted"' })
    })

    test('never supersedes with a repo whose history began on this boot', async () => {
      const pool = makePool(dir)
      pool.outcomes = [conflict]
      pool.durable = { etag: '"real-history"', lastModified: STATE_SINCE - HOUR }
      pool.exportRootCommitAt = STATE_SINCE + 60_000
      const a = pool.add('ws:proj:p1', { stateSince: STATE_SINCE })

      expect(await pool.saveRepoToStore(a)).toBe(false)
      expect(pool.uploads).toHaveLength(1)
      expect(pool.preserved).toHaveLength(0)
      expect(pool.statCalls).toBe(0)
    })

    test('never supersedes when the guest did not report when its history began', async () => {
      const pool = makePool(dir)
      pool.outcomes = [conflict]
      pool.durable = { etag: '"real-history"', lastModified: STATE_SINCE - HOUR }
      pool.exportRootCommitAt = null
      const a = pool.add('ws:proj:p1', { stateSince: STATE_SINCE })

      expect(await pool.saveRepoToStore(a)).toBe(false)
      expect(pool.uploads).toHaveLength(1)
      expect(pool.preserved).toHaveLength(0)
    })

    test('leaves the conflict when another VM wrote the repo after its state began', async () => {
      const pool = makePool(dir)
      pool.outcomes = [conflict]
      pool.durable = { etag: '"other-writer"', lastModified: STATE_SINCE + HOUR }
      pool.exportRootCommitAt = OLD_ROOT
      const a = pool.add('ws:proj:p1', { stateSince: STATE_SINCE })

      expect(await pool.saveRepoToStore(a)).toBe(false)
      expect(pool.uploads).toHaveLength(1)
      expect(pool.preserved).toHaveLength(0)
      expect(a.repoParentEtag).toBeUndefined()
    })

    test('a linked VM never tries to supersede', async () => {
      const pool = makePool(dir)
      pool.outcomes = [{ ...conflict, reason: 'lineage' }]
      pool.durable = { etag: '"x"', lastModified: STATE_SINCE - HOUR }
      pool.exportRootCommitAt = OLD_ROOT
      const a = pool.add('ws:proj:p1', { repoParentEtag: '"old"', stateSince: STATE_SINCE })

      expect(await pool.saveRepoToStore(a)).toBe(false)
      expect(pool.statCalls).toBe(0)
    })

    test('does not overwrite when the old archive could not be kept', async () => {
      const pool = makePool(dir)
      pool.outcomes = [conflict]
      pool.durable = { etag: '"stale"', lastModified: STATE_SINCE - HOUR }
      pool.exportRootCommitAt = OLD_ROOT
      pool.preserveKey = null
      const a = pool.add('ws:proj:p1', { stateSince: STATE_SINCE })

      expect(await pool.saveRepoToStore(a)).toBe(false)
      expect(pool.uploads).toHaveLength(1)
    })
  })

  describe('WORKSPACE_NEW_PROJECT_IDS at assign', () => {
    test('lists only members the store confirms have no backup', async () => {
      const pool = makePool(dir)
      ;(pool as any).sourceRef = async (id: string) => {
        if (id === 'broken') throw new Error('store unreachable')
        return id === 'has-backup' ? ({ etag: '"e"' } as any) : null
      }
      const env = await (pool as any).withConfirmedNewMembers({
        WORKSPACE_PROJECT_IDS: 'fresh, has-backup,broken',
        OTHER: 'kept',
      })
      expect(env.WORKSPACE_NEW_PROJECT_IDS).toBe('fresh')
      expect(env.OTHER).toBe('kept')
    })

    test('sends an empty list when no member is new', async () => {
      const pool = makePool(dir)
      ;(pool as any).sourceRef = async () => ({ etag: '"e"' }) as any
      const env = await (pool as any).withConfirmedNewMembers({ WORKSPACE_PROJECT_IDS: 'a' })
      expect(env.WORKSPACE_NEW_PROJECT_IDS).toBe('')
    })
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

      expect(r).toEqual({ hydrated: true, parentEtag: '"r1"', keptPaths: [] })
      expect(seen.map((s) => s.path)).toEqual(['/pool/repo-hydrated', '/pool/hydrate-url', '/pool/repo-hydrated'])
      expect(seen[0].body).toEqual({ probe: true })
      expect(seen[1].body.destDir).toBe(REPO_STAGING_DIR)
      expect(seen[2].body).toEqual({ stagingDir: REPO_STAGING_DIR, timeoutMs: config.hydrateTimeoutMs })
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

    test('asks the guest to keep source newer than the repo, within the host deadline', async () => {
      const pool = makePool(dir)
      ;(pool as any).cfg = { ...(pool as any).cfg, hydrateTimeoutMs: 1_000 }
      const stale = { ...ref, lastModified: 1_000 }
      const realFetch = globalThis.fetch
      const seen: any[] = []
      globalThis.fetch = mock((url: string, init?: RequestInit) => {
        const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null
        seen.push({ path: new URL(url).pathname, body })
        return Promise.resolve(Response.json({ ok: true, deadline: true }))
      }) as any
      ;(pool as any).repoRef = async () => stale
      try {
        const r = await (pool as any).hydrateRepo('p1', HANDLE, {}, { '.': 2_000 })
        expect(r.keptPaths).toEqual(['.'])
      } finally {
        globalThis.fetch = realFetch
      }
      expect(seen.at(-1).body).toEqual({ stagingDir: REPO_STAGING_DIR, timeoutMs: 1_000, keepPaths: ['.'] })
    })

    test('a guest that answers with an error did not adopt, so the tree is not in doubt', async () => {
      const pool = makePool(dir)
      await expect(
        hydrate(pool, (_path, body) => new Response('{}', { status: body?.stagingDir ? 504 : 200 })),
      ).rejects.toBeInstanceOf(RepoHydrateRefusedError)
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

  describe('cold-boot hydrate from the incremental manifest', () => {
    const manifest = parseRepoManifest({
      v: 1,
      head: { ref: 'refs/heads/main' },
      refs: { 'refs/heads/main': 'a'.repeat(40) },
      config: '[core]\n',
      rootCommitAt: null,
      bundles: [{ sha256: 'b'.repeat(64), bytes: 9, kind: 'base' }],
    })
    const read = { manifest, etag: '"m1"', lastModified: null }
    const bundleRefs = [{ ...manifest.bundles[0], url: 'https://store/repo/bundles/b.bundle' }]

    function hydrateFromManifest(pool: TestPool, guest: (path: string, body: any) => Response) {
      const seen: Array<{ path: string; body: any }> = []
      const realFetch = globalThis.fetch
      globalThis.fetch = mock((url: string, init?: RequestInit) => {
        const path = new URL(url).pathname
        const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null
        seen.push({ path, body })
        return Promise.resolve(guest(path, body))
      }) as any
      ;(pool as any).repoManifest = async () => read
      ;(pool as any).presignRepoBundles = async () => bundleRefs
      ;(pool as any).repoRef = async () => {
        throw new Error('the legacy tarball must not be read when a manifest exists')
      }
      return { seen, restore: () => { globalThis.fetch = realFetch } }
    }

    test('stages from the bundles, adopts them, and keeps the manifest etag as lineage', async () => {
      const pool = makePool(dir)
      const h = hydrateFromManifest(pool, (path) =>
        Response.json(path === '/pool/repo-hydrated' ? { ok: true, deadline: true, bundles: true } : { ok: true }),
      )
      try {
        const r = await (pool as any).hydrateRepo('p1', HANDLE, { RUNTIME_AUTH_SECRET: 'tok' })
        expect(r).toEqual({ hydrated: true, parentEtag: '"m1"', keptPaths: [] })
        expect(h.seen.map((s) => s.path)).toEqual(['/pool/repo-hydrated', '/pool/repo-bundles-hydrate', '/pool/repo-hydrated'])
        expect(h.seen[1].body.bundles).toEqual([{ sha256: 'b'.repeat(64), url: 'https://store/repo/bundles/b.bundle' }])
        expect(h.seen[1].body.manifest.refs).toEqual({ 'refs/heads/main': 'a'.repeat(40) })
        expect(h.seen[1].body.stagingDir).toBe(REPO_STAGING_DIR)
        expect(h.seen[2].body).toEqual({ stagingDir: REPO_STAGING_DIR, timeoutMs: config.hydrateTimeoutMs })
      } finally {
        h.restore()
      }
    })

    test('refuses a guest without bundle support rather than restoring the stale tarball', async () => {
      const pool = makePool(dir)
      const h = hydrateFromManifest(pool, () => Response.json({ ok: true, supported: true, deadline: true }))
      try {
        await expect((pool as any).hydrateRepo('p1', HANDLE, {})).rejects.toThrow(/refusing to restore a stale tarball/)
        expect(h.seen.map((s) => s.path)).toEqual(['/pool/repo-hydrated'])
      } finally {
        h.restore()
      }
    })

    test('a bundle the guest cannot verify stops before the live tree is touched', async () => {
      const pool = makePool(dir)
      const h = hydrateFromManifest(pool, (path) =>
        path === '/pool/repo-bundles-hydrate'
          ? Response.json({ error: 'bundle failed its checksum' }, { status: 500 })
          : Response.json({ ok: true, deadline: true, bundles: true }),
      )
      try {
        await expect((pool as any).hydrateRepo('p1', HANDLE, {})).rejects.toThrow(/repo-bundles-hydrate failed \(500\)/)
        expect(h.seen.map((s) => s.path)).toEqual(['/pool/repo-hydrated', '/pool/repo-bundles-hydrate'])
      } finally {
        h.restore()
      }
    })

    test('drift stamps the manifest etag once a manifest exists', async () => {
      const pool = makePool(dir)
      ;(pool as any).repoManifest = async () => read
      ;(pool as any).repoRef = async () => ({ etag: '"tar"', bytes: 1 })
      const ref = await (pool as any).repoStampRef('p1')
      expect(ref.etag).toBe('"m1"')
    })
  })

  describe('incremental repo writer', () => {
    const ENTRY_BASE_BYTES = new TextEncoder().encode('base-bundle-bytes')
    const ENTRY_INCR_BYTES = new TextEncoder().encode('incr')
    const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
    const baseEntry = { sha256: sha(ENTRY_BASE_BYTES), bytes: ENTRY_BASE_BYTES.byteLength, kind: 'base' as const }
    const incrEntry = { sha256: sha(ENTRY_INCR_BYTES), bytes: ENTRY_INCR_BYTES.byteLength, kind: 'incr' as const }
    const head = { ref: 'refs/heads/main' }
    const oldTip = 'a'.repeat(40)
    const newTip = 'c'.repeat(40)

    let prevManifest: RepoManifest | null
    let exportCalls: Array<{ since: string[] | null }>
    let guestCapable = true
    let bundleUploads: string[]
    let manifestWrites: Array<{ manifest: RepoManifest; lineage: RepoLineage }>
    let manifestOutcome: RepoWriteOutcome
    let bundleFetchBytes: Uint8Array

    function writer(pool: TestPool, exportResult: any) {
      // Keep the background sweep out of the writer tests; it has its own coverage.
      ;(pool as any).scheduleRepoBundleSweep = () => {}
      ;(pool as any).guestHasRepoBundles = async () => guestCapable
      exportCalls = []
      bundleUploads = []
      manifestWrites = []
      ;(pool as any).repoManifest = async () => (prevManifest ? { manifest: prevManifest, etag: '"m1"', lastModified: null } : null)
      ;(pool as any).exportRepoBundle = async (_a: AssignedVm, since: string[] | null) => {
        exportCalls.push({ since })
        if (exportResult instanceof Error) throw exportResult
        return exportResult
      }
      ;(pool as any).uploadRepoBundleGuarded = async (_p: string, entry: { sha256: string }) => {
        bundleUploads.push(entry.sha256)
        return 'uploaded'
      }
      ;(pool as any).uploadManifestGuarded = async (_p: string, manifest: RepoManifest, opts: { lineage: RepoLineage }) => {
        manifestWrites.push({ manifest, lineage: opts.lineage })
        return manifestOutcome
      }
      ;(pool as any).preserveDurableManifest = async () => 'conflict/p1/superseded-manifest.json'
      const realFetch = globalThis.fetch
      globalThis.fetch = mock(() => Promise.resolve(new Response(bundleFetchBytes))) as any
      return () => {
        globalThis.fetch = realFetch
      }
    }

    const exportOf = (bundle: unknown, refs: Record<string, string> = { 'refs/heads/main': newTip }) => ({
      bundle,
      head,
      refs,
      config: '[core]\n',
      rootCommitAt: null,
    })

    beforeEach(() => {
      guestCapable = true
      prevManifest = null
      manifestOutcome = { status: 'created', etag: '"m1"' }
      bundleFetchBytes = ENTRY_BASE_BYTES
    })

    test('a project with no manifest gets a full base, then its manifest is created', async () => {
      const pool = makePool(dir)
      const restore = writer(pool, exportOf(baseEntry, { 'refs/heads/main': oldTip }))
      try {
        const a = pool.add('p1', { repoParentEtag: undefined })
        expect(await pool.saveRepoToStore(a)).toBe(true)
        expect(exportCalls[0].since).toBeNull()
        expect(bundleUploads).toEqual([baseEntry.sha256])
        expect(manifestWrites[0].manifest.bundles).toEqual([baseEntry])
        expect(manifestWrites[0].lineage).toEqual({ kind: 'create-only' })
        expect(a.repoParentEtag).toBe('"m1"')
      } finally {
        restore()
      }
    })

    test('nothing new since the manifest writes nothing', async () => {
      const pool = makePool(dir)
      prevManifest = parseRepoManifest({
        v: 1,
        head,
        refs: { 'refs/heads/main': newTip },
        config: '[core]\n',
        rootCommitAt: null,
        bundles: [baseEntry],
      })
      const restore = writer(pool, exportOf(null, { 'refs/heads/main': newTip }))
      try {
        const a = pool.add('p1', { repoParentEtag: '"m1"' })
        expect(await pool.saveRepoToStore(a)).toBe(false)
        expect(bundleUploads).toHaveLength(0)
        expect(manifestWrites).toHaveLength(0)
      } finally {
        restore()
      }
    })

    test('a new commit uploads an incremental against the recorded tips and extends the chain', async () => {
      const pool = makePool(dir)
      prevManifest = parseRepoManifest({
        v: 1,
        head,
        refs: { 'refs/heads/main': oldTip },
        config: '[core]\n',
        rootCommitAt: null,
        bundles: [baseEntry],
      })
      bundleFetchBytes = ENTRY_INCR_BYTES
      const restore = writer(pool, exportOf(incrEntry))
      try {
        const a = pool.add('p1', { repoParentEtag: '"m1"' })
        expect(await pool.saveRepoToStore(a)).toBe(true)
        expect(exportCalls[0].since).toEqual([oldTip])
        expect(manifestWrites[0].manifest.bundles.map((b) => b.kind)).toEqual(['base', 'incr'])
        expect(manifestWrites[0].lineage).toEqual({ kind: 'descends', etag: '"m1"' })
      } finally {
        restore()
      }
    })

    test('a chain past the compaction threshold restarts with a full base', async () => {
      const pool = makePool(dir)
      const incrs = Array.from({ length: 50 }, (_, i) => ({ sha256: i.toString(16).padStart(64, '0'), bytes: 1, kind: 'incr' as const }))
      prevManifest = parseRepoManifest({
        v: 1,
        head,
        refs: { 'refs/heads/main': oldTip },
        config: '[core]\n',
        rootCommitAt: null,
        bundles: [baseEntry, ...incrs],
      })
      const restore = writer(pool, exportOf(baseEntry))
      try {
        const a = pool.add('p1', { repoParentEtag: '"m1"' })
        expect(await pool.saveRepoToStore(a)).toBe(true)
        expect(exportCalls[0].since).toBeNull()
        expect(manifestWrites[0].manifest.bundles).toEqual([baseEntry])
      } finally {
        restore()
      }
    })

    test('a conflicting write quarantines the manifest and leaves the lineage alone', async () => {
      const pool = makePool(dir)
      prevManifest = parseRepoManifest({
        v: 1,
        head,
        refs: { 'refs/heads/main': oldTip },
        config: '[core]\n',
        rootCommitAt: null,
        bundles: [baseEntry],
      })
      bundleFetchBytes = ENTRY_INCR_BYTES
      manifestOutcome = { status: 'conflict', quarantineKey: 'conflict/p1/q-manifest.json', reason: 'lineage' }
      const restore = writer(pool, exportOf(incrEntry))
      try {
        const a = pool.add('p1', { repoParentEtag: '"m1"' })
        expect(await pool.saveRepoToStore(a)).toBe(false)
        expect(a.repoParentEtag).toBe('"m1"')
      } finally {
        restore()
      }
    })

    test('a manifest that exists is never bypassed for the tarball when the guest cannot export bundles', async () => {
      const pool = makePool(dir)
      prevManifest = parseRepoManifest({
        v: 1,
        head,
        refs: { 'refs/heads/main': oldTip },
        config: '',
        rootCommitAt: null,
        bundles: [baseEntry],
      })
      const restore = writer(pool, null)
      try {
        const a = pool.add('p1', { repoParentEtag: '"m1"' })
        await expect(pool.saveRepoToStore(a)).rejects.toThrow(/refusing the tarball fallback/)
        expect(manifestWrites).toHaveLength(0)
      } finally {
        restore()
      }
    })

    test('a bundle whose bytes differ from its export is never published', async () => {
      const pool = makePool(dir)
      bundleFetchBytes = new TextEncoder().encode('tampered')
      const restore = writer(pool, exportOf(baseEntry))
      try {
        const a = pool.add('p1', { repoParentEtag: undefined })
        await expect(pool.saveRepoToStore(a)).rejects.toThrow(/did not match its export/)
        expect(bundleUploads).toHaveLength(0)
        expect(manifestWrites).toHaveLength(0)
      } finally {
        restore()
      }
    })

    test('bundle support comes from the repo-hydrated probe and is cached per VM', async () => {
      let answer: unknown = { ok: true, supported: true, deadline: true, bundles: true }
      const probes: unknown[] = []
      const guest = Bun.serve({
        port: 0,
        fetch: async (req) => {
          probes.push(await req.json())
          return typeof answer === 'string' ? new Response(answer) : Response.json(answer)
        },
      })
      try {
        const pool = makePool(dir)
        const handle = { ...HANDLE, agentUrl: `http://127.0.0.1:${guest.port}` }
        const probe = (a: AssignedVm) => (MetalWarmPool.prototype as any).guestHasRepoBundles.call(pool, a)
        const capable = pool.add('p1', { handle })
        expect(await probe(capable)).toBe(true)
        expect(await probe(capable)).toBe(true)
        expect(probes).toEqual([{ probe: true }])

        answer = 'ok'
        const legacy = pool.add('p2', { handle })
        expect(await probe(legacy)).toBe(false)
      } finally {
        guest.stop(true)
      }
    })

    test('a guest without bundle support and no manifest keeps the tarball path', async () => {
      guestCapable = false
      const pool = makePool(dir)
      const restore = writer(pool, exportOf(baseEntry))
      try {
        const a = pool.add('p1', { repoParentEtag: undefined })
        expect(await pool.saveRepoToStore(a)).toBe(true)
        expect(exportCalls).toHaveLength(0)
        expect(manifestWrites).toHaveLength(0)
        expect(pool.uploads).toHaveLength(1)
      } finally {
        restore()
      }
    })

    test('a failed LFS push keeps a project with no manifest on the tarball', async () => {
      const pool = makePool(dir)
      const restore = writer(pool, new RepoBundleLfsPushError('lfs push failed'))
      try {
        const a = pool.add('p1', { repoParentEtag: undefined })
        expect(await pool.saveRepoToStore(a)).toBe(true)
        expect(exportCalls).toHaveLength(1)
        expect(manifestWrites).toHaveLength(0)
        expect(pool.uploads).toHaveLength(1)
      } finally {
        restore()
      }
    })

    test('a failed LFS push never sends a migrated project back to the tarball', async () => {
      const pool = makePool(dir)
      prevManifest = parseRepoManifest({
        v: 1,
        head,
        refs: { 'refs/heads/main': oldTip },
        config: '',
        rootCommitAt: null,
        bundles: [baseEntry],
      })
      const restore = writer(pool, new RepoBundleLfsPushError('lfs push failed'))
      try {
        const a = pool.add('p1', { repoParentEtag: '"m1"' })
        await expect(pool.saveRepoToStore(a)).rejects.toThrow(RepoBundleLfsPushError)
        expect(manifestWrites).toHaveLength(0)
        expect(pool.uploads).toHaveLength(0)
      } finally {
        restore()
      }
    })

    test('the guest LFS refusal is told apart from other export failures', async () => {
      let answer = Response.json({ error: 'lfs push failed; repo bundle not exported' }, { status: 503 })
      const guest = Bun.serve({ port: 0, fetch: () => answer.clone() })
      try {
        const pool = makePool(dir)
        const a = pool.add('p1', { handle: { ...HANDLE, agentUrl: `http://127.0.0.1:${guest.port}` } })
        const exportBundle = () => (MetalWarmPool.prototype as any).exportRepoBundle.call(pool, a, null)
        await expect(exportBundle()).rejects.toThrow(RepoBundleLfsPushError)

        answer = Response.json({ error: 'push failed', code: 'lfs-push-failed' }, { status: 503 })
        await expect(exportBundle()).rejects.toThrow(RepoBundleLfsPushError)

        answer = Response.json({ error: 'git bundle create failed' }, { status: 503 })
        const other = await exportBundle().catch((err: unknown) => err)
        expect(other).toBeInstanceOf(Error)
        expect(other).not.toBeInstanceOf(RepoBundleLfsPushError)
      } finally {
        guest.stop(true)
      }
    })
  })

  describe('workspace runtime assign', () => {
    function assignWorkspace(repoRef: object | null, onGuest?: (path: string) => Promise<void>) {
      const seen: string[] = []
      const guest = Bun.serve({
        port: 0,
        fetch: async (req) => {
          const path = new URL(req.url).pathname
          seen.push(path)
          await onGuest?.(path)
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

    test('a hydrated merged-root repo lets the workspace push its durable snapshot', async () => {
      const { run } = assignWorkspace({ url: 'https://store/ws/repo.git.tar.gz', bytes: 10, etag: '"ws-r1"' })
      const a = await run
      expect(a.workspaceOrigin).toBe('backup')
    })

    test('stays template-origin when the repo hydrate fails', async () => {
      const { pool, run } = assignWorkspace({ url: 'https://store/ws/repo.git.tar.gz', bytes: 10, etag: '"ws-r1"' })
      ;(pool as any).hydrateRepo = async () => {
        throw new Error('The operation timed out.')
      }
      const a = await run
      expect(a.repoUntrustedReason).toBeDefined()
      expect(a.workspaceOrigin).toBe('template')
    })

    test('members restored from backup make it backup-origin even when the repo hydrate fails', async () => {
      const { pool, run } = assignWorkspace({ url: 'https://store/ws/repo.git.tar.gz', bytes: 10, etag: '"ws-r1"' })
      ;(pool as any).sourceRef = async () => ({ url: 'https://store/p1/project-src.tar.gz', bytes: 10, etag: '"p1-src"' })
      ;(pool as any).hydrateRepo = async () => {
        throw new Error('/pool/repo-hydrated failed (500)')
      }
      const a = await run
      expect(a.repoUntrustedReason).toBeDefined()
      expect(a.workspaceOrigin).toBe('backup')
    })

    test('stays create-only when no durable repo exists yet', async () => {
      const { pool, seen, run } = assignWorkspace(null)
      const a = await run
      expect(seen).not.toContain('/pool/repo-hydrated')
      expect(a.repoParentEtag).toBeUndefined()
      expect(a.workspaceOrigin).toBe('template')

      await pool.saveRepoToStore(a)
      expect(pool.uploads[0].opts.lineage).toEqual({ kind: 'create-only' })
    })

    test('does not export the seed .git while the repo hydrate is still running', async () => {
      const results: boolean[] = []
      const { pool, run } = assignWorkspace(
        { url: 'https://store/ws/repo.git.tar.gz', bytes: 10, etag: '"ws-r1"' },
        async (path) => {
          if (path !== '/pool/hydrate-url') return
          const live = (pool as any).assigned.get('ws:proj:p1') as AssignedVm
          results.push(await pool.saveRepoToStore(live))
        },
      )
      const a = await run
      expect(results).toEqual([false])
      expect(pool.uploads).toHaveLength(0)
      expect(a.repoHydratePending).toBe(false)
      expect(a.repoHeadSha).toBeUndefined()
    })

    test('a VM that found no durable repo at assign never supersedes one written later', async () => {
      const { pool, run } = assignWorkspace(null)
      const a = await run
      expect(a.repoLinked).toBe(true)
      pool.outcomes = [{ status: 'conflict', quarantineKey: 'conflict/p1/q.tar.gz', reason: 'raced-create' }]
      pool.durable = { etag: '"other-writer"', lastModified: 1_000 }

      expect(await pool.saveRepoToStore(a)).toBe(false)
      expect(pool.statCalls).toBe(0)
      expect(pool.preserved).toHaveLength(0)
    })
  })

  test('a save while the assign-time repo hydrate is pending is skipped', async () => {
    const pool = makePool(dir)
    const a = pool.add('ws:proj:p1', { repoHydratePending: true })
    expect(await pool.saveRepoToStore(a)).toBe(false)
    expect(pool.uploads).toHaveLength(0)
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
