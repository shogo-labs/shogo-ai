// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the pod-owned durable repo store (`repo-store.ts`) and the
 * commit-metadata gatherer (`checkpoint-record.ts`).
 *
 * Strategy:
 *   - The git/fs surface (seed, getHeadSha, createTagLocal, gatherCommitMeta)
 *     runs against a REAL temp git repo — no mocking, highest signal.
 *   - persist/restore is exercised end-to-end against an in-memory S3 mock
 *     (real `tar` + real `git reset --hard`), so we prove the tarball
 *     round-trips a working tree across two separate directories.
 */

import { describe, test, expect, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

// --- in-memory S3 mock (must be registered before importing repo-store) -----

const s3store = new Map<string, Buffer>()

mock.module('@aws-sdk/client-s3', () => {
  class PutObjectCommand { constructor(public input: any) {} }
  class GetObjectCommand { constructor(public input: any) {} }
  class HeadObjectCommand { constructor(public input: any) {} }
  class DeleteObjectCommand { constructor(public input: any) {} }
  class ListObjectsV2Command { constructor(public input: any) {} }
  class S3Client {
    constructor(public cfg: any) {}
    async send(cmd: any): Promise<any> {
      if (cmd instanceof PutObjectCommand) {
        const body = cmd.input.Body
        let buf: Buffer
        if (Buffer.isBuffer(body)) {
          // persistRepoToStore uploads a Buffer (streaming bodies hang under bun).
          buf = body
        } else {
          const chunks: Buffer[] = []
          for await (const c of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c))
          buf = Buffer.concat(chunks)
        }
        s3store.set(cmd.input.Key, buf)
        return {}
      }
      if (cmd instanceof HeadObjectCommand) {
        const v = s3store.get(cmd.input.Key)
        if (!v) throw new Error('NotFound')
        return { ETag: `"${v.length}"` }
      }
      if (cmd instanceof GetObjectCommand) {
        const v = s3store.get(cmd.input.Key)
        if (!v) throw new Error('NoSuchKey')
        return { Body: Readable.from(v) }
      }
      throw new Error(`unexpected command: ${cmd?.constructor?.name}`)
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command }
})

const {
  persistRepoToStore,
  restoreRepoFromStore,
  seedRepoIfAbsent,
  getHeadSha,
  createTagLocal,
} = await import('../repo-store')
const { gatherCommitMeta } = await import('../checkpoint-record')

const NOOP = { log: () => {}, warn: () => {}, error: () => {} }

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function gitInitWithCommit(dir: string, file = 'a.txt', contents = 'hello\n'): string {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'pipe' })
  writeFileSync(join(dir, file), contents)
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'init', '--no-verify'], { cwd: dir, stdio: 'pipe' })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim()
}

// ---------------------------------------------------------------------------

describe('seedRepoIfAbsent', () => {
  test('git inits + commits the on-disk tree when no .git exists', async () => {
    const dir = tmp('seed-')
    try {
      writeFileSync(join(dir, 'index.ts'), 'export const x = 1\n')
      const sha = await seedRepoIfAbsent(dir, { logger: NOOP })
      expect(sha).toBeTruthy()
      expect(existsSync(join(dir, '.git'))).toBe(true)
      // The seed commit is the current HEAD and tracks the file.
      expect(await getHeadSha(dir)).toBe(sha)
      const tracked = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf-8' })
      expect(tracked).toContain('index.ts')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('no-op (returns null) when .git already present', async () => {
    const dir = tmp('seed-existing-')
    try {
      gitInitWithCommit(dir)
      expect(await seedRepoIfAbsent(dir, { logger: NOOP })).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns null for an empty workspace (nothing to commit)', async () => {
    const dir = tmp('seed-empty-')
    try {
      expect(await seedRepoIfAbsent(dir, { logger: NOOP })).toBeNull()
      // repo is still initialized so the first edit can commit later.
      expect(existsSync(join(dir, '.git'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('getHeadSha', () => {
  test('returns null when not a git repo', async () => {
    const dir = tmp('headsha-')
    try {
      expect(await getHeadSha(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('createTagLocal', () => {
  test('creates an annotated tag at HEAD', async () => {
    const dir = tmp('tag-')
    try {
      const sha = gitInitWithCommit(dir)
      const tagged = await createTagLocal(dir, 'publish/demo/1700000000', { message: 'Published demo' })
      expect(tagged).toBe(sha)
      const tags = execFileSync('git', ['tag', '-l'], { cwd: dir, encoding: 'utf-8' })
      expect(tags).toContain('publish/demo/1700000000')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rejects an injection-y tag name', async () => {
    const dir = tmp('tag-bad-')
    try {
      gitInitWithCommit(dir)
      await expect(createTagLocal(dir, '--upload-pack=evil')).rejects.toThrow(/Invalid tag name/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('gatherCommitMeta', () => {
  test('reports message, branch, filesChanged and line counts', async () => {
    const dir = tmp('meta-')
    try {
      const sha = gitInitWithCommit(dir, 'f.txt', 'l1\nl2\nl3\n')
      const meta = await gatherCommitMeta(dir, sha)
      expect(meta).not.toBeNull()
      expect(meta!.sha).toBe(sha)
      expect(meta!.message).toBe('init')
      expect(meta!.branch).toBe('main')
      expect(meta!.filesChanged).toBe(1)
      expect(meta!.additions).toBe(3)
      expect(meta!.deletions).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('persist + restore round-trip (mocked S3, real tar/git)', () => {
  test('restores the working tree and HEAD into a fresh directory', async () => {
    s3store.clear()
    const src = tmp('persist-src-')
    const dst = tmp('persist-dst-')
    try {
      const sha = gitInitWithCommit(src, 'app.ts', 'console.log(1)\n')
      const cfg = { projectId: 'proj-rt', bucket: 'ws-bucket', logger: NOOP }

      const p = await persistRepoToStore(src, cfg)
      expect(p.ok).toBe(true)
      expect(p.changed).toBe(true)
      expect(s3store.has('proj-rt/repo.git.tar.gz')).toBe(true)

      // dst has no .git yet → restore extracts it and rebuilds the tree.
      const r = await restoreRepoFromStore(dst, cfg)
      expect(r.ok).toBe(true)
      expect(r.restored).toBe(true)
      expect(existsSync(join(dst, '.git'))).toBe(true)
      expect(await getHeadSha(dst)).toBe(sha)
      expect(existsSync(join(dst, 'app.ts'))).toBe(true)
      expect(readFileSync(join(dst, 'app.ts'), 'utf-8')).toBe('console.log(1)\n')
    } finally {
      rmSync(src, { recursive: true, force: true })
      rmSync(dst, { recursive: true, force: true })
    }
  })

  test('restore is a no-op when .git already present locally (warm reuse)', async () => {
    s3store.clear()
    const dir = tmp('persist-warm-')
    try {
      gitInitWithCommit(dir)
      const r = await restoreRepoFromStore(dir, { projectId: 'p', bucket: 'b', logger: NOOP })
      expect(r.restored).toBe(false)
      expect(r.reason).toBe('already-local')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('restore is a no-op when no durable object exists', async () => {
    s3store.clear()
    const dir = tmp('persist-none-')
    try {
      const r = await restoreRepoFromStore(dir, { projectId: 'missing', bucket: 'b', logger: NOOP })
      expect(r.restored).toBe(false)
      expect(r.reason).toBe('no-remote-repo')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Manifest-aware durable repo (incremental bundles). The pod reads the manifest
// first, never writes a tarball once one exists, and never falls back to a
// stale tarball when the manifest is unreadable.

describe('manifest-aware persist + restore (mocked S3, real git bundles)', () => {
  function publishBundleManifest(src: string, projectId: string): string {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: src, encoding: 'utf-8' }).trim()
    const bundlePath = join(tmpdir(), `${projectId}-${randomUUID()}.bundle`)
    execFileSync('git', ['bundle', 'create', bundlePath, '--all'], { cwd: src, stdio: 'pipe' })
    const body = readFileSync(bundlePath)
    const digest = createHash('sha256').update(body).digest('hex')
    s3store.set(`${projectId}/repo/bundles/${digest}.bundle`, body)
    const head = execFileSync('git', ['symbolic-ref', 'HEAD'], { cwd: src, encoding: 'utf-8' }).trim()
    const manifest = {
      v: 1,
      head: { ref: head },
      refs: { [head]: sha },
      config: readFileSync(join(src, '.git', 'config'), 'utf-8'),
      rootCommitAt: null,
      bundles: [{ sha256: digest, bytes: body.length, kind: 'base' }],
    }
    s3store.set(`${projectId}/repo/manifest.json`, Buffer.from(JSON.stringify(manifest)))
    rmSync(bundlePath, { force: true })
    return sha
  }

  test('persist refuses to write the tarball once a manifest exists', async () => {
    s3store.clear()
    const src = tmp('manifest-persist-src-')
    try {
      gitInitWithCommit(src, 'app.ts', 'v1\n')
      publishBundleManifest(src, 'proj-m')
      const before = s3store.get('proj-m/repo/manifest.json')!
      const p = await persistRepoToStore(src, { projectId: 'proj-m', bucket: 'b', logger: NOOP })
      expect(p.ok).toBe(false)
      expect(p.changed).toBe(false)
      expect(p.reason).toBe('repo-manifest-present')
      expect(s3store.has('proj-m/repo.git.tar.gz')).toBe(false)
      expect(s3store.get('proj-m/repo/manifest.json')!.equals(before)).toBe(true)
    } finally {
      rmSync(src, { recursive: true, force: true })
    }
  })

  test('restore rebuilds the repo from the manifest and its bundle', async () => {
    s3store.clear()
    const src = tmp('manifest-restore-src-')
    const dst = tmp('manifest-restore-dst-')
    try {
      const sha = gitInitWithCommit(src, 'app.ts', 'from bundle\n')
      publishBundleManifest(src, 'proj-b')
      const r = await restoreRepoFromStore(dst, { projectId: 'proj-b', bucket: 'b', logger: NOOP })
      expect(r.ok).toBe(true)
      expect(r.restored).toBe(true)
      expect(await getHeadSha(dst)).toBe(sha)
      expect(readFileSync(join(dst, 'app.ts'), 'utf-8')).toBe('from bundle\n')
      expect(existsSync(join(dst, '.repo-stage-'))).toBe(false)
    } finally {
      rmSync(src, { recursive: true, force: true })
      rmSync(dst, { recursive: true, force: true })
    }
  })

  test('the manifest wins over a stale tarball', async () => {
    s3store.clear()
    const old = tmp('manifest-stale-old-')
    const src = tmp('manifest-stale-new-')
    const dst = tmp('manifest-stale-dst-')
    try {
      gitInitWithCommit(old, 'app.ts', 'old\n')
      await persistRepoToStore(old, { projectId: 'proj-s', bucket: 'b', logger: NOOP })
      expect(s3store.has('proj-s/repo.git.tar.gz')).toBe(true)
      const sha = gitInitWithCommit(src, 'app.ts', 'new\n')
      publishBundleManifest(src, 'proj-s')
      const r = await restoreRepoFromStore(dst, { projectId: 'proj-s', bucket: 'b', logger: NOOP })
      expect(r.restored).toBe(true)
      expect(await getHeadSha(dst)).toBe(sha)
      expect(readFileSync(join(dst, 'app.ts'), 'utf-8')).toBe('new\n')
    } finally {
      rmSync(old, { recursive: true, force: true })
      rmSync(src, { recursive: true, force: true })
      rmSync(dst, { recursive: true, force: true })
    }
  })

  test('a corrupt bundle fails closed and leaves no .git behind', async () => {
    s3store.clear()
    const src = tmp('manifest-corrupt-src-')
    const dst = tmp('manifest-corrupt-dst-')
    try {
      gitInitWithCommit(src, 'app.ts', 'x\n')
      publishBundleManifest(src, 'proj-c')
      const digest = JSON.parse(s3store.get('proj-c/repo/manifest.json')!.toString()).bundles[0].sha256
      s3store.set(`proj-c/repo/bundles/${digest}.bundle`, Buffer.from('not a bundle'))
      const r = await restoreRepoFromStore(dst, { projectId: 'proj-c', bucket: 'b', logger: NOOP })
      expect(r.ok).toBe(false)
      expect(r.restored).toBe(false)
      expect(existsSync(join(dst, '.git'))).toBe(false)
    } finally {
      rmSync(src, { recursive: true, force: true })
      rmSync(dst, { recursive: true, force: true })
    }
  })

  test('an unreadable manifest fails closed instead of using the tarball', async () => {
    s3store.clear()
    const src = tmp('manifest-bad-src-')
    const dst = tmp('manifest-bad-dst-')
    try {
      gitInitWithCommit(src, 'app.ts', 'x\n')
      await persistRepoToStore(src, { projectId: 'proj-u', bucket: 'b', logger: NOOP })
      s3store.set('proj-u/repo/manifest.json', Buffer.from('{ not json'))
      const r = await restoreRepoFromStore(dst, { projectId: 'proj-u', bucket: 'b', logger: NOOP })
      expect(r.ok).toBe(false)
      expect(r.restored).toBe(false)
      expect(existsSync(join(dst, '.git'))).toBe(false)
    } finally {
      rmSync(src, { recursive: true, force: true })
      rmSync(dst, { recursive: true, force: true })
    }
  })
})
