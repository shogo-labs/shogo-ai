// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * End-to-end: a cold boot must never rewind a project to a stale durable repo.
 *
 * 2026-09-28: a workspace's `repo.git.tar.gz` stopped advancing (its exports
 * were refused) while its source backups kept up with the user. On the next
 * cold boots the guest's repo adopt reset the hydrated tree to that stale
 * HEAD — once after the host had already given up waiting — and the next
 * source backup saved the rewound tree over the user's work.
 *
 * Everything here is real except the VM: the pool, Bun's S3 client and the
 * SigV4 writer against an object store that enforces preconditions and serves
 * `Last-Modified`, `tar` in both directions, and git with the guest's own
 * adopt (`adoptHydratedRepoBefore`). The fake guest only routes HTTP to them.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AdoptDeadlineError,
  adoptHydratedRepo,
  adoptHydratedRepoBefore,
  packRepoArchive,
  seedRepoIfAbsent,
} from '../../../packages/shared-runtime/src/repo-store'
import { config, type MetalConfig } from './config'
import type { FcVmHandle } from './firecracker-vm-manager'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { SnapshotStore } from './snapshot-store'

const BUCKET = 'test-workspaces'
const NOOP = { log: () => {}, warn: () => {}, error: () => {} }
const HOUR = 3_600_000

/** Path-style S3 with ETag / Last-Modified and atomic If-Match / If-None-Match. */
class FakeS3 {
  readonly objects = new Map<string, { body: Uint8Array; etag: string; lastModified: number }>()
  private seq = 0
  private server = Bun.serve({ port: 0, fetch: (req) => this.handle(req) })

  get endpoint(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  stop(): void {
    this.server.stop(true)
  }

  put(key: string, body: Uint8Array, lastModified = Date.now()): string {
    const etag = `"etag-${++this.seq}"`
    this.objects.set(key, { body, etag, lastModified })
    return etag
  }

  body(key: string): Uint8Array | undefined {
    return this.objects.get(key)?.body
  }

  keys(prefix: string): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix))
  }

  private async handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    const prefix = `/${BUCKET}/`
    if (!path.startsWith(prefix)) return new Response('no such bucket', { status: 404 })
    const key = decodeURIComponent(path.slice(prefix.length))
    const existing = this.objects.get(key)
    if (req.method === 'HEAD' || req.method === 'GET') {
      if (!existing) return new Response(null, { status: 404 })
      return new Response(req.method === 'HEAD' ? null : existing.body, {
        status: 200,
        headers: {
          etag: existing.etag,
          'content-length': String(existing.body.byteLength),
          'last-modified': new Date(existing.lastModified).toUTCString(),
        },
      })
    }
    if (req.method === 'PUT') {
      const ifMatch = req.headers.get('if-match')
      const ifNoneMatch = req.headers.get('if-none-match')
      if (ifNoneMatch === '*' && existing) return new Response(null, { status: 412 })
      if (ifMatch && (!existing || existing.etag !== ifMatch)) return new Response(null, { status: 412 })
      const etag = this.put(key, new Uint8Array(await req.arrayBuffer()))
      return new Response(null, { status: 200, headers: { etag } })
    }
    return new Response(null, { status: 405 })
  }
}

type GuestKind =
  /** This change: honours `timeoutMs` and `keepPaths`, advertises `deadline`. */
  | 'current'
  /** The guest the incident ran: full reset whenever the git layer is ready, however late. */
  | 'legacy'

/**
 * The guest's side of the host contract, over a real workspace directory.
 * `gitReady` stands in for the guest's git layer finishing its startup.
 */
class FakeGuest {
  readonly ws = mkdtempSync(join(tmpdir(), 'rewind-guest-'))
  readonly adopts: Array<Promise<unknown>> = []
  private server: ReturnType<typeof Bun.serve>
  private settleGit!: () => void
  readonly gitReady = new Promise<void>((r) => { this.settleGit = r })

  constructor(
    readonly kind: GuestKind,
    template: Record<string, string>,
    opts: { gitReady?: boolean } = {},
  ) {
    for (const [rel, body] of Object.entries(template)) write(this.ws, rel, body)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: this.ws })
    gitCommitAll(this.ws, 'template seed')
    if (opts.gitReady !== false) this.settleGit()
    this.server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (req) => this.handle(req) })
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  releaseGitLayer(): void {
    this.settleGit()
  }

  read(rel: string): string {
    return readFileSync(join(this.ws, rel), 'utf-8')
  }

  head(): string {
    return git(this.ws, 'rev-parse', 'HEAD')
  }

  stop(): void {
    this.server.stop(true)
    rmSync(this.ws, { recursive: true, force: true })
  }

  /** Guest paths as the host sends them: absolute `/app/workspace/...` or workspace-relative. */
  private resolve(dir?: string): string {
    if (!dir) return this.ws
    if (dir.startsWith('/app/workspace')) return join(this.ws, dir.slice('/app/workspace'.length))
    return join(this.ws, dir)
  }

  private async handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    const body: any = await req.json().catch(() => ({}))
    switch (path) {
      case '/pool/hydrate-url': {
        const res = await fetch(body.url)
        if (!res.ok) return new Response(`pull failed ${res.status}`, { status: 502 })
        const dest = this.resolve(body.destDir)
        mkdirSync(dest, { recursive: true })
        const archive = join(tmpdir(), `rewind-pull-${Date.now()}-${Math.random().toString(36).slice(2)}.tgz`)
        writeFileSync(archive, new Uint8Array(await res.arrayBuffer()))
        execFileSync('tar', ['-xzf', archive, '-C', dest])
        rmSync(archive, { force: true })
        return Response.json({ ok: true })
      }
      case '/pool/repo-hydrated':
        return this.repoHydrated(body)
      case '/pool/export': {
        const src = this.resolve(body.dir)
        const out = execFileSync('tar', ['-czf', '-', '--exclude=./.git', '--exclude=./.shogo', '-C', src, '.'])
        return new Response(new Uint8Array(out), { status: 200 })
      }
      case '/pool/export-repo': {
        const out = join(tmpdir(), `rewind-repo-${Date.now()}-${Math.random().toString(36).slice(2)}.tgz`)
        await packRepoArchive(this.ws, out)
        const bytes = new Uint8Array(readFileSync(out))
        rmSync(out, { force: true })
        return new Response(bytes, { status: 200 })
      }
      case '/pool/export-data':
        return new Response(null, { status: 204 })
      default:
        return Response.json({ ok: true })
    }
  }

  private async repoHydrated(body: any): Promise<Response> {
    if (body.probe === true) {
      return Response.json(this.kind === 'current' ? { ok: true, supported: true, deadline: true } : { ok: true, supported: true })
    }
    const staging = join(this.ws, body.stagingDir)
    if (this.kind === 'legacy') {
      const adopt = this.gitReady.then(() => adoptHydratedRepo(this.ws, staging, { logger: NOOP }))
      this.adopts.push(adopt.catch(() => {}))
      return Response.json({ ok: true, ...(await adopt) })
    }
    const timeoutMs = Number(body.timeoutMs)
    const adopt = adoptHydratedRepoBefore(this.ws, staging, {
      deadline: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : null,
      ready: this.gitReady,
      keepPaths: body.keepPaths,
      logger: NOOP,
    })
    this.adopts.push(adopt.catch(() => {}))
    try {
      return Response.json({ ok: true, ...(await adopt) })
    } catch (err: any) {
      if (err instanceof AdoptDeadlineError) return Response.json({ error: err.message, adopted: false }, { status: 504 })
      return Response.json({ error: err?.message ?? String(err) }, { status: 500 })
    }
  }
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' },
  }).trim()
}

function gitCommitAll(dir: string, message: string): void {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '--allow-empty', '-m', message)
}

function write(dir: string, rel: string, body: string): void {
  mkdirSync(join(dir, rel, '..'), { recursive: true })
  writeFileSync(join(dir, rel), body)
}

function tarOf(files: Record<string, string>): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-src-'))
  try {
    for (const [rel, body] of Object.entries(files)) write(dir, rel, body)
    return new Uint8Array(execFileSync('tar', ['-czf', '-', '-C', dir, '.']))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Files inside a source archive, as the durable store holds it. */
function untar(bytes: Uint8Array): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-untar-'))
  try {
    const archive = join(dir, 'a.tgz')
    writeFileSync(archive, bytes)
    const out = join(dir, 'out')
    mkdirSync(out)
    execFileSync('tar', ['-xzf', archive, '-C', out])
    const files = execFileSync('find', ['.', '-type', 'f'], { cwd: out, encoding: 'utf-8' })
      .split('\n')
      .filter(Boolean)
      .map((f) => f.replace(/^\.\//, ''))
    return Object.fromEntries(files.map((f) => [f, readFileSync(join(out, f), 'utf-8')]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A durable repo whose HEAD holds `files`. */
async function repoArchiveOf(files: Record<string, string>): Promise<{ bytes: Uint8Array; sha: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-repo-'))
  try {
    for (const [rel, body] of Object.entries(files)) write(dir, rel, body)
    await seedRepoIfAbsent(dir, { logger: NOOP })
    const out = join(dir, '..', `${Date.now()}-${Math.random().toString(36).slice(2)}-repo.tgz`)
    await packRepoArchive(dir, out)
    const bytes = new Uint8Array(readFileSync(out))
    rmSync(out, { force: true })
    return { bytes, sha: git(dir, 'rev-parse', 'HEAD') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

let s3: FakeS3
const cleanups: Array<() => void> = []
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'S3_WORKSPACES_BUCKET']) savedEnv[k] = process.env[k]
  process.env.AWS_ACCESS_KEY_ID = 'test-key'
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'
  process.env.S3_WORKSPACES_BUCKET = BUCKET
})

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

class TestPool extends MetalWarmPool {
  setSlack(ms: number): void {
    this.repoHydratedSlackMs = ms
  }

  /** The source backup every suspend (and the periodic sweep) takes. */
  backup(projectId: string): Promise<string> {
    const self = this as any
    return self.saveBackupToStore(self.assigned.get(projectId))
  }
}

function makePool(guest: FakeGuest, opts: { hydrateTimeoutMs?: number; slackMs?: number; keepStore?: boolean } = {}): TestPool {
  if (!opts.keepStore) {
    s3 = new FakeS3()
    const store = s3
    cleanups.push(() => store.stop())
  }
  const dir = mkdtempSync(join(tmpdir(), 'rewind-host-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    poolSize: 0,
    snapStore: 'none',
    s3Endpoint: s3.endpoint,
    s3Region: 'us-east-1',
    hydrateTimeoutMs: opts.hydrateTimeoutMs ?? 10_000,
  } as MetalConfig
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const handle = {
    id: 'vm-1',
    agentUrl: guest.url,
    guestIp: '127.0.0.1',
    net: { tap: 'fctap1', guestIp: '127.0.0.1' },
    pid: 4242,
    platform: 'linux',
    rootfs: join(dir, 'rootfs'),
    socketPath: join(dir, 'fc.sock'),
    serialLog: join(dir, 'serial'),
    vcpus: 2,
    memoryMB: 1024,
    vmClass: 'standard',
  } as unknown as FcVmHandle
  const mgr = {
    startVM: async () => handle,
    restoreVM: async () => handle,
    stopVM: async () => {},
    isRunning: () => true,
    procCount: () => 0,
    reapHostOrphans: () => 0,
    snapshotVM: async (h: FcVmHandle) => ({
      vmId: h.id,
      snapshotPath: join(dir, 'x.vmstate'),
      memFilePath: join(dir, 'x.mem'),
      net: h.net,
      rootfs: h.rootfs,
      vcpus: h.vcpus,
      memoryMB: h.memoryMB,
      createdAt: Date.now(),
      bytesMem: 0,
      bytesState: 0,
      bytesRootfs: 0,
      vmClass: h.vmClass,
    }),
    durableRootfs: () => ({ path: join(dir, 'x.rootfs'), mode: 'full' }),
    restoreRootfsArtifactPath: (p: string) => p,
  }
  const pool = new TestPool(mgr as any, cfg, { kind: 'none' } as unknown as SnapshotStore)
  if (opts.slackMs !== undefined) pool.setSlack(opts.slackMs)
  return pool
}

function newGuest(kind: GuestKind, opts: { gitReady?: boolean } = {}): FakeGuest {
  const guest = new FakeGuest(kind, { 'src/App.tsx': 'Project Ready (template)\n' }, opts)
  cleanups.push(() => guest.stop())
  return guest
}

const ENV = { RUNTIME_AUTH_SECRET: 'tok' }
const T0 = Date.now() - 48 * HOUR

describe('a cold boot never rewinds newer source to a stale durable repo', () => {
  /** The incident's durable state: the repo stopped at v1, the source backup carried on to v2. */
  async function seedStaleRepo(projectId: string) {
    const repo = await repoArchiveOf({ 'src/App.tsx': 'v1\n' })
    s3.put(`${projectId}/repo.git.tar.gz`, repo.bytes, T0)
    const srcEtag = s3.put(
      `${projectId}/project-src.tar.gz`,
      tarOf({ 'src/App.tsx': 'v2 — a day of the user’s work\n', 'src/Login.tsx': 'login\n' }),
      T0 + 24 * HOUR,
    )
    return { repoSha: repo.sha, srcEtag }
  }

  test('this guest keeps the newer tree on top of the durable history, and the next backup descends from it', async () => {
    const guest = newGuest('current')
    const pool = makePool(guest)
    const { repoSha, srcEtag } = await seedStaleRepo('p1')

    const a = await pool.assign('p1', ENV)

    expect(guest.read('src/App.tsx')).toBe('v2 — a day of the user’s work\n')
    expect(git(guest.ws, 'rev-parse', 'HEAD^')).toBe(repoSha)
    expect(git(guest.ws, 'show', 'HEAD:src/App.tsx')).toBe('v2 — a day of the user’s work')
    expect(a.repoParentEtag).toBeDefined()
    expect(a.repoUntrustedReason).toBeUndefined()
    expect(a.sourceUntrustedReason).toBeUndefined()
    expect(a.backupParentEtag).toBe(srcEtag)

    expect(await pool.backup('p1')).toBe('written')
    expect(untar(s3.body('p1/project-src.tar.gz')!)['src/App.tsx']).toBe('v2 — a day of the user’s work\n')
  })

  test('the kept tree reaches the durable repo, so the next cold boot (repo now newest) lands on it too', async () => {
    const first = newGuest('current')
    const pool1 = makePool(first)
    await seedStaleRepo('p1')
    const a = await pool1.assign('p1', ENV)
    expect(await pool1.saveRepoToStore(a)).toBe(true)

    // A later boot elsewhere: the repo was just written, so it is the newer side.
    const second = newGuest('current')
    const pool2 = makePool(second, { keepStore: true })
    await pool2.assign('p1', ENV)
    expect(second.read('src/App.tsx')).toBe('v2 — a day of the user’s work\n')
    expect(second.read('src/Login.tsx')).toBe('login\n')
  })

  test('the incident guest is never asked to adopt a stale repo: the tree stays, only the repo is distrusted', async () => {
    const guest = newGuest('legacy')
    const pool = makePool(guest)
    await seedStaleRepo('p1')
    const seed = guest.head()

    const a = await pool.assign('p1', ENV)

    expect(guest.read('src/App.tsx')).toBe('v2 — a day of the user’s work\n')
    expect(guest.head()).toBe(seed)
    expect(existsSync(join(guest.ws, '.shogo/local/repo-staging'))).toBe(false)
    expect(a.repoUntrustedReason).toMatch(/older than the source/)
    expect(a.sourceUntrustedReason).toBeUndefined()
  })

  test('a repo newer than the source still resets the tree to its HEAD', async () => {
    const guest = newGuest('current')
    const pool = makePool(guest)
    const repo = await repoArchiveOf({ 'src/App.tsx': 'v3 (committed after the last source backup)\n' })
    s3.put('p1/project-src.tar.gz', tarOf({ 'src/App.tsx': 'v2\n' }), T0)
    s3.put('p1/repo.git.tar.gz', repo.bytes, T0 + HOUR)

    await pool.assign('p1', ENV)

    expect(guest.head()).toBe(repo.sha)
    expect(guest.read('src/App.tsx')).toBe('v3 (committed after the last source backup)\n')
  })
})

describe('the host deadline on the repo adopt', () => {
  async function seedNewerRepo(projectId: string) {
    const repo = await repoArchiveOf({ 'src/App.tsx': 'repo HEAD\n' })
    s3.put(`${projectId}/project-src.tar.gz`, tarOf({ 'src/App.tsx': 'hydrated source\n' }), T0)
    s3.put(`${projectId}/repo.git.tar.gz`, repo.bytes, T0 + HOUR)
  }

  test('a git layer still busy at the deadline gets a decline, and the tree is not touched when it frees up', async () => {
    const guest = newGuest('current', { gitReady: false })
    const pool = makePool(guest, { hydrateTimeoutMs: 300 })
    await seedNewerRepo('p1')
    const seed = guest.head()

    const a = await pool.assign('p1', ENV)
    expect(a.repoUntrustedReason).toMatch(/504/)
    expect(a.sourceUntrustedReason).toBeUndefined()

    guest.releaseGitLayer()
    await Promise.all(guest.adopts)
    expect(guest.head()).toBe(seed)
    expect(guest.read('src/App.tsx')).toBe('hydrated source\n')

    // Its tree is exactly what the host hydrated, so it may still back it up.
    expect(await pool.backup('p1')).toBe('written')
  })

  test('a guest that resets after the host stopped waiting can never overwrite the backup (the incident)', async () => {
    const guest = newGuest('legacy', { gitReady: false })
    const pool = makePool(guest, { hydrateTimeoutMs: 200, slackMs: 100 })
    await seedNewerRepo('p1')
    const backup = s3.body('p1/project-src.tar.gz')

    const a = await pool.assign('p1', ENV)
    expect(a.repoUntrustedReason).toMatch(/did not answer/)
    expect(a.sourceUntrustedReason).toMatch(/did not answer/)

    // The guest resets behind the host's back: the tree the host hydrated is gone.
    guest.releaseGitLayer()
    await Promise.all(guest.adopts)
    expect(guest.read('src/App.tsx')).toBe('repo HEAD\n')

    expect(await pool.backup('p1')).toBe('quarantined')
    expect(s3.body('p1/project-src.tar.gz')).toEqual(backup!)
    expect(s3.keys('conflict/p1/')).toHaveLength(1)
  })

  test('an untrusted tree is never kept as a snapshot, so it cannot come back by resume', async () => {
    const guest = newGuest('legacy', { gitReady: false })
    const pool = makePool(guest, { hydrateTimeoutMs: 200, slackMs: 100 })
    await seedNewerRepo('p1')
    const backup = s3.body('p1/project-src.tar.gz')

    await pool.assign('p1', ENV)
    guest.releaseGitLayer()
    await Promise.all(guest.adopts)

    await pool.suspend('p1')
    expect(await pool.canResume('p1')).toBe(false)
    expect(s3.body('p1/project-src.tar.gz')).toEqual(backup!)
  })
})

describe('workspace runtimes', () => {
  const ANCHOR = 'ws:proj:m1'
  const WS_ENV = { ...ENV, WORKSPACE_PROJECT_IDS: 'm1,m2' }

  async function seedWorkspace() {
    const repo = await repoArchiveOf({ 'm1/App.tsx': 'm1 v1\n', 'm2/App.tsx': 'm2 v3\n' })
    s3.put(`${ANCHOR}/repo.git.tar.gz`, repo.bytes, T0 + HOUR)
    const m1Etag = s3.put('m1/project-src.tar.gz', tarOf({ 'App.tsx': 'm1 v2 (newer than the repo)\n' }), T0 + 2 * HOUR)
    const m2Etag = s3.put('m2/project-src.tar.gz', tarOf({ 'App.tsx': 'm2 v2\n' }), T0)
    return { repo, m1Etag, m2Etag }
  }

  test('only members whose source is newer than the merged repo keep their tree', async () => {
    const guest = newGuest('current')
    const pool = makePool(guest)
    const { repo, m1Etag, m2Etag } = await seedWorkspace()

    const a = await pool.assign(ANCHOR, WS_ENV)

    expect(git(guest.ws, 'rev-parse', 'HEAD^')).toBe(repo.sha)
    expect(guest.read('m1/App.tsx')).toBe('m1 v2 (newer than the repo)\n')
    expect(guest.read('m2/App.tsx')).toBe('m2 v3\n')
    expect(a.memberData?.m1).toMatchObject({ sourceParentEtag: m1Etag, sourceLinked: true })
    expect(a.memberData?.m2).toMatchObject({ sourceParentEtag: m2Etag, sourceLinked: true })
  })

  test('a member backup another writer moved on is quarantined, not overwritten', async () => {
    const guest = newGuest('current')
    const pool = makePool(guest)
    await seedWorkspace()
    const a = await pool.assign(ANCHOR, WS_ENV)

    // Another host (or region) holding m2 saves real work meanwhile.
    s3.put('m2/project-src.tar.gz', tarOf({ 'App.tsx': 'm2 v4 from the other writer\n' }))

    const failed = await (pool as any).saveWorkspaceMembersToStore(a as AssignedVm)
    expect(failed.map((f: { projectId: string }) => f.projectId)).toEqual(['m2'])
    expect(untar(s3.body('m1/project-src.tar.gz')!)['App.tsx']).toBe('m1 v2 (newer than the repo)\n')
    expect(untar(s3.body('m2/project-src.tar.gz')!)['App.tsx']).toBe('m2 v4 from the other writer\n')
    expect(s3.keys('conflict/m2/')).toHaveLength(1)

    // m1's lineage moved to its own write, so the next save still descends.
    expect(await (pool as any).saveWorkspaceMembersToStore(a)).toEqual([{ projectId: 'm2', reason: 'not promoted (conflict)' }])
    expect(s3.keys('conflict/m1/')).toHaveLength(0)
  })

  test("suspend and resume carry each member's source lineage", async () => {
    const guest = newGuest('current')
    const pool = makePool(guest)
    await seedWorkspace()
    const a = await pool.assign(ANCHOR, WS_ENV)
    await (pool as any).saveWorkspaceMembersToStore(a)

    await pool.suspend(ANCHOR)
    const m1 = s3.objects.get('m1/project-src.tar.gz')!.etag
    const r = await pool.resume(ANCHOR, WS_ENV)
    expect(r?.source).toBe('local')
    const resumed = (pool as any).assigned.get(ANCHOR) as AssignedVm
    expect(resumed.memberData?.m1).toMatchObject({ sourceParentEtag: m1, sourceLinked: true })

    expect(await (pool as any).saveWorkspaceMembersToStore(resumed)).toEqual([])
    expect(s3.keys('conflict/')).toHaveLength(0)
  })

  test('a snapshot is not resumed once a member backup has moved past it', async () => {
    const guest = newGuest('current')
    const pool = makePool(guest)
    await seedWorkspace()
    const a = await pool.assign(ANCHOR, WS_ENV)
    await (pool as any).saveWorkspaceMembersToStore(a)
    await pool.suspend(ANCHOR)

    s3.put('m2/project-src.tar.gz', tarOf({ 'App.tsx': 'm2 v4 from the other writer\n' }))

    expect(await pool.resume(ANCHOR, WS_ENV)).toBeNull()
  })

  test('an uncertain adopt distrusts every member, and none of them is overwritten', async () => {
    const guest = newGuest('legacy', { gitReady: false })
    const pool = makePool(guest, { hydrateTimeoutMs: 200, slackMs: 100 })
    const repo = await repoArchiveOf({ 'm1/App.tsx': 'm1 repo\n', 'm2/App.tsx': 'm2 repo\n' })
    s3.put(`${ANCHOR}/repo.git.tar.gz`, repo.bytes, T0 + HOUR)
    s3.put('m1/project-src.tar.gz', tarOf({ 'App.tsx': 'm1 src\n' }), T0)
    s3.put('m2/project-src.tar.gz', tarOf({ 'App.tsx': 'm2 src\n' }), T0)

    const a = await pool.assign(ANCHOR, WS_ENV)
    guest.releaseGitLayer()
    await Promise.all(guest.adopts)
    expect(guest.read('m1/App.tsx')).toBe('m1 repo\n')

    expect(a.memberData?.m1?.sourceUntrustedReason).toMatch(/did not answer/)
    expect(a.memberData?.m2?.sourceUntrustedReason).toMatch(/did not answer/)
    await (pool as any).saveWorkspaceMembersToStore(a)
    expect(untar(s3.body('m1/project-src.tar.gz')!)['App.tsx']).toBe('m1 src\n')
    expect(untar(s3.body('m2/project-src.tar.gz')!)['App.tsx']).toBe('m2 src\n')
  })
})
