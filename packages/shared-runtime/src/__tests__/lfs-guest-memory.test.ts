// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-531 — `git-lfs` and `git` OOM-killed a 4 GiB workspace guest.
 *
 * Prod evidence (Odin AI `alignment-project-server`, `git_only`, 482 checkpoint
 * commits): nine `git-lfs`/`git` OOM kills in 24h, and an 8-hour window in which
 * not one checkpoint commit landed. Every save ran, twice:
 *
 *   1. `git lfs prune --force` — which on this repo can never free anything
 *      (git-lfs judges "pushed" from `refs/remotes/origin`, we remote as
 *      `cloud` and never push git refs), so it walked the history with
 *      `git log -G 'oid sha256:' -p` — loading every changed blob in full —
 *      and then kept every object.
 *   2. a full push: `rev-list --objects --all` buffered as one JS string,
 *      `cat-file --batch` over every blob at an LFS-tracked path (raw media
 *      included, discarded only after it had been read), and
 *      `git lfs push --object-id` for EVERY local object.
 *
 * These tests hold the four properties that stop it, against real git and real
 * git-lfs. A `git` shim on PATH records each invocation, so "no history scan",
 * "two processes per stage" and "the 50 MB blob is never read" are asserted on
 * what the process actually ran, not on our intentions.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  autoTrackLargeFiles,
  evictLfsOverBudget,
  hasLocalLfsObject,
  headLfsObjectIds,
  lfsObjectsInRange,
  lfsPushedTips,
  lfsPushIncremental,
  lfsRemoteConfigFromEnv,
  lfsStats,
  localLfsObjectPath,
  resetLfsStats,
  writeManagedGitAttributes,
  ensureLfsRepoSetup,
  readManagedAttributePaths,
  LfsPushRunner,
  type LfsRemoteConfig,
} from '../lfs'

const quiet = { log() {}, warn() {}, error() {} } as any
const MB = 1024 * 1024
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim()

// ---------------------------------------------------------------------------
// A `git` shim that records argv (and, for `cat-file --batch`, its stdin)
// ---------------------------------------------------------------------------

interface GitSpy {
  /** Every invocation, as the argv string the process received. */
  calls: () => string[]
  /** Everything ever fed to `git cat-file --batch` on stdin. */
  batchStdin: () => string
  reset: () => void
  restore: () => void
}

function installGitSpy(): GitSpy {
  const dir = mkdtempSync(join(tmpdir(), 'git-spy-'))
  const logPath = join(dir, 'calls.log')
  const batchPath = join(dir, 'batch-stdin.log')
  const realPath = join(dir, 'real-git-path')
  writeFileSync(realPath, REAL_GIT)
  writeFileSync(
    join(dir, 'git'),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$GIT_SPY_LOG"
REAL=$(cat "$GIT_SPY_REAL")
if [ "$1" = "cat-file" ] && [ "$2" = "--batch" ]; then
  tmp=$(mktemp)
  cat > "$tmp"
  cat "$tmp" >> "$GIT_SPY_BATCH"
  "$REAL" "$@" < "$tmp"
  rc=$?
  rm -f "$tmp"
  exit $rc
fi
exec "$REAL" "$@"
`,
  )
  chmodSync(join(dir, 'git'), 0o755)

  const savedPath = process.env.PATH
  const savedLog = process.env.GIT_SPY_LOG
  const savedBatch = process.env.GIT_SPY_BATCH
  const savedReal = process.env.GIT_SPY_REAL
  writeFileSync(logPath, '')
  writeFileSync(batchPath, '')
  process.env.PATH = `${dir}:${savedPath}`
  process.env.GIT_SPY_LOG = logPath
  process.env.GIT_SPY_BATCH = batchPath
  process.env.GIT_SPY_REAL = realPath

  return {
    calls: () => readFileSync(logPath, 'utf-8').split('\n').filter(Boolean),
    batchStdin: () => readFileSync(batchPath, 'utf-8'),
    reset: () => {
      writeFileSync(logPath, '')
      writeFileSync(batchPath, '')
    },
    restore: () => {
      for (const [k, v] of [
        ['PATH', savedPath],
        ['GIT_SPY_LOG', savedLog],
        ['GIT_SPY_BATCH', savedBatch],
        ['GIT_SPY_REAL', savedReal],
      ] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c()
})

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sho531-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'pipe' })
  git(dir, 'config', 'user.email', 'agent@shogo.ai')
  git(dir, 'config', 'user.name', 'Shogo Agent')
  git(dir, 'config', 'commit.gpgsign', 'false')
  execFileSync('git', ['lfs', 'install', '--local', '--skip-smudge'], { cwd: dir, stdio: 'pipe' })
  writeManagedGitAttributes(dir)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'attributes', '--no-verify')
  return dir
}

/** A fake LFS batch API: answers "have it / do not have it" and counts uploads. */
function startFakeLfs() {
  const stored = new Map<string, number>()
  const batches: Array<{ oids: string[] }> = []
  const uploads: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/objects/batch')) {
        const body: any = await req.json()
        batches.push({ oids: (body.objects ?? []).map((o: any) => o.oid) })
        return Response.json({
          transfer: 'basic',
          hash_algo: 'sha256',
          objects: (body.objects ?? []).map((o: any) =>
            stored.has(o.oid)
              ? { oid: o.oid, size: o.size, authenticated: true }
              : {
                  oid: o.oid,
                  size: o.size,
                  authenticated: true,
                  actions: {
                    upload: { href: `http://127.0.0.1:${server.port}/upload/${o.oid}`, expires_in: 600 },
                    verify: { href: `http://127.0.0.1:${server.port}/verify`, expires_in: 600 },
                  },
                },
          ),
        })
      }
      if (url.pathname.startsWith('/upload/')) {
        const oid = url.pathname.slice('/upload/'.length)
        stored.set(oid, (await req.arrayBuffer()).byteLength)
        uploads.push(oid)
        return new Response(null, { status: 200 })
      }
      if (url.pathname === '/verify') return new Response(null, { status: 200 })
      return new Response('not found', { status: 404 })
    },
  })
  cleanup.push(() => server.stop(true))
  return {
    url: `http://127.0.0.1:${server.port}`,
    stored,
    batches,
    uploads,
    has: (oid: string) => stored.has(oid),
    stop: () => server.stop(true),
  }
}

let restoreEnv: () => void
beforeAll(() => {
  const saved = { ...process.env }
  process.env.SHOGO_API_URL = 'http://127.0.0.1:9'
  process.env.RUNTIME_AUTH_SECRET = 'tok'
  process.env.PROJECT_ID = 'p1'
  restoreEnv = () => {
    for (const k of ['SHOGO_API_URL', 'RUNTIME_AUTH_SECRET', 'PROJECT_ID']) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
})
afterAll(() => restoreEnv())

function cfgFor(dir: string, url: string): LfsRemoteConfig {
  const cfg = lfsRemoteConfigFromEnv(dir, quiet)
  if (!cfg) throw new Error('lfsRemoteConfigFromEnv returned null')
  cfg.cloudApiUrl = url
  return cfg
}

/** Write an LFS-tracked file of `bytes` and commit it. */
function commitLfsFile(dir: string, rel: string, bytes: number, seed: number, message: string) {
  const body = Buffer.alloc(bytes, seed)
  body.writeUInt32BE(seed, 0)
  mkdirSync(join(dir, rel, '..'), { recursive: true })
  writeFileSync(join(dir, rel), body)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message, '--no-verify')
}

// ---------------------------------------------------------------------------

describe('SHO-531 AC2 — nothing runs `git lfs prune`, and eviction frees real bytes', () => {
  it('no code path invokes `git lfs prune` any more', () => {
    const sources = [
      readFileSync(join(import.meta.dir, '..', 'lfs.ts'), 'utf-8'),
      readFileSync(join(import.meta.dir, '..', '..', '..', 'agent-runtime', 'src', 'server.ts'), 'utf-8'),
    ]
    for (const src of sources) {
      // The subcommand only ever reaches git as a quoted string literal. Prose
      // in the comments that explains WHY prune is gone is not a code path.
      expect(/'prune'|"prune"/.test(src)).toBe(false)
    }
  })

  it('evicts what the server holds and keeps what HEAD references, with no history scan', async () => {
    const spy = installGitSpy()
    cleanup.push(() => spy.restore())
    const { url, stored } = startFakeLfs()
    const dir = initRepo()
    // Two commits of media -> two sets of objects; the second REPLACES the
    // first, so HEAD's tree references only the newer one.
    commitLfsFile(dir, 'media/old.png', 300_000, 1, 'old media')
    rmSync(join(dir, 'media', 'old.png'))
    commitLfsFile(dir, 'media/new.png', 300_000, 2, 'new media')

    const headOids = await headLfsObjectIds(dir)
    expect(headOids.size).toBe(1) // HEAD's tree has one LFS-tracked file
    const all = await lfsObjectsInRange(dir, null)
    expect(all.length).toBe(2)
    for (const o of all) stored.set(o.oid, o.size)

    // A budget far below the 600 KB store.
    process.env.SHOGO_LFS_BUDGET_GB = '0.0002' // ~200 KB
    try {
      resetLfsStats()
      spy.reset()
      const res = await evictLfsOverBudget(dir, { cfg: cfgFor(dir, url), logger: quiet })
      expect(res.ran).toBe(true)
      expect(res.evicted).toBe(1)
      expect(res.bytesAfter).toBeLessThan(res.bytesBefore)
      expect(lfsStats().evictions).toBe(1)
      expect(lfsStats().emptyEvictions).toBe(0)

      const old = all.find((o) => o.paths.includes('media/old.png'))!
      const fresh = all.find((o) => o.paths.includes('media/new.png'))!
      // The unreferenced, server-confirmed object is gone from disk…
      expect(hasLocalLfsObject(dir, old.oid)).toBe(false)
      // …and HEAD's is untouched, so the working tree still checks out.
      expect(hasLocalLfsObject(dir, fresh.oid)).toBe(true)

      // No history walk at all: `ls-tree` for the keep set, nothing else.
      const calls = spy.calls()
      expect(calls.some((c) => c.startsWith('log ') || c.includes(' -G'))).toBe(false)
      expect(calls.some((c) => c.startsWith('rev-list'))).toBe(false)
      expect(calls.some((c) => c.startsWith('ls-tree'))).toBe(true)
    } finally {
      delete process.env.SHOGO_LFS_BUDGET_GB
    }
  }, 60_000)

  it('a second commit with nothing new to evict does no work at all', async () => {
    const { url, stored } = startFakeLfs()
    const dir = initRepo()
    commitLfsFile(dir, 'media/old.png', 300_000, 1, 'old media')
    commitLfsFile(dir, 'media/new.png', 300_000, 2, 'new media')
    const all = await lfsObjectsInRange(dir, null)
    // Nothing on the server: no object may ever be deleted.
    expect(all.length).toBe(2)
    const cfg = cfgFor(dir, url)

    process.env.SHOGO_LFS_BUDGET_GB = '0.0002'
    try {
      resetLfsStats()
      // First pass: nothing confirmed remotely, so it frees nothing and records
      // that it tried.
      const first = await evictLfsOverBudget(dir, { cfg, logger: quiet })
      expect(first.evicted).toBe(0)
      expect(lfsStats().emptyEvictions).toBe(1)
      expect(stored.size).toBe(0)

      // Second pass, same size: backed off without even asking the server.
      const before = lfsStats()
      const second = await evictLfsOverBudget(dir, { cfg, logger: quiet })
      expect(second.ran).toBe(false)
      expect(lfsStats().backedOff).toBe(before.backedOff + 1)
      expect(lfsStats().evictions).toBe(before.evictions)
      // Everything is still there — over budget is better than losing bytes.
      for (const o of all) expect(hasLocalLfsObject(dir, o.oid)).toBe(true)
    } finally {
      delete process.env.SHOGO_LFS_BUDGET_GB
    }
  }, 60_000)

  it('eviction brings the store under budget, so tracking resumes', async () => {
    const { url, stored } = startFakeLfs()
    const dir = initRepo()
    // Four 400 KB objects in history; each commit replaces the previous file,
    // so HEAD's tree references only the last.
    for (let i = 0; i < 4; i++) {
      if (i > 0) rmSync(join(dir, 'media', `f-${i - 1}.png`))
      commitLfsFile(dir, `media/f-${i}.png`, 400_000, i + 1, `media ${i}`)
    }
    const all = await lfsObjectsInRange(dir, null)
    expect(all.length).toBe(4)
    for (const o of all) stored.set(o.oid, o.size)
    const cfg = cfgFor(dir, url)

    process.env.SHOGO_LFS_BUDGET_GB = '0.0005' // ~500 KB against a 1.6 MB store
    try {
      const res = await evictLfsOverBudget(dir, { cfg, logger: quiet, targetRatio: 0.8 })
      expect(res.evicted).toBe(3)
      expect(res.bytesAfter).toBeLessThan(500_000)
      expect(hasLocalLfsObject(dir, all.find((o) => o.paths.includes('media/f-3.png'))!.oid)).toBe(true)
    } finally {
      delete process.env.SHOGO_LFS_BUDGET_GB
    }
  }, 60_000)
})

describe('SHO-531 AC3 — one incremental push per commit, never re-pushing', () => {
  it('records the pushed tips and walks only the commits since them', async () => {
    const spy = installGitSpy()
    cleanup.push(() => spy.restore())
    const { url, uploads } = startFakeLfs()
    const dir = initRepo()
    const cfg = cfgFor(dir, url)

    commitLfsFile(dir, 'media/a.png', 200_000, 1, 'a')
    await lfsPushIncremental(cfg, { tips: null, logger: quiet })
    const afterFirst = lfsPushedTips(dir)
    expect(afterFirst).toEqual([git(dir, 'rev-parse', 'HEAD')])
    expect(uploads.length).toBe(1)

    // Three more commits, one new object each.
    for (let i = 0; i < 3; i++) commitLfsFile(dir, `media/n-${i}.png`, 200_000, 10 + i, `n${i}`)
    spy.reset()
    const res = await lfsPushIncremental(cfg, { tips: lfsPushedTips(dir), logger: quiet })

    // Exactly the three new objects, and the rev-list was bounded by the marker.
    expect(res.total).toBe(3)
    expect(res.pushed).toBe(3)
    expect(uploads.length).toBe(4)
    const revList = spy.calls().find((c) => c.startsWith('rev-list'))
    expect(revList).toBeDefined()
    expect(revList!).toContain(`--not ${afterFirst![0]}`)
    // The marker advanced to the new HEAD, so the next save starts from here.
    expect(lfsPushedTips(dir)).toEqual([git(dir, 'rev-parse', 'HEAD')])
  }, 90_000)

  it('uploads nothing when the server already has every local object', async () => {
    const { url, stored, uploads } = startFakeLfs()
    const dir = initRepo()
    const cfg = cfgFor(dir, url)
    commitLfsFile(dir, 'media/a.png', 200_000, 1, 'a')
    commitLfsFile(dir, 'media/b.png', 200_000, 2, 'b')
    const all = await lfsObjectsInRange(dir, null)
    for (const o of all) stored.set(o.oid, o.size)

    resetLfsStats()
    const res = await lfsPushIncremental(cfg, { tips: null, logger: quiet })
    expect(res.pushed).toBe(0)
    expect(res.skipped).toBe(2)
    expect(uploads).toEqual([])
    expect(lfsStats().remoteSkips).toBe(2)
  }, 60_000)
})

describe('SHO-531 AC4 — a large raw blob at a now-LFS path is never read', () => {
  it('filters with batch-check before batch, so 50 MB never enters the process', async () => {
    const spy = installGitSpy()
    cleanup.push(() => spy.restore())
    const dir = initRepo()
    // 1. A 50 MB blob committed RAW at media/huge.dat (no rule yet).
    mkdirSync(join(dir, 'media'), { recursive: true })
    writeFileSync(join(dir, 'media', 'huge.dat'), Buffer.alloc(50 * MB, 7))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'raw 50MB', '--no-verify')
    const rawSha = git(dir, 'rev-parse', 'HEAD:media/huge.dat')

    // 2. The path becomes LFS-tracked now (this is what made the old code read
    //    it in full and then throw it away for being > 1 KiB).
    writeManagedGitAttributes(dir, { pathRules: ['media/huge.dat'] })
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'track it', '--no-verify')
    expect(git(dir, 'check-attr', 'filter', '--', 'media/huge.dat')).toBe('media/huge.dat: filter: lfs')

    // 3. A real pointer at a second tracked path, so --batch has to run.
    commitLfsFile(dir, 'media/small.png', 200_000, 3, 'a real pointer')

    spy.reset()
    const objects = await lfsObjectsInRange(dir, null)

    // The real pointer resolves; nothing resolves to the 50 MB raw blob.
    expect(objects.some((o) => o.paths.includes('media/small.png'))).toBe(true)
    expect(objects.find((o) => o.paths.includes('media/small.png'))!.size).toBe(200_000)

    // And the reason is observable: the big sha never reached --batch stdin,
    // while the small pointer's sha did.
    const fed = spy.batchStdin()
    expect(fed).not.toContain(rawSha)
    const pointerSha = git(dir, 'rev-parse', 'HEAD:media/small.png')
    expect(fed).toContain(pointerSha)
    // batch-check did see it — cheaply, as a size, without its content.
    expect(spy.calls().some((c) => c.startsWith('cat-file --batch-check'))).toBe(true)
  }, 120_000)
})

describe('SHO-531 AC5 — a save and a host export share one push job', () => {
  it('two concurrent runs for the same tips and HEAD are one job, one rev-list', async () => {
    const spy = installGitSpy()
    cleanup.push(() => spy.restore())
    const { url, uploads } = startFakeLfs()
    const dir = initRepo()
    const cfg = cfgFor(dir, url)
    commitLfsFile(dir, 'media/a.png', 200_000, 1, 'a')

    const runner = new LfsPushRunner({ logger: quiet })
    spy.reset()
    const tips = lfsPushedTips(dir)
    const [a, b] = await Promise.all([runner.run(cfg, tips), runner.run(cfg, tips)])

    expect(a).toBe(b) // literally the same job object
    await a.settled
    await b.settled
    expect(a.state.pushed).toBe(1)
    expect(uploads.length).toBe(1)
    // One rev-list for both callers, not two.
    expect(spy.calls().filter((c) => c.startsWith('rev-list')).length).toBe(1)
  }, 60_000)

  it('serialises two concurrent pushes on one repo; the second finds nothing to do', async () => {
    const spy = installGitSpy()
    cleanup.push(() => spy.restore())
    const { url } = startFakeLfs()
    const dir = initRepo()
    const cfg = cfgFor(dir, url)
    commitLfsFile(dir, 'media/a.png', 200_000, 1, 'a')
    commitLfsFile(dir, 'media/b.png', 200_000, 2, 'b')

    spy.reset()
    const first = lfsPushIncremental(cfg, { tips: null, logger: quiet })
    const second = lfsPushIncremental(cfg, { tips: null, logger: quiet })
    const [r1, r2] = await Promise.all([first, second])
    expect(r1.pushed).toBe(2)
    // The per-repo lock makes this one push at a time: by the time the second
    // scan runs, every object is already on the server, so it uploads nothing.
    expect(r2.pushed).toBe(0)
    expect(r2.skipped).toBe(2)
    // Two bounded scans, never two concurrent ones.
    expect(spy.calls().filter((c) => c.startsWith('rev-list')).length).toBe(2)
  }, 60_000)
})

describe('SHO-531 AC6 — auto-track spawns a fixed number of git processes', () => {
  it('12 large files cost the same two git invocations as one', async () => {
    const spy = installGitSpy()
    cleanup.push(() => spy.restore())

    const one = initRepo()
    mkdirSync(join(one, 'blobs'), { recursive: true })
    writeFileSync(join(one, 'blobs', 'a.dat'), Buffer.alloc(3 * MB, 1))
    spy.reset()
    expect(await autoTrackLargeFiles(one, 1 * MB, { logger: quiet, cfg: null })).toBe(1)
    const oneCalls = spy.calls()
    expect(oneCalls.length).toBe(2)
    expect(oneCalls.filter((c) => c.startsWith('check-ignore')).length).toBe(1)
    expect(oneCalls.filter((c) => c.startsWith('check-attr')).length).toBe(1)
    expect(oneCalls.some((c) => c.includes('lfs track'))).toBe(false)

    const many = initRepo()
    mkdirSync(join(many, 'blobs'), { recursive: true })
    for (let i = 0; i < 12; i++) writeFileSync(join(many, 'blobs', `f-${i}.dat`), Buffer.alloc(3 * MB, i + 1))
    spy.reset()
    expect(await autoTrackLargeFiles(many, 1 * MB, { logger: quiet, cfg: null })).toBe(12)
    const manyCalls = spy.calls()
    expect(manyCalls.length).toBe(2)
    expect(manyCalls.filter((c) => c.startsWith('check-ignore')).length).toBe(1)
    expect(manyCalls.filter((c) => c.startsWith('check-attr')).length).toBe(1)
    // Every new path got a rule git actually applies.
    expect(git(many, 'check-attr', 'filter', '--', 'blobs/f-11.dat')).toBe('blobs/f-11.dat: filter: lfs')
    // …and it is idempotent: a second pass finds nothing new and spawns nothing.
    spy.reset()
    expect(await autoTrackLargeFiles(many, 1 * MB, { logger: quiet, cfg: null })).toBe(0)
    expect(spy.calls().length).toBe(2)
  }, 90_000)
})

describe('SHO-531 AC7 — a prod-shaped repo through 20 commits', () => {
  it('costs a bounded number of git processes per commit, and no prune scan', async () => {
    const spy = installGitSpy()
    cleanup.push(() => spy.restore())
    const { url, stored } = startFakeLfs()
    const dir = initRepo()
    const cfg = cfgFor(dir, url)

    // Deep history with big raw blobs at paths that are LFS-tracked now: the
    // exact shape that made `git log -G` and `cat-file --batch` expensive.
    mkdirSync(join(dir, 'media'), { recursive: true })
    mkdirSync(join(dir, 'src'), { recursive: true })
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(dir, 'src', `${i}.ts`), `export const v${i} = ${i}\n`)
      if (i % 10 === 0) writeFileSync(join(dir, 'media', `raw-${i}.dat`), Buffer.alloc(4 * MB, i))
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', `history ${i}`, '--no-verify')
    }
    writeManagedGitAttributes(dir, { pathRules: ['media'] })
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'track media', '--no-verify')

    process.env.SHOGO_LFS_BUDGET_GB = '0.0005' // force the eviction path
    try {
      const perCommit: number[] = []
      let pruneScans = 0
      for (let i = 0; i < 20; i++) {
        commitLfsFile(dir, `media/live-${i}.png`, 150_000, 100 + i, `live ${i}`)
        const oids = await lfsObjectsInRange(dir, null)
        for (const o of oids) stored.set(o.oid, o.size)
        spy.reset()
        await lfsPushIncremental(cfg, { tips: lfsPushedTips(dir), logger: quiet })
        const calls = spy.calls()
        perCommit.push(calls.length)
        pruneScans += calls.filter((c) => c.includes('-G') || c.startsWith('log ')).length
      }
      // No `git log -G` scan, in any commit.
      expect(pruneScans).toBe(0)
      // Every commit costs a bounded number of git invocations, and that bound
      // does not depend on how deep the history gets: the scan is `--not <the
      // pushed marker>`, so it walks one commit, not 46.
      expect(Math.max(...perCommit)).toBeLessThanOrEqual(12)
      // Later commits are no more expensive than earlier ones.
      const early = perCommit.slice(0, 5).reduce((a, b) => a + b, 0) / 5
      const late = perCommit.slice(-5).reduce((a, b) => a + b, 0) / 5
      expect(late).toBeLessThanOrEqual(early + 2)

      // And each push's rev-list is bounded by the marker.
      spy.reset()
      commitLfsFile(dir, 'media/final.png', 150_000, 500, 'final')
      await lfsPushIncremental(cfg, { tips: lfsPushedTips(dir), logger: quiet })
      const revList = spy.calls().find((c) => c.startsWith('rev-list'))
      expect(revList).toBeDefined()
      expect(revList!).toContain('--not ')
    } finally {
      delete process.env.SHOGO_LFS_BUDGET_GB
    }
  }, 300_000)
})

// QA round 1 on SHO-531: the gate used to open again whenever eviction *ran*,
// even when that pass freed nothing. On the production repo the store is one
// committed object set that HEAD references, so every pass is a no-op — and the
// tracker happily started adding to a store that can never shrink.
describe('SHO-531 QA round 1 — the over-budget gate is judged on the resulting size', () => {
  it('keeps tracking off when a pass runs but frees nothing', async () => {
    const { url } = startFakeLfs()
    const dir = initRepo()
    const cfg = cfgFor(dir, url)
    mkdirSync(join(dir, 'media'), { recursive: true })
    // Committed and HEAD-referenced: inside the keep set, so nothing to evict.
    commitLfsFile(dir, 'media/kept.png', 300_000, 7, 'kept')
    mkdirSync(join(dir, 'incoming'), { recursive: true })
    writeFileSync(join(dir, 'incoming', 'new.xyz'), Buffer.alloc(2 * MB, 9))

    process.env.SHOGO_LFS_BUDGET_GB = '0.0001' // ~107 KB against a ~293 KB store
    try {
      resetLfsStats()
      expect(await autoTrackLargeFiles(dir, 1 * MB, { logger: quiet, cfg })).toBe(0)
      // The scenario really is "eviction ran and freed nothing", not "it bailed".
      const stats = lfsStats()
      expect(stats.evictions).toBeGreaterThanOrEqual(1)
      expect(stats.evictedBytes).toBe(0)
      expect(readFileSync(join(dir, '.gitattributes'), 'utf-8')).not.toContain('incoming/')
    } finally {
      delete process.env.SHOGO_LFS_BUDGET_GB
    }
  }, 60_000)
})

// QA round 2 on SHO-531: ensureLfsRepoSetup ran on every git_only boot and
// called writeManagedGitAttributes with no pathRules, wiping any rules that
// autoTrackLargeFiles had just written into the managed block. The fix is to
// read the existing rules back and preserve them on the rewrite.
describe('SHO-531 QA round 2 — ensureLfsRepoSetup preserves auto-tracked path rules', () => {
  it('keeps an auto-tracked rule after a boot-time ensureLfsRepoSetup call', async () => {
    const { url } = startFakeLfs()
    const dir = initRepo()
    const cfg = cfgFor(dir, url)

    // Simulate what autoTrackLargeFiles does: add a custom path rule.
    writeManagedGitAttributes(dir, { pathRules: ['media/custom.xyz filter=lfs diff=lfs merge=lfs -text'] })
    expect(readManagedAttributePaths(dir)).toHaveLength(1)

    // Now simulate the boot path running.
    await ensureLfsRepoSetup(dir, { logger: quiet })

    // The rule must survive.
    const paths = readManagedAttributePaths(dir)
    expect(paths).toHaveLength(1)
    expect(paths[0]).toContain('media/custom.xyz')
  }, 30_000)
})
