// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-540 acceptance — the host's repo export must recover by itself.
 *
 * `/pool/export-repo-bundle` does exactly this, in this order:
 *   1. `awaitLfsPush(dir, union(since, marker), waitMs)` → `LfsPushRunner.run`
 *      + `settle`. A failure here was the 503 the host retried forever.
 *   2. `buildRepoBundle(dir, { previous: since })` → the bundle the host stores.
 * The unit tests cover each half; this one drives the sequence the way the
 * route does, against a real repo and a real git-lfs talking to a fake batch
 * API, and asserts the host-visible outcome: the push settles `done` instead of
 * dying with `fatal: bad object`, and the bundle the host receives still
 * restores to what the guest had.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  lfsPushedTips,
  lfsRemoteConfigFromEnv,
  lfsStats,
  LfsPushRunner,
  writeManagedGitAttributes,
  type LfsRemoteConfig,
  type LfsPushJob,
} from '../lfs'
import {
  buildRepoBundle,
  materializeRepoFromBundles,
  parseRepoManifest,
  readRepoSnapshotFields,
  REPO_MANIFEST_VERSION,
  type BuiltBundle,
} from '../repo-bundles'

const COMMITS = 6
const FILES_PER_COMMIT = 2

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Shogo Agent',
  GIT_AUTHOR_EMAIL: 'agent@shogo.ai',
  GIT_COMMITTER_NAME: 'Shogo Agent',
  GIT_COMMITTER_EMAIL: 'agent@shogo.ai',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
}

/** The API side of an LFS push: batch-check dedup, upload, verify. */
function startFakeLfs() {
  const stored = new Set<string>()
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/objects/batch')) {
        const body: any = await req.json()
        return Response.json({
          transfer: 'basic',
          hash_algo: 'sha256',
          objects: (body.objects ?? []).map((o: any) => {
            // No actions == the server already has the bytes (the real dedup).
            if (stored.has(o.oid)) return { oid: o.oid, size: o.size, authenticated: true }
            return {
              oid: o.oid,
              size: o.size,
              authenticated: true,
              actions: {
                upload: { href: `http://127.0.0.1:${server.port}/upload/${o.oid}`, expires_in: 600 },
                verify: { href: `http://127.0.0.1:${server.port}/verify`, expires_in: 600 },
              },
            }
          }),
        })
      }
      if (url.pathname.startsWith('/upload/')) {
        stored.add(url.pathname.slice('/upload/'.length))
        return new Response(null, { status: 200 })
      }
      if (url.pathname === '/verify') return new Response(null, { status: 200 })
      return new Response('not found', { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stored, stop: () => server.stop(true) }
}

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c()
})

/** Built once: every test copies it, so the media history costs git-lfs work once. */
let mediaTemplate: string | null = null
const templateDirs: string[] = []

function buildTemplate(): string {
  if (mediaTemplate) return mediaTemplate
  const dir = mkdtempSync(join(tmpdir(), 'sho540-template-'))
  templateDirs.push(dir)
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['lfs', 'install', '--local', '--skip-smudge'])
  writeManagedGitAttributes(dir)
  git(dir, ['add', '.gitattributes'])
  git(dir, ['commit', '-q', '-m', 'attributes'])
  mkdirSync(join(dir, 'media'), { recursive: true })
  for (let i = 0; i < COMMITS; i++) {
    for (let j = 0; j < FILES_PER_COMMIT; j++) {
      const body = Buffer.alloc(4096, 0)
      body.writeUInt32BE(i * 100 + j, 0)
      writeFileSync(join(dir, 'media', `img-${i}-${j}.png`), body)
    }
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', `media batch ${i}`])
  }
  mediaTemplate = dir
  return dir
}

function makeRepo(): { dir: string; work: string; cfg: LfsRemoteConfig; lfs: ReturnType<typeof startFakeLfs> } {
  const root = mkdtempSync(join(tmpdir(), 'sho540-repo-'))
  const dir = join(root, 'work')
  const work = join(root, 'bundles')
  const lfs = startFakeLfs()
  cleanup.push(() => lfs.stop(), () => rmSync(root, { recursive: true, force: true }))
  cpSync(buildTemplate(), dir, { recursive: true })
  mkdirSync(work, { recursive: true })
  const cfg = lfsRemoteConfigFromEnv(dir, { log() {}, warn() {}, error() {} } as any)
  if (!cfg) throw new Error('lfsRemoteConfigFromEnv returned null')
  cfg.cloudApiUrl = lfs.url
  return { dir, work, cfg, lfs }
}

const quietRunner = () => new LfsPushRunner({ logger: { log() {}, warn() {}, error() {} } as any })

/**
 * A commit the repo really no longer holds: made, then rolled back and gc'd.
 * `git cat-file -e` must report it missing, so the range base under test is the
 * production failure and not an invented sha.
 */
function gcOneCommit(dir: string): string {
  const start = git(dir, ['rev-parse', 'HEAD']).trim()
  writeFileSync(join(dir, 'media', 'throwaway.png'), Buffer.alloc(2048, 7))
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'a commit that gets gc-ed'])
  const gone = git(dir, ['rev-parse', 'HEAD']).trim()
  git(dir, ['reset', '--hard', start])
  git(dir, ['reflog', 'expire', '--expire=now', '--all'])
  git(dir, ['gc', '--prune=now', '--quiet'])
  expect(() => git(dir, ['cat-file', '-e', gone])).toThrow()
  return gone
}

function addMediaCommit(dir: string, name: string): string {
  writeFileSync(join(dir, 'media', name), Buffer.alloc(4096, 21))
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', name])
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

async function settleDone(runner: LfsPushRunner, job: LfsPushJob): Promise<void> {
  expect(await runner.settle(job, 120_000)).toBe('done')
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
afterAll(() => {
  restoreEnv()
  for (const d of templateDirs) rmSync(d, { recursive: true, force: true })
})

describe('the export the host retried forever (SHO-540)', () => {
  test('a `since` full of gone commits still exports, and the bundle it produces restores', async () => {
    const { dir, work, cfg, lfs } = makeRepo()
    const runner = quietRunner()

    // The first export: a full base, and the push records its marker.
    await settleDone(runner, await runner.run(cfg, null))
    const firstFields = await readRepoSnapshotFields(dir)
    const firstBundle = await buildRepoBundle(dir, { previous: null, workDir: work })
    expect(firstBundle?.entry.kind).toBe('base')

    // Work continues, then the history is rewritten behind the host's back —
    // the state that produced `fatal: bad object 754b54bc…` on every retry.
    const afterRewrite = addMediaCommit(dir, 'after-rewrite.png')
    const gone = gcOneCommit(dir)
    const fields = await readRepoSnapshotFields(dir)

    // The host's manifest refs: the first export's tips, one of them gone now.
    const since = [...Object.values(firstFields.refs), gone]
    const before = lfsStats().unknownTips

    // 1. The push the route awaits. On origin/main this throws
    //    `LfsPushError('other')` → the deterministic 503.
    const base = [...new Set([...since, ...(lfsPushedTips(dir) ?? [])])]
    const job = await runner.run(cfg, base)
    await settleDone(runner, job)
    expect(job.state.missing).toEqual([])
    expect(lfsStats().unknownTips).toBeGreaterThanOrEqual(before + 1)
    expect(lfsPushedTips(dir)).toEqual([afterRewrite])

    // 2. The bundle the host stores, from that same `since`.
    const built = await buildRepoBundle(dir, { previous: since, workDir: work })
    expect(built).not.toBeNull()
    // A previous tip is gone, so the chain restarts at a full base needing no
    // prerequisites — the rule `buildRepoBundle` already had.
    expect(built!.entry.kind).toBe('base')

    // 3. That bundle must restore to what the guest had, or the VM is durable
    //    in name only.
    const manifest = parseRepoManifest({
      v: REPO_MANIFEST_VERSION,
      head: fields.head,
      refs: fields.refs,
      config: fields.config,
      rootCommitAt: null,
      bundles: [built!.entry],
    })
    const restored = join(mkdtempSync(join(tmpdir(), 'sho540-restore-')), 'out')
    cleanup.push(() => rmSync(join(restored, '..'), { recursive: true, force: true }))
    await materializeRepoFromBundles(restored, manifest, async () => (built as BuiltBundle).path)
    expect(git(restored, ['rev-parse', 'HEAD']).trim()).toBe(afterRewrite)
    // The media file came across as an LFS pointer whose bytes the server holds
    // (the push that just settled `done`), not as a placeholder nobody can fill.
    const pointer = git(restored, ['cat-file', '-p', 'HEAD:media/after-rewrite.png'])
    const oid = /oid sha256:([0-9a-f]{64})/.exec(pointer)?.[1]
    expect(oid).toBeTruthy()
    expect(lfs.stored.has(oid!)).toBe(true)

    // 4. The host's retry on its backoff is already satisfied: same tips, same
    //    HEAD, so it settles `done` without a second walk or a second upload.
    const again = await runner.run(cfg, base)
    await settleDone(runner, again)
    expect(again.state.pushed).toBe(0)
  }, 180_000)

  test('with no marker either, the walk covers everything and the export still finishes', async () => {
    const { dir, cfg } = makeRepo()
    const runner = quietRunner()

    // No push has run here, so there is no marker: every named tip is unknown
    // and the only safe base is a full scan.
    expect(lfsPushedTips(dir)).toBeNull()
    const gone = gcOneCommit(dir)
    const before = lfsStats().unknownTips

    const job = await runner.run(cfg, [gone])
    await settleDone(runner, job)
    expect(job.state.missing).toEqual([])
    expect(job.state.pushed).toBe(COMMITS * FILES_PER_COMMIT)
    expect(lfsStats().unknownTips).toBeGreaterThanOrEqual(before + 1)
    expect(lfsPushedTips(dir)).toEqual([git(dir, ['rev-parse', 'HEAD']).trim()])
  }, 180_000)
})
