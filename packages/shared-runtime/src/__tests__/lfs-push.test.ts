// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The large-media-history regression (SHO-442).
 *
 * Nov 14: every repo save on a media-heavy cloud workspace failed with
 * `lfs-push-failed` and then "The operation timed out". `git lfs push --all`
 * walked every ref's whole history and batch-checked every object on every
 * save; the host gave up at 60 s, the guest kept uploading in the background,
 * and each retry started over. A week later the workspace lost its history.
 *
 * These tests run the real engine against a real repo and a real git-lfs
 * (3.8.0) talking to a fake batch API, so the behaviour under test is the
 * behaviour production gets:
 *   - only the oids the durable tips do not cover are pushed,
 *   - an object the server already has is not uploaded again,
 *   - an object missing on BOTH sides is named by path and never blocks the
 *     history from exporting.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'child_process'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync } from 'fs'

import {
  classifyLfsFailure,
  hasLocalLfsObject,
  lfsObjectsInRange,
  lfsPushIncremental,
  lfsRemoteConfigFromEnv,
  localLfsObjectPath,
  parseLfsPointer,
  writeManagedGitAttributes,
  type LfsRemoteConfig,
} from '../lfs'

const COMMITS = 50
const FILES_PER_COMMIT = 4
const LARGE_FILES = 3

interface FakeLfs {
  url: string
  stored: Map<string, number>
  batches: Array<{ operation: string; oids: string[] }>
  uploads: string[]
  has(oid: string): boolean
  forget(oid: string): void
  stop(): void
}

function startFakeLfs(): FakeLfs {
  const stored = new Map<string, number>()
  const batches: Array<{ operation: string; oids: string[] }> = []
  const uploads: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/objects/batch')) {
        const body: any = await req.json()
        batches.push({ operation: body.operation, oids: (body.objects ?? []).map((o: any) => o.oid) })
        return Response.json({
          transfer: 'basic',
          hash_algo: 'sha256',
          objects: (body.objects ?? []).map((o: any) => {
            // No actions == the server already has the bytes (real API's dedup).
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
        const oid = url.pathname.slice('/upload/'.length)
        stored.set(oid, (await req.arrayBuffer()).byteLength)
        uploads.push(oid)
        return new Response(null, { status: 200 })
      }
      if (url.pathname === '/verify') return new Response(null, { status: 200 })
      return new Response('not found', { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    stored,
    batches,
    uploads,
    has: (oid) => stored.has(oid),
    forget: (oid) => void stored.delete(oid),
    stop: () => server.stop(true),
  }
}

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c()
})

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Built once: 50 commits of media cost real git-lfs work, and every test gets a copy. */
let mediaTemplate: string | null = null
const templateDirs: string[] = []

/**
 * A media-heavy repo: 200 LFS objects spread over 50 commits, plus a few large
 * files (names encode the commit, so the commit -> object mapping is predictable).
 */
function makeMediaRepo(): { dir: string; lfs: FakeLfs; cfg: LfsRemoteConfig } {
  const dir = mkdtempSync(join(tmpdir(), 'lfs-media-'))
  const lfs = startFakeLfs()
  cleanup.push(() => lfs.stop(), () => rmSync(dir, { recursive: true, force: true }))
  cpSync(buildMediaTemplate(), dir, { recursive: true })

  const cfg = lfsRemoteConfigFromEnv(dir, { log() {}, warn() {}, error() {} } as any)
  if (!cfg) throw new Error('lfsRemoteConfigFromEnv returned null')
  cfg.cloudApiUrl = lfs.url
  return { dir, lfs, cfg }
}

function buildMediaTemplate(): string {
  if (mediaTemplate) return mediaTemplate
  // Removed in afterAll, not afterEach: every test copies it.
  const dir = mkdtempSync(join(tmpdir(), 'lfs-media-template-'))
  templateDirs.push(dir)
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['lfs', 'install', '--local', '--skip-smudge'])
  git(dir, ['config', 'user.email', 'Shogo Agent <agent@shogo.ai>'])
  git(dir, ['config', 'user.name', 'Shogo Agent'])
  writeManagedGitAttributes(dir)
  git(dir, ['add', '.gitattributes'])
  git(dir, ['commit', '-q', '-m', 'attributes'])

  mkdirSync(join(dir, 'media'), { recursive: true })
  for (let i = 0; i < COMMITS; i++) {
    for (let j = 0; j < FILES_PER_COMMIT; j++) {
      // Unique bytes per file: identical content would collapse to one oid.
      const body = Buffer.alloc(2048, 0)
      body.writeUInt32BE(i * 100 + j, 0)
      writeFileSync(join(dir, 'media', `img-${i}-${j}.png`), body)
    }
    if (i < LARGE_FILES) writeFileSync(join(dir, 'media', `master-${i}.mp4`), Buffer.alloc(512 * 1024, i + 1))
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', `media batch ${i}`])
  }
  mediaTemplate = dir
  return dir
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
  for (const d of templateDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Every oid the whole history references, with the paths each appears at. */
async function allObjects(dir: string) {
  return lfsObjectsInRange(dir, null)
}

describe('classifyLfsFailure', () => {
  it('names the reason the incident could not see', () => {
    expect(classifyLfsFailure('Unable to find source for object 5f70 (try running `git lfs fetch --all`)')).toBe('missing-objects')
    expect(classifyLfsFailure('Unable to stat local media path: stat /x/.git/lfs/objects/aa/bb/x: no such file or directory')).toBe('missing-objects')
    expect(classifyLfsFailure('batch response: HTTP 401: Unauthorized')).toBe('auth')
    expect(classifyLfsFailure('', 403)).toBe('auth')
    expect(classifyLfsFailure('batch response: context deadline exceeded')).toBe('timeout')
    expect(classifyLfsFailure('upload: SignatureDoesNotMatch — X-Amz-Signature mismatch')).toBe('presign')
    expect(classifyLfsFailure('dial tcp: lookup api.example: no such host (ECONNRESET)')).toBe('network')
    expect(classifyLfsFailure('something odd')).toBe('other')
  })
})

describe('parseLfsPointer', () => {
  it('accepts a pointer and rejects a pre-LFS binary file', () => {
    const oid = 'a'.repeat(64)
    expect(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 2048\n`)).toEqual({
      oid,
      size: 2048,
    })
    expect(parseLfsPointer('\x89PNG\r\n\x1a\n binary')).toBeNull()
    expect(parseLfsPointer('version https://git-lfs.github.com/spec/v1\noid sha256:short\nsize 1\n')).toBeNull()
  })
})

describe('lfsObjectsInRange', () => {
  it('finds every oid behind 50 commits of media, with its paths', async () => {
    const { dir } = makeMediaRepo()
    const all = await allObjects(dir)
    expect(all.length).toBe(COMMITS * FILES_PER_COMMIT + LARGE_FILES)
    const one = all.find((o) => o.paths.includes('media/img-0-0.png'))
    expect(one?.paths).toEqual(['media/img-0-0.png'])
    expect(one?.size).toBe(2048)
    const large = all.find((o) => o.paths.includes('media/master-0.mp4'))
    expect(large?.size).toBe(512 * 1024)
  }, 60_000)

  it('excludes what the durable tips already cover', async () => {
    const { dir } = makeMediaRepo()
    const tip = git(dir, ['rev-parse', 'HEAD']).trim()
    for (let i = 0; i < 2; i++) writeFileSync(join(dir, `late-${i}.png`), Buffer.alloc(1024, 200 + i))
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'late additions'])

    const incremental = await lfsObjectsInRange(dir, [tip])
    expect(incremental.map((o) => o.paths[0]).sort()).toEqual(['late-0.png', 'late-1.png'])
    // A base export still sees everything.
    expect((await lfsObjectsInRange(dir, null)).length).toBe(COMMITS * FILES_PER_COMMIT + LARGE_FILES + 2)
  }, 60_000)
})

describe('lfsPushIncremental', () => {
  it('pushes only the oids the tips do not cover, then nothing at all', async () => {
    const { dir, lfs, cfg } = makeMediaRepo()
    const tip = git(dir, ['rev-parse', 'HEAD']).trim()
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, `new-${i}.png`), Buffer.alloc(1024, 90 + i))
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'new media'])

    const first = await lfsPushIncremental(cfg, { tips: [tip] })
    expect(first.total).toBe(3)
    expect(first.pushed).toBe(3)
    expect(first.missing).toEqual([])
    expect(first.skipped).toBe(0)
    // The whole 200-object history was not walked: one batch, three oids.
    expect(lfs.batches).toHaveLength(1)
    expect(lfs.batches[0].oids).toHaveLength(3)
    expect(lfs.uploads).toHaveLength(3)

    // Nothing new since those tips -> nothing pushed, no batch call.
    lfs.batches.length = 0
    const second = await lfsPushIncremental(cfg, { tips: [git(dir, ['rev-parse', 'HEAD']).trim()] })
    expect(second).toMatchObject({ total: 0, pushed: 0 })
    expect(lfs.batches).toHaveLength(0)
  }, 60_000)

  it('does not re-upload objects the server already has (cold boot after a prune)', async () => {
    const { dir, lfs, cfg } = makeMediaRepo()
    const all = await allObjects(dir)
    // The durable repo already holds every object.
    for (const o of all) lfs.stored.set(o.oid, o.size)
    // Cold boot: only the objects the newest commit introduced were pulled
    // (`lfsPull` fetches HEAD's tree). Everything older is gone locally.
    const headPaths = new Set(
      git(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])
        .trim()
        .split('\n')
        .filter(Boolean),
    )
    const headObjects = all.filter((o) => o.paths.some((p) => headPaths.has(p)))
    expect(headObjects.length).toBeGreaterThan(0)
    for (const o of all) {
      if (headObjects.includes(o)) continue
      const p = localLfsObjectPath(dir, o.oid)
      if (p) rmSync(p, { force: true })
    }
    for (const o of headObjects) expect(hasLocalLfsObject(dir, o.oid)).toBe(true)
    expect(hasLocalLfsObject(dir, all.find((o) => o.paths[0] === 'media/img-0-0.png')!.oid)).toBe(false)

    const result = await lfsPushIncremental(cfg, { tips: null })
    expect(result.missing).toEqual([])
    expect(result.skipped).toBe(all.length - headObjects.length)
    expect(result.pushed).toBe(headObjects.length)
    // The server already held every byte, so git-lfs's own dedup moved none.
    expect(lfs.uploads).toEqual([])
  }, 90_000)

  it('names an object missing on both sides, keeps its paths, and still returns the history', async () => {
    const { dir, lfs, cfg } = makeMediaRepo()
    const all = await allObjects(dir)
    const victim = all.find((o) => o.paths[0] === 'media/master-1.mp4')!
    // Lost locally and never uploaded.
    const p = localLfsObjectPath(dir, victim.oid)!
    rmSync(p, { force: true })
    expect(lfs.has(victim.oid)).toBe(false)

    const result = await lfsPushIncremental(cfg, { tips: null })
    expect(result.missing).toHaveLength(1)
    expect(result.missing[0]).toEqual({ oid: victim.oid, paths: ['media/master-1.mp4'] })
    // Everything else still went up.
    expect(result.pushed).toBe(all.length - 1)
    // And the history is still walkable: the pointer is intact in the commit DAG.
    expect((await allObjects(dir)).map((o) => o.oid)).toContain(victim.oid)
  }, 90_000)

  it('surfaces a batch-API auth failure with its reason and the server text', async () => {
    const { dir, cfg } = makeMediaRepo()
    const cfgAuth = { ...cfg, runtimeAuthSecret: 'wrong' }
    const broken = Bun.serve({ port: 0, fetch: () => Response.json({ message: 'Bad credentials' }, { status: 401 }) })
    cleanup.push(() => broken.stop(true))
    cfgAuth.cloudApiUrl = `http://127.0.0.1:${broken.port}`

    const all = await allObjects(dir)
    for (const o of all) {
      const p = localLfsObjectPath(dir, o.oid)
      if (p) rmSync(p, { force: true })
    }
    const err = await lfsPushIncremental(cfgAuth, { tips: null }).catch((e) => e)
    expect(err?.reason).toBe('auth')
    expect(String(err?.stderr)).toContain('Bad credentials')
  }, 90_000)
})

describe('the incident timeline in miniature', () => {
  it('a save on a 200-object history finishes well inside a 60 s host budget', async () => {
    const { dir, cfg } = makeMediaRepo()
    writeFileSync(join(dir, 'one-more.png'), Buffer.alloc(1024, 3))
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'one more'])
    const tip = git(dir, ['rev-parse', 'HEAD~1']).trim()
    const t0 = Date.now()
    await lfsPushIncremental(cfg, { tips: [tip] })
    const ms = Date.now() - t0
    // The old `push --all` walked all 203 objects here; this walks one.
    expect(ms).toBeLessThan(30_000)
    expect(existsSync(join(dir, '.git'))).toBe(true)
  }, 60_000)
})
