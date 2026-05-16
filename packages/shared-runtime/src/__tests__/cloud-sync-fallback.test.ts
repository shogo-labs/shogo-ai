// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration-style test for the failure-isolation contract between
 * `GitWorkspaceSync` and `S3Sync`.
 *
 * The agent-runtime in `git_only` mode wires:
 *   - GitWorkspaceSync.onDegrade   -> S3Sync.setSuppressProjectArchive(false)
 *   - GitWorkspaceSync.onRecovered -> S3Sync.setSuppressProjectArchive(true)
 * (see `packages/agent-runtime/src/server.ts`).
 *
 * This test mirrors that wiring and asserts the contract:
 *   1. In healthy `git_only`, S3 Layer 2 is suppressed (no PUT for
 *      project-src.tar.gz on `uploadAll`).
 *   2. After 3 consecutive push failures, S3 Layer 2 re-engages and
 *      subsequent `uploadAll` calls write the tarball to S3.
 *   3. After a recovery push, S3 Layer 2 is re-suppressed.
 *   4. `flushAndShutdown({ forceProjectArchive: true })` always lands a
 *      tarball regardless of degraded state — the cold-start snapshot
 *      contract.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// ---------------------------------------------------------------------------
// Reuse the S3 mock approach from s3-sync.test.ts (compact copy).
// ---------------------------------------------------------------------------

const s3Store = new Map<string, Buffer>()

class StubS3Error extends Error {
  $metadata: Record<string, any>
  constructor(name: string, statusCode: number) {
    super(name)
    this.name = name
    this.$metadata = { httpStatusCode: statusCode }
  }
}

class MockS3Client {
  constructor(_opts: any) { }
  async send(cmd: any): Promise<any> {
    const { __type, Bucket, Key, Body } = cmd
    switch (__type) {
      case 'HeadObject':
        if (!s3Store.has(`${Bucket}/${Key}`)) throw new StubS3Error('NotFound', 404)
        return {}
      case 'GetObject': {
        const v = s3Store.get(`${Bucket}/${Key}`)
        if (!v) throw new StubS3Error('NoSuchKey', 404)
        return {
          ContentLength: v.length,
          Body: {
            transformToByteArray: async () => v,
            transformToString: async () => v.toString('utf-8'),
          },
        }
      }
      case 'PutObject': {
        const buf = Buffer.isBuffer(Body)
          ? Body
          : typeof Body === 'string'
            ? Buffer.from(Body)
            : Buffer.from(Body)
        s3Store.set(`${Bucket}/${Key}`, buf)
        return {}
      }
      default:
        throw new Error(`MockS3Client: unhandled ${__type}`)
    }
  }
}

mock.module('@aws-sdk/client-s3', () => ({
  S3Client: MockS3Client,
  HeadObjectCommand: class { constructor(o: any) { Object.assign(this, o, { __type: 'HeadObject' }) } },
  GetObjectCommand: class { constructor(o: any) { Object.assign(this, o, { __type: 'GetObject' }) } },
  PutObjectCommand: class { constructor(o: any) { Object.assign(this, o, { __type: 'PutObject' }) } },
}))

import { S3Sync } from '../s3-sync'
import { GitWorkspaceSync, type SpawnGitFn } from '../git-sync'

// ---------------------------------------------------------------------------
// Per-test scratch
// ---------------------------------------------------------------------------

let TEST_DIR: string

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `cloud-sync-fallback-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(TEST_DIR, { recursive: true })
  writeFileSync(join(TEST_DIR, 'main.ts'), 'export const main = 1\n')
  s3Store.clear()
})

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

const PROJECT_KEY = 'test-bucket/proj-X/project-src.tar.gz'

function mkS3(opts: { suppress: boolean }) {
  return new S3Sync({
    bucket: 'test-bucket',
    prefix: 'proj-X',
    localDir: TEST_DIR,
    syncInterval: 0,
    watchEnabled: false,
    suppressProjectArchive: opts.suppress,
  })
}

// Build a Git fake whose pushes ALWAYS fail.
function alwaysFailingSpawn(): SpawnGitFn {
  return async (args) => {
    if (args.includes('push')) {
      return { exitCode: 128, stdout: '', stderr: 'fatal: unable to push' }
    }
    if (args.includes('diff')) {
      return { exitCode: 1, stdout: '', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

// Build a Git fake that fails the first N pushes then succeeds.
function flakySpawn(failCount: number): SpawnGitFn {
  let failures = 0
  return async (args) => {
    if (args.includes('push')) {
      if (failures < failCount) {
        failures++
        return { exitCode: 128, stdout: '', stderr: 'fatal: temporary' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (args.includes('diff')) {
      return { exitCode: 1, stdout: '', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

function wireGitOnly(s3: S3Sync, spawnGit: SpawnGitFn): GitWorkspaceSync {
  // Mirrors the wiring in packages/agent-runtime/src/server.ts for git_only mode.
  return new GitWorkspaceSync({
    workspaceDir: TEST_DIR,
    cloudApiUrl: 'http://api.test',
    runtimeAuthSecret: 's',
    projectId: 'proj-X',
    debounceMs: 5,
    degradeAfterFailures: 3,
    onDegrade: () => { s3.setSuppressProjectArchive(false) },
    onRecovered: () => { s3.setSuppressProjectArchive(true) },
    spawnGit,
    logger: { log: () => { }, warn: () => { }, error: () => { } },
  })
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cloud-sync fallback (git_only ↔ S3 degrade contract)', () => {
  test('healthy git_only: S3 Layer 2 is suppressed; uploadAll does not write project-src.tar.gz', async () => {
    const s3 = mkS3({ suppress: true })
    await s3.uploadAll(false)
    expect(s3Store.has(PROJECT_KEY)).toBe(false)
    expect(s3.isProjectArchiveSuppressed()).toBe(true)
  })

  test('after 3 consecutive push failures, S3 Layer 2 re-engages and a subsequent uploadAll writes the tarball', async () => {
    const s3 = mkS3({ suppress: true })
    const git = wireGitOnly(s3, alwaysFailingSpawn())

    for (let i = 0; i < 3; i++) {
      git.triggerSync(true)
      await wait(30)
    }

    expect(git.isDegraded).toBe(true)
    expect(s3.isProjectArchiveSuppressed()).toBe(false)

    await s3.uploadAll(false)
    expect(s3Store.has(PROJECT_KEY)).toBe(true)
  })

  test('on first successful push after degrade, S3 Layer 2 is re-suppressed', async () => {
    const s3 = mkS3({ suppress: true })
    const git = wireGitOnly(s3, flakySpawn(3))

    for (let i = 0; i < 3; i++) {
      git.triggerSync(true)
      await wait(30)
    }
    expect(s3.isProjectArchiveSuppressed()).toBe(false)
    expect(git.isDegraded).toBe(true)

    // Manually clear any pending backoff retry so the next trigger gets
    // the recovery push immediately.
    git.triggerSync(true)
    await wait(60)

    expect(git.isDegraded).toBe(false)
    expect(s3.isProjectArchiveSuppressed()).toBe(true)
  })

  test('eviction always lands a tarball — flushAndShutdown({ forceProjectArchive: true })', async () => {
    const s3 = mkS3({ suppress: true })
    expect(s3Store.has(PROJECT_KEY)).toBe(false)
    // forceProjectArchive bypasses the suppress flag and the
    // no-pending-changes early-return.
    await s3.flushAndShutdown({ timeoutMs: 5000, forceProjectArchive: true })
    expect(s3Store.has(PROJECT_KEY)).toBe(true)
  })

  test('eviction during degraded state still lands a tarball (S3 is the durability fallback)', async () => {
    const s3 = mkS3({ suppress: true })
    const git = wireGitOnly(s3, alwaysFailingSpawn())

    for (let i = 0; i < 3; i++) {
      git.triggerSync(true)
      await wait(30)
    }
    expect(git.isDegraded).toBe(true)
    expect(s3.isProjectArchiveSuppressed()).toBe(false)

    // Simulate the runtime's shutdown path: git flush first (fails),
    // then S3 forced-write.
    await git.flushAndShutdown(100)
    await s3.flushAndShutdown({ timeoutMs: 5000, forceProjectArchive: true })
    expect(s3Store.has(PROJECT_KEY)).toBe(true)
  })
})
