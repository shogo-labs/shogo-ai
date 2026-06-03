// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the API-side hydrate-only repo store.
 *
 * Focus: the ETag-freshness contract. In the pod-owned model the pod
 * updates the durable object out-of-band, so a warm API pod must
 * re-hydrate when the object's ETag advances and otherwise serve its
 * local copy. We back the S3 client with an in-memory store (real `tar` +
 * real `git reset --hard`) so the tarball genuinely round-trips.
 */

import { describe, test, expect, beforeAll, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'

// In-memory object store keyed by S3 key → { body, etag }.
const objects = new Map<string, { body: Buffer; etag: string }>()

mock.module('@aws-sdk/client-s3', () => {
  class GetObjectCommand { constructor(public input: any) {} }
  class HeadObjectCommand { constructor(public input: any) {} }
  class S3Client {
    constructor(public cfg: any) {}
    async send(cmd: any): Promise<any> {
      if (cmd instanceof HeadObjectCommand) {
        const o = objects.get(cmd.input.Key)
        if (!o) throw new Error('NotFound')
        return { ETag: o.etag }
      }
      if (cmd instanceof GetObjectCommand) {
        const o = objects.get(cmd.input.Key)
        if (!o) throw new Error('NoSuchKey')
        return { Body: Readable.from(o.body) }
      }
      throw new Error(`unexpected command ${cmd?.constructor?.name}`)
    }
  }
  return { S3Client, GetObjectCommand, HeadObjectCommand }
})

const { hydrateRepo } = await import('../git-repo-store')

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Build a `.git` tarball buffer from a fresh repo containing `file`/`contents`. */
function makeRepoTarball(file: string, contents: string): { buf: Buffer; sha: string } {
  const repo = tmp('hydrate-src-')
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'pipe' })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo, stdio: 'pipe' })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo, stdio: 'pipe' })
    writeFileSync(join(repo, file), contents)
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'c', '--no-verify'], { cwd: repo, stdio: 'pipe' })
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()
    const tar = join(tmp('hydrate-tar-'), 't.tar.gz')
    execFileSync('tar', ['-czf', tar, '-C', repo, '.git'], { stdio: 'pipe' })
    return { buf: readFileSync(tar), sha }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

beforeAll(() => {
  process.env.S3_WORKSPACES_BUCKET = 'ws-bucket'
})

describe('hydrateRepo — no object storage configured', () => {
  test('returns no-object-storage when bucket unset', async () => {
    const saved = process.env.S3_WORKSPACES_BUCKET
    delete process.env.S3_WORKSPACES_BUCKET
    const dir = tmp('hydrate-nob-')
    try {
      const r = await hydrateRepo('p-nob', dir)
      expect(r.ok).toBe(true)
      expect(r.reason).toBe('no-object-storage')
    } finally {
      process.env.S3_WORKSPACES_BUCKET = saved
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('hydrateRepo — ETag freshness', () => {
  test('downloads on first hydrate, serves warm copy when ETag unchanged, re-hydrates when it advances', async () => {
    objects.clear()
    const projectId = 'p-fresh'
    const key = `${projectId}/repo.git.tar.gz`
    const dst = tmp('hydrate-dst-')
    try {
      // v1 in the store.
      const v1 = makeRepoTarball('app.ts', 'v1\n')
      objects.set(key, { body: v1.buf, etag: '"v1"' })

      // First hydrate → downloads + extracts.
      const r1 = await hydrateRepo(projectId, dst)
      expect(r1.changed).toBe(true)
      expect(existsSync(join(dst, '.git'))).toBe(true)
      expect(readFileSync(join(dst, 'app.ts'), 'utf-8')).toBe('v1\n')

      // Second hydrate, same ETag → warm reuse, no re-download.
      const r2 = await hydrateRepo(projectId, dst)
      expect(r2.changed).toBe(false)
      expect(r2.reason).toBe('already-local-fresh')

      // Advance the object (new ETag) → must re-hydrate the newer tree.
      const v2 = makeRepoTarball('app.ts', 'v2-updated\n')
      objects.set(key, { body: v2.buf, etag: '"v2"' })
      const r3 = await hydrateRepo(projectId, dst)
      expect(r3.changed).toBe(true)
      expect(readFileSync(join(dst, 'app.ts'), 'utf-8')).toBe('v2-updated\n')
    } finally {
      rmSync(dst, { recursive: true, force: true })
    }
  })

  test('no-remote-repo when the object is absent', async () => {
    objects.clear()
    const dir = tmp('hydrate-missing-')
    try {
      const r = await hydrateRepo('p-missing', dir)
      expect(r.ok).toBe(true)
      expect(r.reason).toBe('no-remote-repo')
      expect(existsSync(join(dir, '.git'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
