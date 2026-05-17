// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for `services/marketplace-snapshot-storage.service.ts`.
 *
 * Strategy:
 *   - Run against a real on-disk workspace under a tmp `WORKSPACES_DIR`
 *     so the tar/extract code paths exercise actual gzipped tarballs.
 *   - Replace the S3 client with an in-memory stub (`_setClientForTests`)
 *     so we never touch a real bucket. The stub records every Put/Get/
 *     Delete call so tests can assert on key shape, body bytes, and
 *     metadata.
 *
 * What we cover:
 *   - `uploadProjectSnapshot`: keys are
 *     `marketplace/listings/<listingId>/<version>.tar.gz`, returns
 *     deterministic checksum, fails clearly when the workspace dir is
 *     missing.
 *   - `extractSnapshotToProject`: round-trips through the in-memory
 *     bucket and lays files down in the dest workspace, refuses to
 *     extract when the checksum doesn't match.
 *   - `loadSnapshotFiles`: returns the same file map shape the audit
 *     service consumes, with binaries as base64 wrappers.
 *   - `deleteSnapshot`: dispatches the right command.
 *   - Excluded segments (`node_modules`, `.git`, `dist`, `bun.lock`,
 *     `.install-*`) never appear in either the upload or the extract.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'

import {
  _resetClientForTests,
  _setClientForTests,
  deleteSnapshot,
  extractSnapshotToProject,
  loadSnapshotFiles,
  snapshotObjectKey,
  uploadProjectSnapshot,
} from '../services/marketplace-snapshot-storage.service'

// ─── In-memory S3 stub ───────────────────────────────────────────

interface CapturedCall {
  cmd: string
  Bucket?: string
  Key?: string
  Body?: Buffer
  Metadata?: Record<string, string>
}

let calls: CapturedCall[]
let storedObjects: Map<string, Buffer>

function makeStubClient(): any {
  return {
    send: async (cmd: any) => {
      const name = cmd?.constructor?.name ?? 'unknown'
      const input = cmd.input ?? {}
      calls.push({
        cmd: name,
        Bucket: input.Bucket,
        Key: input.Key,
        Body: input.Body,
        Metadata: input.Metadata,
      })
      switch (name) {
        case 'PutObjectCommand': {
          if (input.Body instanceof Buffer) {
            storedObjects.set(input.Key, input.Body)
          }
          return {}
        }
        case 'GetObjectCommand': {
          const buf = storedObjects.get(input.Key)
          if (!buf) {
            const err = new Error('NoSuchKey')
            ;(err as any).Code = 'NoSuchKey'
            throw err
          }
          return { Body: Readable.from([buf]) }
        }
        case 'DeleteObjectCommand': {
          storedObjects.delete(input.Key)
          return {}
        }
        default:
          throw new Error(`unhandled command: ${name}`)
      }
    },
  }
}

// ─── tmp workspace setup ─────────────────────────────────────────

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'snap-store-test-'))
  process.env.WORKSPACES_DIR = tmpRoot
  process.env.S3_WORKSPACES_BUCKET = 'test-bucket'
  calls = []
  storedObjects = new Map()
  _setClientForTests(makeStubClient())
})

afterEach(() => {
  delete process.env.WORKSPACES_DIR
  delete process.env.S3_WORKSPACES_BUCKET
  _setClientForTests(null)
  _resetClientForTests()
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

function makeProject(id: string, files: Record<string, string | Buffer>): string {
  const root = join(tmpRoot, id)
  mkdirSync(root, { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body as Buffer | string)
  }
  return root
}

// ─── snapshotObjectKey ──────────────────────────────────────────

describe('snapshotObjectKey', () => {
  test('encodes listingId and version into a stable path', () => {
    expect(snapshotObjectKey('lst_1', '1.0.0')).toBe(
      'marketplace/listings/lst_1/1.0.0.tar.gz',
    )
  })
  test('url-escapes weird characters but leaves common ones alone', () => {
    expect(snapshotObjectKey('lst-abc_123', '2.1.0-rc.1')).toBe(
      'marketplace/listings/lst-abc_123/2.1.0-rc.1.tar.gz',
    )
    expect(snapshotObjectKey('lst', '2/0')).toBe(
      'marketplace/listings/lst/2%2F0.tar.gz',
    )
  })
})

// ─── uploadProjectSnapshot ──────────────────────────────────────

describe('uploadProjectSnapshot', () => {
  test('throws workspace_missing for missing project dir', async () => {
    await expect(uploadProjectSnapshot('does-not-exist', 'lst', '1.0.0')).rejects.toThrow(
      'workspace_missing',
    )
  })

  test('uploads tarball with correct key + bucket + sha256 checksum', async () => {
    makeProject('p1', {
      'src/index.ts': 'export const x = 1',
      'README.md': '# hi',
    })
    const result = await uploadProjectSnapshot('p1', 'lst_42', '1.0.0')
    expect(result.key).toBe('marketplace/listings/lst_42/1.0.0.tar.gz')
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/)
    const put = calls.find((c) => c.cmd === 'PutObjectCommand')
    expect(put).toBeTruthy()
    expect(put?.Bucket).toBe('test-bucket')
    expect(put?.Key).toBe(result.key)
    expect(put?.Metadata).toEqual({ listing: 'lst_42', version: '1.0.0' })
  })

  test('omits excluded segments from the tarball', async () => {
    makeProject('p2', {
      'src/keep.ts': 'kept',
      'node_modules/leak.js': 'should not ship',
      '.git/HEAD': 'ref:',
      'dist/build.js': 'compiled',
      'bun.lock': '...',
      '.install-foo/x.txt': 'sentinel',
    })
    await uploadProjectSnapshot('p2', 'lst', '1.0.0')

    // Round-trip: extract back into a fresh project and inspect the
    // resulting tree. This catches both create-time and extract-time
    // exclusion paths.
    await extractSnapshotToProject(
      snapshotObjectKey('lst', '1.0.0'),
      'p2-extracted',
    )
    const extractRoot = join(tmpRoot, 'p2-extracted')
    expect(existsSync(join(extractRoot, 'src/keep.ts'))).toBe(true)
    expect(existsSync(join(extractRoot, 'node_modules/leak.js'))).toBe(false)
    expect(existsSync(join(extractRoot, '.git/HEAD'))).toBe(false)
    expect(existsSync(join(extractRoot, 'dist/build.js'))).toBe(false)
    expect(existsSync(join(extractRoot, 'bun.lock'))).toBe(false)
    expect(existsSync(join(extractRoot, '.install-foo/x.txt'))).toBe(false)
  })
})

// ─── extractSnapshotToProject ───────────────────────────────────

describe('extractSnapshotToProject', () => {
  test('lays files down in the dest workspace, creating dest dir as needed', async () => {
    makeProject('src', {
      'a.txt': 'alpha',
      'sub/b.txt': 'beta',
    })
    const { key } = await uploadProjectSnapshot('src', 'lst', '1.0.0')
    await extractSnapshotToProject(key, 'dest1')
    const root = join(tmpRoot, 'dest1')
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('alpha')
    expect(readFileSync(join(root, 'sub/b.txt'), 'utf8')).toBe('beta')
  })

  test('checksum mismatch refuses extraction', async () => {
    makeProject('src', { 'a.txt': 'alpha' })
    const { key } = await uploadProjectSnapshot('src', 'lst', '1.0.0')
    await expect(
      extractSnapshotToProject(key, 'dest', { expectedChecksum: 'deadbeef' }),
    ).rejects.toThrow('snapshot_checksum_mismatch')
  })

  test('honors the upload checksum when passed back through', async () => {
    makeProject('src', { 'a.txt': 'alpha' })
    const { key, checksum } = await uploadProjectSnapshot('src', 'lst', '1.0.0')
    await extractSnapshotToProject(key, 'dest', { expectedChecksum: checksum })
    expect(readFileSync(join(tmpRoot, 'dest/a.txt'), 'utf8')).toBe('alpha')
  })
})

// ─── loadSnapshotFiles ─────────────────────────────────────────

describe('loadSnapshotFiles', () => {
  test('returns utf8 strings for text files and base64 wrappers for binaries', async () => {
    makeProject('src', {
      'src/text.ts': 'export const x = 1',
      'src/bin.png': Buffer.from([0x89, 0x50, 0x00, 0x0a, 0x1a, 0x0a]),
    })
    const { key } = await uploadProjectSnapshot('src', 'lst', '1.0.0')
    const files = await loadSnapshotFiles(key)
    expect(files['src/text.ts']).toBe('export const x = 1')
    expect(typeof files['src/bin.png']).toBe('object')
    expect((files['src/bin.png'] as { encoding: string }).encoding).toBe('base64')
  })
})

// ─── deleteSnapshot ────────────────────────────────────────────

describe('deleteSnapshot', () => {
  test('dispatches DeleteObjectCommand with the key', async () => {
    makeProject('src', { 'a.txt': 'alpha' })
    const { key } = await uploadProjectSnapshot('src', 'lst', '1.0.0')
    expect(storedObjects.has(key)).toBe(true)
    await deleteSnapshot(key)
    expect(storedObjects.has(key)).toBe(false)
    expect(calls.find((c) => c.cmd === 'DeleteObjectCommand')?.Key).toBe(key)
  })
})

// ─── Missing bucket ────────────────────────────────────────────

describe('missing S3_WORKSPACES_BUCKET', () => {
  test('upload throws a clear error', async () => {
    delete process.env.S3_WORKSPACES_BUCKET
    _setClientForTests(null)
    _resetClientForTests()
    makeProject('src', { 'a.txt': 'alpha' })
    await expect(uploadProjectSnapshot('src', 'lst', '1.0.0')).rejects.toThrow(
      'S3_WORKSPACES_BUCKET',
    )
  })
})
