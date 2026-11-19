// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * End-to-end: a slow or hung git history download must never hold an open.
 *
 * 2026-10-25: a project took 2m33s to open on a warm host. Source and data
 * were in place within 25s; the git history download from object storage
 * then hung until the host gave up at ~128s. Meanwhile the API's 30s /assign
 * budget ran out five times. The host now serves the source's own `.git`
 * once `repoForegroundMs` passes, and swaps the history in afterwards, but
 * only while nobody has used the workspace.
 *
 * Everything here is real except the VM: the pool, Bun's S3 client against an
 * object store that can hang or fail GETs, tar, git, the guest's adopt
 * (`adoptHydratedRepoBefore`), its bundle restore (`materializeRepoFromBundles`)
 * and its late-swap gate (`RepoAdoptGate`, behind the same request middleware
 * as agent-runtime).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { metrics, M } from './metrics'
import { MetalWarmPool, REPO_DEFERRED_REASON } from './pool'
import type { SnapshotStore } from './snapshot-store'
import {
  FakeHost,
  FakeS3,
  fakeHostConfig,
  git,
  putRepoBundles,
  repoArchiveOf,
  tarOf,
  useFakeS3Env,
  type FakeGuest,
  type GuestKind,
} from './test-harness/fake-metal-host'

const ENV = { RUNTIME_AUTH_SECRET: 'tok' }
const HOUR = 3_600_000
/** The open's budget for the history download, scaled down from 10s. */
const FOREGROUND_MS = 300
/**
 * What an open may cost on top of the budget here (cold boot, source, data,
 * home, all on loopback). The incident's hang was unbounded; anything that
 * waits on it blows straight through this.
 */
const OPEN_SLACK_MS = 4_000

let restoreEnv: () => void
const cleanups: Array<() => void | Promise<void>> = []
beforeAll(() => {
  restoreEnv = useFakeS3Env()
})
afterAll(() => restoreEnv())
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

class TestPool extends MetalWarmPool {
  backup(projectId: string): Promise<string> {
    const self = this as any
    return self.saveBackupToStore(self.assigned.get(projectId))
  }
}

function rig(guestKind: GuestKind = 'deferring', overrides: { repoForegroundMs?: number } = {}) {
  const s3 = new FakeS3()
  const host = new FakeHost(undefined, guestKind)
  const dir = mkdtempSync(join(tmpdir(), 'repo-deferred-'))
  const releases: Array<() => void> = []
  const cfg = fakeHostConfig(dir, s3, { repoForegroundMs: overrides.repoForegroundMs ?? FOREGROUND_MS })
  const pool = new TestPool(host.manager(), cfg, { kind: 'none' } as unknown as SnapshotStore)
  // Last in, first out: release every stall and let background restores
  // finish before the servers stop and the host dirs are removed.
  cleanups.push(
    () => s3.stop(),
    () => host.stopAll(),
    () => rmSync(dir, { recursive: true, force: true }),
    async () => {
      releases.splice(0).forEach((r) => r())
      const until = Date.now() + 10_000
      while (Date.now() < until && [...(pool as any).assigned.values()].some((a: any) => a.repoHydratePending)) {
        await Bun.sleep(20)
      }
    },
  )
  const stall: FakeS3['stall'] = (match, mode) => {
    const release = s3.stall(match, mode)
    releases.push(release)
    return release
  }
  return { s3, host, pool, stall }
}

/** Durable state of a healthy project: its source, and git history saved just after it. */
async function seedProject(s3: FakeS3, projectId: string, format: 'tarball' | 'bundles') {
  const files = { 'src/App.tsx': 'v2: the user’s app\n', 'src/Login.tsx': 'login\n' }
  const t0 = Date.now() - 2 * HOUR
  s3.put(`${projectId}/project-src.tar.gz`, tarOf(files), t0)
  if (format === 'bundles') {
    const r = await putRepoBundles(s3, projectId, files, t0 + 60_000)
    return { repoSha: r.sha, repoKey: r.bundleKey, lineageEtag: r.manifestEtag }
  }
  const repo = await repoArchiveOf(files)
  const repoKey = `${projectId}/repo.git.tar.gz`
  const etag = s3.put(repoKey, repo.bytes, t0 + 60_000)
  return { repoSha: repo.sha, repoKey, lineageEtag: etag }
}

function deferredCount(): number {
  return ['adopted', 'busy', 'failed', 'abandoned'].reduce(
    (n, o) => n + metrics.getCounter(`${M.repoHydrateDeferred}{outcome="${o}"}`),
    0,
  )
}

function deferred(outcome: 'adopted' | 'busy' | 'failed' | 'abandoned'): number {
  return metrics.getCounter(`${M.repoHydrateDeferred}{outcome="${outcome}"}`)
}

/** Wait for the background restore started before `before` was read to finish. */
async function settleDeferred(before: number, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (deferredCount() <= before) {
    if (Date.now() > until) throw new Error('deferred repo hydrate never finished')
    await Bun.sleep(20)
  }
}

async function timedOpen(pool: MetalWarmPool, projectId: string) {
  const t0 = performance.now()
  const r = await pool.open(projectId, ENV)
  return { r, ms: performance.now() - t0 }
}

function guestOf(host: FakeHost, pool: MetalWarmPool, projectId: string): FakeGuest {
  return host.guestFor(pool.getAssigned(projectId)!.handle)!
}

describe.each(['tarball', 'bundles'] as const)('git history download hangs (%s repo)', (format) => {
  test('the open returns on the source within the budget, then the history swaps in while idle', async () => {
    const { s3, host, pool, stall } = rig()
    const { repoSha, repoKey, lineageEtag } = await seedProject(s3, 'p1', format)
    const release = stall((k) => k === repoKey)
    const before = deferredCount()

    const { r, ms } = await timedOpen(pool, 'p1')

    // The incident: this open waited on the hung download. Now it may not.
    expect(s3.stalledGets((k) => k === repoKey)).toBeGreaterThan(0)
    expect(ms).toBeLessThan(FOREGROUND_MS + OPEN_SLACK_MS)
    expect(r.mode).toBe('assigned')
    expect(r.repo?.mode).toBe('deferred')
    expect(r.repo!.foregroundMs).toBeGreaterThanOrEqual(FOREGROUND_MS - 50)
    expect(r.repo!.foregroundMs).toBeLessThan(FOREGROUND_MS + 1_000)
    expect(r.phases?.hydrate_repo).toBeLessThan(FOREGROUND_MS + 1_000)

    // Served on the source's own .git: the user's files, not yet the durable history.
    const guest = guestOf(host, pool, 'p1')
    expect(guest.read('src/App.tsx')).toBe('v2: the user’s app\n')
    expect(guest.hasCommit(repoSha)).toBe(false)

    // Until the history lands, this VM must not write over the durable repo.
    const a = pool.getAssigned('p1')!
    expect(a.repoUntrustedReason).toBe(REPO_DEFERRED_REASON)
    expect(await pool.saveRepoToStore(a)).toBe(false)
    expect(s3.writes.filter((k) => k.includes('/repo'))).toEqual([])
    // The source is fine and keeps backing up.
    expect(a.sourceUntrustedReason).toBeUndefined()
    expect(await pool.backup('p1')).toBe('written')

    // Storage recovers; nobody has touched the workspace, so the history swaps in.
    const adopted = deferred('adopted')
    release()
    await settleDeferred(before)
    expect(deferred('adopted')).toBe(adopted + 1)
    expect(guest.adoptStatuses).toEqual([200])
    expect(guest.head()).toBe(repoSha)
    expect(guest.read('src/App.tsx')).toBe('v2: the user’s app\n')
    expect(a.repoUntrustedReason).toBeUndefined()
    expect(a.repoLinked).toBe(true)
    expect(a.repoParentEtag).toBe(lineageEtag)

    // Linked to the durable lineage again: the next save extends it (a
    // tarball project migrates to bundles on this save).
    guest.edit('src/App.tsx', 'v3\n')
    expect(await pool.saveRepoToStore(a)).toBe(true)
    const manifest = JSON.parse(new TextDecoder().decode(s3.body('p1/repo/manifest.json')!))
    expect(manifest.refs['refs/heads/main']).toBe(guest.head())
    expect(git(guest.ws, 'rev-parse', 'HEAD~1')).toBe(repoSha)
  }, 30_000)

  test('a user who starts working first keeps their work; the late swap is refused', async () => {
    const { s3, host, pool, stall } = rig()
    const { repoKey } = await seedProject(s3, 'p1', format)
    const repoBytes = s3.body(repoKey)
    const release = stall((k) => k === repoKey)
    const before = deferredCount()

    const { r } = await timedOpen(pool, 'p1')
    expect(r.repo?.mode).toBe('deferred')
    const guest = guestOf(host, pool, 'p1')
    await guest.use('src/App.tsx', 'the user’s first edit\n')

    const busy = deferred('busy')
    release()
    await settleDeferred(before)
    expect(deferred('busy')).toBe(busy + 1)
    expect(guest.adoptStatuses).toEqual([409])

    // Nothing was reset under them.
    expect(guest.read('src/App.tsx')).toBe('the user’s first edit\n')
    expect(guest.read('src/Login.tsx')).toBe('login\n')

    // The VM's .git never joined the durable lineage, so it may never replace it.
    const a = pool.getAssigned('p1')!
    expect(a.repoUntrustedReason).toBeDefined()
    expect(a.repoUntrustedReason).not.toBe(REPO_DEFERRED_REASON)
    // Their work still gets somewhere durable: the copy lands in `conflict/`,
    // and the real repo is untouched (SHO-442).
    expect(await pool.saveRepoToStore(a)).toBe(true)
    expect(a.repoQuarantineKey).toContain('conflict/')
    expect(s3.body(repoKey)).toEqual(repoBytes!)
    // Their work still reaches the source backup.
    expect(a.sourceUntrustedReason).toBeUndefined()
    expect(await pool.backup('p1')).toBe('written')
  }, 30_000)

  test('a download that fails outright after the open leaves the VM untrusted for the repo only', async () => {
    const { s3, host, pool, stall } = rig()
    const { repoKey } = await seedProject(s3, 'p1', format)
    const repoBytes = s3.body(repoKey)
    stall((k) => k === repoKey, { kind: 'fail', afterMs: FOREGROUND_MS * 2 })
    const before = deferredCount()

    const { r, ms } = await timedOpen(pool, 'p1')
    expect(ms).toBeLessThan(FOREGROUND_MS + OPEN_SLACK_MS)
    expect(r.repo?.mode).toBe('deferred')

    const failed = deferred('failed')
    await settleDeferred(before)
    expect(deferred('failed')).toBe(failed + 1)

    const guest = guestOf(host, pool, 'p1')
    expect(guest.adoptStatuses).toEqual([])
    expect(guest.read('src/App.tsx')).toBe('v2: the user’s app\n')
    const a = pool.getAssigned('p1')!
    expect(a.repoUntrustedReason).toContain('failed in the background')
    // It saves to `conflict/`; the durable repo it never adopted is untouched.
    expect(await pool.saveRepoToStore(a)).toBe(true)
    expect(a.repoQuarantineKey).toContain('conflict/')
    expect(s3.body(repoKey)).toEqual(repoBytes!)
    // A failed download proves nothing about the tree: source stays trusted.
    expect(a.sourceUntrustedReason).toBeUndefined()
    expect(await pool.backup('p1')).toBe('written')
  }, 30_000)
})

describe('git history download is slow but within budget', () => {
  test('it is waited for, so the open lands on the durable history directly', async () => {
    const { s3, host, pool, stall } = rig('deferring', { repoForegroundMs: 5_000 })
    const { repoSha, repoKey } = await seedProject(s3, 'p1', 'bundles')
    stall((k) => k === repoKey, { kind: 'delay', afterMs: 200 })

    const { r } = await timedOpen(pool, 'p1')

    expect(r.repo?.mode).toBe('foreground')
    expect(guestOf(host, pool, 'p1').head()).toBe(repoSha)
    const a = pool.getAssigned('p1')!
    expect(a.repoUntrustedReason).toBeUndefined()
    expect(a.repoLinked).toBe(true)
  }, 30_000)
})

describe('guests that cannot refuse a late swap', () => {
  test('are still waited for: an unguarded reset after the open could wipe the user’s work', async () => {
    const { s3, host, pool, stall } = rig('current')
    const { repoSha, repoKey } = await seedProject(s3, 'p1', 'tarball')
    const DELAY = FOREGROUND_MS * 3
    stall((k) => k === repoKey, { kind: 'delay', afterMs: DELAY })

    const { r, ms } = await timedOpen(pool, 'p1')

    expect(ms).toBeGreaterThanOrEqual(DELAY)
    expect(r.repo?.mode).toBe('foreground')
    expect(guestOf(host, pool, 'p1').head()).toBe(repoSha)
    expect(pool.getAssigned('p1')!.repoUntrustedReason).toBeUndefined()
  }, 30_000)
})

describe('the VM goes away while the history is still downloading', () => {
  // A snapshot only carries the repo lineage of a trusted VM, so this one
  // resumes create-only: it may start a durable repo but never replace one.
  // Its `.git` never adopted the history, so replacing would lose it.
  test('a suspend abandons the background restore, and the resumed VM can never replace the durable history', async () => {
    const { s3, host, pool, stall } = rig()
    const { repoSha, repoKey } = await seedProject(s3, 'p1', 'tarball')
    const repoBytes = s3.body(repoKey)
    const release = stall((k) => k === repoKey)
    const before = deferredCount()

    expect((await timedOpen(pool, 'p1')).r.repo?.mode).toBe('deferred')
    await pool.suspend('p1')
    const abandoned = deferred('abandoned')
    release()
    await settleDeferred(before)
    expect(deferred('abandoned')).toBe(abandoned + 1)

    const { r } = await timedOpen(pool, 'p1')
    expect(r.mode).toBe('resumed')
    const a = pool.getAssigned('p1')!
    expect(a.repoParentEtag).toBeUndefined()
    const guest = host.guestFor(a.handle)!
    expect(guest.hasCommit(repoSha)).toBe(false)

    guest.edit('src/App.tsx', 'work after the resume\n')
    // Create-only: it may start a repo, never replace one. The copy lands in
    // `conflict/` and the durable history is untouched (SHO-442).
    expect(await pool.saveRepoToStore(a)).toBe(false)
    expect(s3.body(repoKey)).toEqual(repoBytes!)
    expect(s3.body('p1/repo/manifest.json')).toBeUndefined()
    // The work itself is safe in the source backup.
    expect(await pool.backup('p1')).toBe('written')
  }, 30_000)
})

/**
 * AC3: an UNTRUSTED VM heals back to a normal writer.
 *
 * Before SHO-442 nothing ever cleared `repoUntrustedReason`, so a VM that lost
 * trust once saved nothing for the rest of its life — that is how ws 2e47feea
 * lost a day and a half. The heal downloads the durable history into a side
 * staging dir and asks the guest to write a commit whose tree is its CURRENT
 * working tree and whose parents are `[durable HEAD, live HEAD]`. No file is
 * rewritten, so a workspace the user is already working in is fine.
 */
describe('an UNTRUSTED VM heals back to a normal writer', () => {
  test('the busy-deferred case: the user worked first, and the heal keeps every file', async () => {
    const { s3, host, pool, stall } = rig()
    const { repoSha, repoKey, lineageEtag } = await seedProject(s3, 'p1', 'bundles')
    const release = stall((k) => k === repoKey)
    const before = deferredCount()

    expect((await timedOpen(pool, 'p1')).r.repo?.mode).toBe('deferred')
    const guest = guestOf(host, pool, 'p1')
    await guest.use('src/App.tsx', 'the user’s first edit\n')

    // The late swap is refused because the workspace is in use, and the VM is
    // distrusted for the rest of its life — until the heal.
    release()
    await settleDeferred(before)
    expect(guest.adoptStatuses).toEqual([409])

    const a = pool.getAssigned('p1')!
    expect(a.repoUntrustedReason).toBeDefined()
    expect(a.repoUntrustedReason).not.toBe(REPO_DEFERRED_REASON)
    // Work the user has not committed yet, and an export that does not flush it
    // (a mid-turn export): the heal must carry it in the tree, not drop it.
    guest.flushBeforeExport = false
    guest.writeWorkspace('notes.md', 'written but not committed\n')
    // What the guest's heartbeat would report; the harness has no heartbeat.
    a.repoHeadSha = guest.head()
    const liveHead = a.repoHeadSha
    expect(pool.repoDurable(a)).toBe(false)

    // One sweep: the copy goes to `conflict/` AND the lineage is re-attached.
    expect(await pool.exportAllRepos()).toBe(1)
    expect(a.repoQuarantineKey).toContain('conflict/')

    expect(a.repoUntrustedReason).toBeUndefined()
    expect(a.repoLinked).toBe(true)
    expect(a.repoParentEtag).toBe(lineageEtag)
    expect(guest.reconciles).toHaveLength(1)
    const healed = guest.reconciles[0]!
    expect(healed.durableHead).toBe(repoSha)
    expect(healed.localHead).toBe(liveHead)
    expect(guest.head()).toBe(healed.head)
    // Both parents: the durable history and the live one.
    expect(git(guest.ws, 'rev-list', '--parents', '-n', '1', 'HEAD')).toBe(`${healed.head} ${repoSha} ${liveHead}`)

    // No file was rewritten, the user's work is in the healed tree, and the
    // next commit is a no-op.
    expect(guest.read('src/App.tsx')).toBe('the user’s first edit\n')
    expect(git(guest.ws, 'show', `${healed.head}:src/App.tsx`)).toBe('the user’s first edit')
    // The uncommitted file is in the healed tree AND still on disk.
    expect(git(guest.ws, 'show', `${healed.head}:notes.md`)).toBe('written but not committed')
    expect(guest.read('notes.md')).toBe('written but not committed\n')
    expect(git(guest.ws, 'status', '--porcelain')).toBe('')
    // Healed is not saved: the durable repo still holds the pre-heal HEAD, so
    // nothing may stop this VM until the next export lands.
    expect(pool.repoDurable(a)).toBe(false)

    // Normal saves resume, and the next one extends the durable repo.
    guest.edit('src/App.tsx', 'v3 after the heal\n')
    a.repoHeadSha = guest.head()
    expect(await pool.saveRepoToStore(a)).toBe(true)
    const manifest = JSON.parse(new TextDecoder().decode(s3.body('p1/repo/manifest.json')!))
    expect(manifest.refs['refs/heads/main']).toBe(guest.head())
    expect(git(guest.ws, 'rev-parse', 'HEAD~1')).toBe(healed.head)
    expect(pool.repoDurable(a)).toBe(true)
  }, 30_000)

  test('a download that failed outright heals too, and the durable history is never replaced', async () => {
    const { s3, host, pool, stall } = rig()
    const { repoSha, repoKey } = await seedProject(s3, 'p1', 'bundles')
    const repoBytes = s3.body(repoKey)
    const release = stall((k) => k === repoKey, { kind: 'fail', afterMs: FOREGROUND_MS * 2 })
    const before = deferredCount()

    expect((await timedOpen(pool, 'p1')).r.repo?.mode).toBe('deferred')
    await settleDeferred(before)
    // Storage recovers; the heal's own download must not hit the same fault.
    release()

    const guest = guestOf(host, pool, 'p1')
    const a = pool.getAssigned('p1')!
    expect(a.repoUntrustedReason).toContain('failed in the background')
    guest.edit('src/App.tsx', 'work made while untrusted\n')
    a.repoHeadSha = guest.head()
    const liveHead = a.repoHeadSha

    expect(await pool.exportAllRepos()).toBe(1)
    expect(a.repoUntrustedReason).toBeUndefined()
    expect(guest.reconciles).toHaveLength(1)
    expect(guest.reconciles[0]!.durableHead).toBe(repoSha)
    expect(guest.reconciles[0]!.localHead).toBe(liveHead)
    expect(guest.read('src/App.tsx')).toBe('work made while untrusted\n')
    expect(git(guest.ws, 'status', '--porcelain')).toBe('')
    // The durable bundle the VM never adopted is untouched by the heal.
    expect(s3.body(repoKey)).toEqual(repoBytes!)
  }, 30_000)

  test('a heal that cannot reach the durable repo leaves the VM untrusted and backs off', async () => {
    const { s3, host, pool } = rig()
    await seedProject(s3, 'p1', 'bundles')
    expect((await timedOpen(pool, 'p1')).r.mode).toBe('assigned')

    const guest = guestOf(host, pool, 'p1')
    const a = pool.getAssigned('p1')!
    // Distrusted with no durable repo to reconcile against: the heal must not
    // pretend it worked, and must not retry on every sweep.
    a.repoUntrustedReason = 'hydrate failed'
    a.repoHeadSha = guest.head()
    s3.objects.delete('p1/repo/manifest.json')

    expect(await pool.exportAllRepos()).toBe(1)
    expect(a.repoUntrustedReason).toBe('hydrate failed')
    expect(guest.reconciles).toHaveLength(0)
    expect(a.repoHealFailures).toBe(1)
    expect(a.repoHealRetryAt).toBeGreaterThan(Date.now())

    // The next sweep inside the backoff window does not try again.
    expect(await pool.exportAllRepos()).toBe(0)
    expect(a.repoHealFailures).toBe(1)
  }, 30_000)
})
