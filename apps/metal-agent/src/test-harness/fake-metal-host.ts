// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Fake metal host for driving the real `MetalWarmPool` without Firecracker.
 *
 *   - `FakeS3`: path-style object store with ETag / Last-Modified and atomic
 *     If-Match / If-None-Match, so Bun's S3 client and the lineage guards in
 *     workspace-archive.ts / repo-archive.ts run unmodified.
 *   - `FakeGuest`: the guest agent's HTTP contract over a real workspace
 *     directory (tar in both directions, git with the guest's own adopt).
 *   - `FakeHost`: a `FirecrackerVMManager` stand-in that boots one FakeGuest
 *     per VM, snapshots by copying the workspace, restores from that copy, and
 *     can crash a VM (process gone, workspace left on "disk").
 *
 * Everything the pool decides — hydrate, lineage, suspend/resume, reaping —
 * is the production code path; only the VM and the object store are fake.
 */

import { execFileSync } from 'child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AdoptDeadlineError,
  adoptHydratedRepo,
  adoptHydratedRepoBefore,
  packRepoArchive,
  seedRepoIfAbsent,
} from '../../../../packages/shared-runtime/src/repo-store'
import {
  buildRepoBundle,
  materializeRepoFromBundles,
  parseRepoManifest,
  readRepoSnapshotFields,
  REPO_MANIFEST_VERSION,
  type RepoManifest,
} from '../../../../packages/shared-runtime/src/repo-bundles'
import { handleExportHome, handleHydrateHome } from '../../../../packages/agent-runtime/src/home-state-routes'
import { RepoAdoptGate, isWorkspaceNeutralRequest } from '../../../../packages/agent-runtime/src/repo-adopt-gate'
import { config, type MetalConfig } from '../config'
import type { FcSnapshot, FcVmHandle } from '../firecracker-vm-manager'

export const BUCKET = 'test-workspaces'
const NOOP = { log: () => {}, warn: () => {}, error: () => {} }

/** Path-style S3 with ETag / Last-Modified and atomic If-Match / If-None-Match. */
export class FakeS3 {
  readonly objects = new Map<string, { body: Uint8Array; etag: string; lastModified: number }>()
  /** Every successful PUT, in order. */
  readonly writes: string[] = []
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

  /**
   * Make GETs of matching keys misbehave, as object storage did on 2026-10-25
   * (a git history download that hung for two minutes). HEAD is never
   * affected, so the pool still sees the object exists.
   *
   *   - `hang`: the response never starts until `release()` (then served normally).
   *   - `fail`: waits `afterMs`, then answers 500.
   *   - `delay`: waits `afterMs`, then serves normally.
   *
   * Returns `release`, which also lifts the fault for later requests.
   */
  stall(match: (key: string) => boolean, mode: { kind: 'hang' } | { kind: 'fail' | 'delay'; afterMs: number } = { kind: 'hang' }): () => void {
    let release!: () => void
    const released = new Promise<void>((r) => { release = r })
    const fault: StorageFault = { match, mode, released, hits: 0 }
    this.faults.push(fault)
    return () => {
      this.faults = this.faults.filter((f) => f !== fault)
      release()
    }
  }

  /** How many GETs a fault has caught so far. */
  stalledGets(match?: (key: string) => boolean): number {
    return this.faultLog.filter((k) => !match || match(k)).length
  }

  private faults: StorageFault[] = []
  private faultLog: string[] = []

  private async applyFault(key: string): Promise<Response | null> {
    const fault = this.faults.find((f) => f.match(key))
    if (!fault) return null
    fault.hits++
    this.faultLog.push(key)
    if (fault.mode.kind === 'hang') {
      await fault.released
      return null
    }
    const { afterMs } = fault.mode
    await Promise.race([Bun.sleep(afterMs), fault.released])
    return fault.mode.kind === 'fail' ? new Response('storage unavailable', { status: 500 }) : null
  }

  private async handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    const prefix = `/${BUCKET}/`
    if (!path.startsWith(prefix)) return new Response('no such bucket', { status: 404 })
    const key = decodeURIComponent(path.slice(prefix.length))
    if (req.method === 'GET') {
      const faulted = await this.applyFault(key)
      if (faulted) return faulted
    }
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
      this.writes.push(key)
      return new Response(null, { status: 200, headers: { etag } })
    }
    if (req.method === 'DELETE') {
      this.objects.delete(key)
      return new Response(null, { status: 204 })
    }
    return new Response(null, { status: 405 })
  }
}

interface StorageFault {
  match: (key: string) => boolean
  mode: { kind: 'hang' } | { kind: 'fail' | 'delay'; afterMs: number }
  released: Promise<void>
  hits: number
}

export type GuestKind =
  /**
   * Today's guest (agent-runtime after 2026-10-27): everything `current`
   * does, plus incremental repo bundles and `ifIdle`, so the host may serve
   * the source's `.git` and swap the history in later. The late swap goes
   * through the real `RepoAdoptGate`, exactly as agent-runtime wires it.
   */
  | 'deferring'
  /** Honours `timeoutMs` and `keepPaths`, advertises `deadline`. */
  | 'current'
  /** The 2026-09-28 incident guest: full reset whenever the git layer is ready, however late. */
  | 'legacy'

/**
 * The guest's side of the host contract, over a real workspace directory.
 * `gitReady` stands in for the guest's git layer finishing its startup.
 */
export class FakeGuest {
  readonly ws: string
  /** The guest's HOME (`/app` in a real VM), kept beside the workspace so snapshots carry it. */
  readonly home: string
  /** Env from the last `/pool/assign` or `/pool/refresh-env`; feeds the real home-state handlers. */
  env: Record<string, string> = {}
  readonly adopts: Array<Promise<unknown>> = []
  /** The agent-runtime's gate for late `.git` swaps (`deferring` guests only). */
  readonly adoptGate = new RepoAdoptGate()
  /** Every `/pool/repo-hydrated` adopt answer, in order: 200, 409 (busy), 504, 500. */
  readonly adoptStatuses: number[] = []
  alive = true
  private server: ReturnType<typeof Bun.serve>
  private settleGit!: () => void
  readonly gitReady = new Promise<void>((r) => { this.settleGit = r })

  /**
   * The real guest commits pending edits before packing `.git`
   * (`flushGitBeforeExport`), except mid-turn or when the git layer misses the
   * flush timeout. Set false to model those exports.
   */
  flushBeforeExport = true

  constructor(
    readonly kind: GuestKind,
    init: { template: Record<string, string> } | { fromDir: string },
    opts: { gitReady?: boolean } = {},
  ) {
    this.ws = mkdtempSync(join(tmpdir(), 'fake-guest-'))
    this.home = homeOf(this.ws)
    mkdirSync(this.home, { recursive: true })
    if ('fromDir' in init) {
      cpSync(init.fromDir, this.ws, { recursive: true })
      if (existsSync(homeOf(init.fromDir))) cpSync(homeOf(init.fromDir), this.home, { recursive: true })
    } else {
      for (const [rel, body] of Object.entries(init.template)) writeRel(this.ws, rel, body)
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: this.ws })
      gitCommitAll(this.ws, 'template seed')
    }
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

  /** A user edit the agent committed, as a chat turn would. */
  edit(rel: string, body: string): void {
    writeRel(this.ws, rel, body)
    gitCommitAll(this.ws, `edit ${rel}`)
  }

  head(): string {
    return git(this.ws, 'rev-parse', 'HEAD')
  }

  /**
   * A chat turn that writes `rel`, sent over HTTP like the IDE's, so it passes
   * through the same request middleware as agent-runtime (it marks the
   * workspace in use, and waits out a late `.git` swap in progress).
   */
  async use(rel: string, body: string): Promise<void> {
    const res = await fetch(`${this.url}/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rel, body }),
    })
    if (!res.ok) throw new Error(`/agent/chat failed (${res.status})`)
  }

  /** Whether `sha` is in this workspace's history. */
  hasCommit(sha: string): boolean {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: this.ws, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }

  /** The Firecracker process died; the workspace stays on the rootfs. */
  crash(): void {
    this.alive = false
    this.server.stop(true)
  }

  stop(): void {
    if (this.alive) this.server.stop(true)
    this.alive = false
    if (this.bundleSpoolDir) rmSync(this.bundleSpoolDir, { recursive: true, force: true })
    rmSync(this.ws, { recursive: true, force: true })
    rmSync(this.home, { recursive: true, force: true })
  }

  /** Something the agent left in its home directory (`~/<rel>`). */
  writeHome(rel: string, body: string, mode = 0o644): void {
    writeRel(this.home, rel, body)
    chmodSync(join(this.home, rel), mode)
  }

  readHome(rel: string): string | null {
    const p = join(this.home, rel)
    return existsSync(p) ? readFileSync(p, 'utf-8') : null
  }

  private homeEnv(): NodeJS.ProcessEnv {
    return { ...this.env, SHOGO_HOME_STATE_DIR: this.home }
  }

  /** Guest paths as the host sends them: absolute `/app/workspace/...` or workspace-relative. */
  private resolve(dir?: string): string {
    if (!dir) return this.ws
    if (dir.startsWith('/app/workspace')) return join(this.ws, dir.slice('/app/workspace'.length))
    return join(this.ws, dir)
  }

  private async handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    // agent-runtime's app-wide middleware: anything that can write the
    // workspace marks it in use and waits out a late `.git` swap.
    if (this.kind === 'deferring' && !isWorkspaceNeutralRequest(req.method, path)) await this.adoptGate.enter()
    // Binary bodies: the real guest handlers, before anything parses JSON.
    if (path === '/pool/export-home') return handleExportHome(req, { env: this.homeEnv(), stageDir: () => tmpdir() })
    if (path === '/pool/hydrate-home') return handleHydrateHome(req, { env: this.homeEnv() })
    const built = path.match(/^\/pool\/export-repo-bundle\/([0-9a-f]{64})$/)
    if (built && this.kind === 'deferring') {
      const p = join(this.bundleSpool, `${built[1]}.bundle`)
      return existsSync(p) ? new Response(Bun.file(p)) : Response.json({ error: 'bundle not built' }, { status: 404 })
    }
    const body: any = await req.json().catch(() => ({}))
    switch (path) {
      case '/pool/assign':
        if (this.kind === 'deferring') this.adoptGate.reset()
        this.env = { ...this.env, ...(body.env ?? {}), PROJECT_ID: body.projectId ?? this.env.PROJECT_ID }
        return Response.json({ ok: true })
      case '/pool/refresh-env':
        this.env = { ...this.env, ...(body.env ?? {}), PROJECT_ID: body.projectId ?? this.env.PROJECT_ID }
        return Response.json({ ok: true })
      case '/agent/chat':
        this.edit(body.rel, body.body)
        return Response.json({ ok: true })
      case '/pool/repo-bundles-hydrate':
        if (this.kind !== 'deferring') return new Response('not found', { status: 404 })
        return this.repoBundlesHydrate(body)
      case '/pool/export-repo-bundle':
        if (this.kind !== 'deferring') return new Response('not found', { status: 404 })
        return this.exportRepoBundle(body)
      case '/pool/hydrate-url': {
        const res = await fetch(body.url)
        if (!res.ok) return new Response(`pull failed ${res.status}`, { status: 502 })
        const dest = this.resolve(body.destDir)
        mkdirSync(dest, { recursive: true })
        const archive = join(tmpdir(), `fake-pull-${Date.now()}-${Math.random().toString(36).slice(2)}.tgz`)
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
        if (this.flushBeforeExport && git(this.ws, 'status', '--porcelain')) gitCommitAll(this.ws, 'flush before export')
        const out = join(tmpdir(), `fake-repo-${Date.now()}-${Math.random().toString(36).slice(2)}.tgz`)
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
      if (this.kind === 'deferring') return Response.json({ ok: true, supported: true, deadline: true, bundles: true, ifIdle: true })
      return Response.json(this.kind === 'current' ? { ok: true, supported: true, deadline: true } : { ok: true, supported: true })
    }
    const res = await this.repoAdopt(body)
    this.adoptStatuses.push(res.status)
    return res
  }

  private async repoAdopt(body: any): Promise<Response> {
    const staging = join(this.ws, body.stagingDir)
    if (this.kind === 'legacy') {
      const adopt = this.gitReady.then(() => adoptHydratedRepo(this.ws, staging, { logger: NOOP }))
      this.adopts.push(adopt.catch(() => {}))
      return Response.json({ ok: true, ...(await adopt) })
    }
    const timeoutMs = Number(body.timeoutMs)
    const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : null
    const run = () =>
      adoptHydratedRepoBefore(this.ws, staging, { deadline, ready: this.gitReady, keepPaths: body.keepPaths, logger: NOOP })
    // As agent-runtime: a late swap (`ifIdle`) only happens through the gate.
    const adopt = this.kind === 'deferring' && body.ifIdle === true ? this.adoptGate.adoptIfIdle(run) : run()
    this.adopts.push(adopt.catch(() => {}))
    try {
      const res = await adopt
      if (!res) {
        rmSync(staging, { recursive: true, force: true })
        return Response.json({ error: 'workspace already in use', adopted: false, busy: true }, { status: 409 })
      }
      return Response.json({ ok: true, ...res })
    } catch (err: any) {
      if (err instanceof AdoptDeadlineError) return Response.json({ error: err.message, adopted: false }, { status: 504 })
      return Response.json({ error: err?.message ?? String(err) }, { status: 500 })
    }
  }

  private bundleSpoolDir: string | null = null
  private get bundleSpool(): string {
    if (!this.bundleSpoolDir) this.bundleSpoolDir = mkdtempSync(join(tmpdir(), 'fake-bundle-spool-'))
    return this.bundleSpoolDir
  }

  /** agent-runtime's `/pool/export-repo-bundle`: the next bundle since `since`, served by digest. */
  private async exportRepoBundle(body: any): Promise<Response> {
    if (this.flushBeforeExport && git(this.ws, 'status', '--porcelain')) {
      gitCommitAll(this.ws, 'flush before export')
    }
    const since: string[] | null = body?.full === true || body?.since == null ? null : body.since
    try {
      const built = await buildRepoBundle(this.ws, { previous: since, workDir: this.bundleSpool })
      const snap = await readRepoSnapshotFields(this.ws)
      return Response.json({ bundle: built?.entry ?? null, ...snap, rootCommitAt: null })
    } catch (err: any) {
      return Response.json({ error: err?.message ?? String(err) }, { status: 500 })
    }
  }

  /** agent-runtime's `/pool/repo-bundles-hydrate`: download each bundle and rebuild the repo in staging. */
  private async repoBundlesHydrate(body: any): Promise<Response> {
    const staging = this.resolve(body.stagingDir)
    let manifest: RepoManifest
    try {
      manifest = parseRepoManifest(body.manifest)
    } catch (err: any) {
      return Response.json({ error: err?.message ?? 'invalid manifest' }, { status: 400 })
    }
    const items = body.bundles as Array<{ sha256: string; url: string }>
    const timeoutMs = Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : 15 * 60_000
    const spool = mkdtempSync(join(tmpdir(), 'fake-bundles-'))
    try {
      rmSync(staging, { recursive: true, force: true })
      await materializeRepoFromBundles(staging, manifest, async (entry) => {
        const item = items[manifest.bundles.indexOf(entry)]
        const res = await fetch(item.url, { signal: AbortSignal.timeout(timeoutMs) })
        if (!res.ok) throw new Error(`bundle ${entry.sha256} download failed (${res.status})`)
        const p = join(spool, `${entry.sha256}.bundle`)
        await Bun.write(p, res)
        return p
      })
      return Response.json({ ok: true, bundles: manifest.bundles.length })
    } catch (err: any) {
      rmSync(staging, { recursive: true, force: true })
      return Response.json({ error: err?.message ?? String(err) }, { status: 500 })
    } finally {
      rmSync(spool, { recursive: true, force: true })
    }
  }
}

/**
 * `FirecrackerVMManager` stand-in. Each `startVM` boots a template guest;
 * `snapshotVM` copies the workspace and stops the process (as Firecracker
 * does); `restoreVM` boots a guest from that copy. Anything the pool calls
 * that this does not model is a no-op.
 */
export class FakeHost {
  readonly guests = new Map<string, FakeGuest>()
  readonly dir = mkdtempSync(join(tmpdir(), 'fake-host-'))
  /** Disks kept by `quarantineRootfs`: label → workspace copy. */
  readonly quarantined = new Map<string, string>()
  private seq = 0
  private snapshotDirs = new Map<string, string>()
  /** Stopped VMs whose disk was kept (`stopVM(h, { keepRootfs: true })`): rootfs → guest. */
  private keptDisks = new Map<string, FakeGuest>()
  /** Every cold boot, with the golden image it was asked to boot from (absent: the class default). */
  readonly boots: Array<{ vmId: string; rootfsBase?: string }> = []
  /**
   * Write placeholder snapshot artifacts to disk, so a second pool over the
   * same dirs (an agent restart) rehydrates them from its cache index.
   */
  persistSnapshots = false

  constructor(
    readonly template: Record<string, string> = { 'src/App.tsx': 'Project Ready (template)\n' },
    public guestKind: GuestKind = 'current',
  ) {}

  guestFor(handle: FcVmHandle): FakeGuest | undefined {
    return this.guests.get(handle.id)
  }

  crash(vmId: string): void {
    this.guests.get(vmId)?.crash()
  }

  stopAll(): void {
    for (const g of [...this.guests.values(), ...this.keptDisks.values()]) g.stop()
    this.guests.clear()
    this.keptDisks.clear()
    rmSync(this.dir, { recursive: true, force: true })
  }

  private handleFor(id: string, guest: FakeGuest): FcVmHandle {
    return {
      id,
      agentUrl: guest.url,
      guestIp: '127.0.0.1',
      net: { tap: `fctap-${id}`, guestIp: '127.0.0.1' },
      pid: 10_000 + this.seq,
      platform: 'linux',
      rootfs: join(this.dir, `${id}.rootfs`),
      socketPath: join(this.dir, `${id}.sock`),
      serialLog: join(this.dir, `${id}.serial`),
      vcpus: 2,
      memoryMB: 1024,
      vmClass: 'standard',
    } as unknown as FcVmHandle
  }

  private boot(init: ConstructorParameters<typeof FakeGuest>[1]): FcVmHandle {
    const id = `fcvm-${++this.seq}`
    const guest = new FakeGuest(this.guestKind, init)
    this.guests.set(id, guest)
    return this.handleFor(id, guest)
  }

  /** The object handed to `new MetalWarmPool(mgr, ...)`. */
  manager(): any {
    const impl = {
      startVM: async (cfg?: { rootfsBase?: string }) => {
        const h = this.boot({ template: this.template })
        this.boots.push({ vmId: h.id, ...(cfg?.rootfsBase ? { rootfsBase: cfg.rootfsBase } : {}) })
        return h
      },
      restoreVM: async (snap: FcSnapshot) => {
        const from = this.snapshotDirs.get(snap.snapshotPath)
        if (!from) throw new Error(`no snapshot at ${snap.snapshotPath}`)
        return this.boot({ fromDir: from })
      },
      stopVM: async (h: FcVmHandle, opts?: { keepRootfs?: boolean }) => {
        const guest = this.guests.get(h.id)
        this.guests.delete(h.id)
        if (!guest) return
        if (opts?.keepRootfs) {
          if (guest.alive) guest.crash()
          this.keptDisks.set(h.rootfs, guest)
        } else {
          guest.stop()
        }
      },
      releaseRootfs: (rootfs: string) => {
        this.keptDisks.get(rootfs)?.stop()
        this.keptDisks.delete(rootfs)
      },
      quarantineRootfs: (rootfs: string, label: string): string | null => {
        const guest = this.keptDisks.get(rootfs)
        if (!guest) return null
        const kept = join(this.dir, `quarantine-${label}`)
        cpSync(guest.ws, kept, { recursive: true })
        this.quarantined.set(label, kept)
        this.keptDisks.delete(rootfs)
        guest.stop()
        return kept
      },
      extractWorkspace: async ({ rootfs }: { rootfs: string }, outDir: string) => {
        const guest = this.keptDisks.get(rootfs)
        if (!guest) return { source: null, repo: null }
        mkdirSync(outDir, { recursive: true })
        const source = join(outDir, 'source.tar.gz')
        execFileSync('tar', ['-czf', source, '-C', guest.ws, '--exclude=./.git', '--exclude=./.shogo', '.'])
        const repo = join(outDir, 'repo.git.tar.gz')
        await packRepoArchive(guest.ws, repo)
        return { source, repo }
      },
      isRunning: (h: FcVmHandle) => this.guests.get(h.id)?.alive === true,
      procCount: () => [...this.guests.values()].filter((g) => g.alive).length,
      snapshotVM: async (h: FcVmHandle): Promise<FcSnapshot> => {
        const guest = this.guests.get(h.id)
        if (!guest?.alive) throw new Error(`VM ${h.id} is not running`)
        const snapshotPath = join(this.dir, `${h.id}-${Date.now()}.vmstate`)
        const copy = join(this.dir, `${h.id}-${Date.now()}-ws`)
        cpSync(guest.ws, copy, { recursive: true })
        cpSync(guest.home, homeOf(copy), { recursive: true })
        this.snapshotDirs.set(snapshotPath, copy)
        if (this.persistSnapshots) {
          for (const f of [snapshotPath, `${snapshotPath}.mem`, h.rootfs]) writeFileSync(f, '')
        }
        guest.stop()
        this.guests.delete(h.id)
        return {
          vmId: h.id,
          snapshotPath,
          memFilePath: `${snapshotPath}.mem`,
          net: h.net,
          rootfs: h.rootfs,
          vcpus: h.vcpus,
          memoryMB: h.memoryMB,
          createdAt: Date.now(),
          bytesMem: 0,
          bytesState: 0,
          bytesRootfs: 0,
          vmClass: h.vmClass,
        } as FcSnapshot
      },
      durableRootfs: (p: string) => ({ path: p, mode: 'full' }),
      restoreRootfsArtifactPath: (p: string) => p,
      reapHostOrphans: () => 0,
    }
    return new Proxy(impl, {
      get: (target, prop) => (prop in target ? (target as any)[prop] : () => undefined),
    })
  }
}

/** Pool config pointed at a FakeS3, with host dirs under `dir`. */
export function fakeHostConfig(dir: string, s3: FakeS3, overrides: Partial<MetalConfig> = {}): MetalConfig {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    poolSize: 0,
    snapStore: 'none',
    s3Endpoint: s3.endpoint,
    s3Region: 'us-east-1',
    hydrateTimeoutMs: 10_000,
    healthIntervalMs: 10,
    ...overrides,
  } as MetalConfig
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  return cfg
}

/** Point `workspaceS3()` at the fake bucket; returns a restore function. */
export function useFakeS3Env(): () => void {
  const saved: Record<string, string | undefined> = {}
  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'S3_WORKSPACES_BUCKET']) saved[k] = process.env[k]
  process.env.AWS_ACCESS_KEY_ID = 'test-key'
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'
  process.env.S3_WORKSPACES_BUCKET = BUCKET
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

export function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' },
  }).trim()
}

export function gitCommitAll(dir: string, message: string): void {
  // agent-runtime's `stageExcludes`: host staging dirs (which hold their own
  // `.git` while a repo restore is in flight) are never part of a commit.
  // Via info/exclude, so it also holds after a durable `.git` is swapped in.
  const exclude = join(dir, '.git', 'info', 'exclude')
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf-8') : ''
  if (!current.includes('.shogo/local')) {
    mkdirSync(join(dir, '.git', 'info'), { recursive: true })
    writeFileSync(exclude, `${current}${current && !current.endsWith('\n') ? '\n' : ''}.shogo/local/\nchat-files/\n`)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '--allow-empty', '-m', message)
}

/** Where a guest workspace's HOME lives: a sibling, so it is never inside a source export. */
function homeOf(ws: string): string {
  return `${ws}-home`
}

export function writeRel(dir: string, rel: string, body: string): void {
  mkdirSync(join(dir, rel, '..'), { recursive: true })
  writeFileSync(join(dir, rel), body)
}

export function tarOf(files: Record<string, string>): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'fake-src-'))
  try {
    for (const [rel, body] of Object.entries(files)) writeRel(dir, rel, body)
    return new Uint8Array(execFileSync('tar', ['-czf', '-', '-C', dir, '.']))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Files inside a source archive, as the durable store holds it. */
export function untar(bytes: Uint8Array): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'fake-untar-'))
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

/** A durable `repo.git.tar.gz`'s HEAD, and whether its history contains `sha`. */
export function repoHeadContaining(bytes: Uint8Array, sha: string | null): { head: string; contains: boolean } | null {
  const dir = mkdtempSync(join(tmpdir(), 'fake-repo-anc-'))
  try {
    const archive = join(dir, 'r.tgz')
    writeFileSync(archive, bytes)
    execFileSync('tar', ['-xzf', archive, '-C', dir])
    const gitDir = join(dir, '.git')
    const head = execFileSync('git', ['--git-dir', gitDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
    if (!sha) return { head, contains: true }
    try {
      execFileSync('git', ['--git-dir', gitDir, 'merge-base', '--is-ancestor', sha, head], { stdio: 'ignore' })
      return { head, contains: true }
    } catch {
      return { head, contains: false }
    }
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** HEAD's copy of `rel` inside a durable `repo.git.tar.gz`. */
export function repoFileAtHead(bytes: Uint8Array, rel: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'fake-repo-read-'))
  try {
    const archive = join(dir, 'r.tgz')
    writeFileSync(archive, bytes)
    const out = join(dir, 'out')
    mkdirSync(out)
    execFileSync('tar', ['-xzf', archive, '-C', out])
    const gitDir = execFileSync('find', [out, '-maxdepth', '2', '-name', 'HEAD', '-type', 'f'], { encoding: 'utf-8' })
      .split('\n')
      .filter(Boolean)
      .map((p) => join(p, '..'))[0]
    if (!gitDir) return null
    return execFileSync('git', ['--git-dir', gitDir, 'show', `HEAD:${rel}`], { encoding: 'utf-8' })
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Write a durable repo in the incremental format (`repo/manifest.json` plus
 * one base bundle) whose HEAD holds `files`, built by the same code the
 * exporter uses. Returns HEAD and the bundle's object key.
 */
export async function putRepoBundles(
  s3: FakeS3,
  projectId: string,
  files: Record<string, string>,
  lastModified = Date.now(),
): Promise<{ sha: string; bundleKey: string; manifestEtag: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'fake-bundle-repo-'))
  const work = mkdtempSync(join(tmpdir(), 'fake-bundle-out-'))
  try {
    for (const [rel, body] of Object.entries(files)) writeRel(dir, rel, body)
    await seedRepoIfAbsent(dir, { logger: NOOP })
    const built = await buildRepoBundle(dir, { previous: null, workDir: work })
    if (!built) throw new Error('empty repo')
    const fields = await readRepoSnapshotFields(dir)
    const manifest: RepoManifest = {
      v: REPO_MANIFEST_VERSION,
      head: fields.head,
      refs: fields.refs,
      config: fields.config,
      rootCommitAt: null,
      bundles: [built.entry],
    }
    const bundleKey = `${projectId}/repo/bundles/${built.entry.sha256}.bundle`
    s3.put(bundleKey, new Uint8Array(readFileSync(built.path)), lastModified)
    const manifestEtag = s3.put(`${projectId}/repo/manifest.json`, new TextEncoder().encode(JSON.stringify(manifest)), lastModified)
    return { sha: git(dir, 'rev-parse', 'HEAD'), bundleKey, manifestEtag }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
}

/** A durable repo whose HEAD holds `files`. */
export async function repoArchiveOf(files: Record<string, string>): Promise<{ bytes: Uint8Array; sha: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'fake-repo-'))
  try {
    for (const [rel, body] of Object.entries(files)) writeRel(dir, rel, body)
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
