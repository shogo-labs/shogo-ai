// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-478 — a published pod restores LFS-tracked files as pointer text (the
 * archive carries pointers, not the bytes) and must put the real bytes back
 * from `<projectId>/lfs/objects/…` without a `.git` or the `git-lfs` binary.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { Readable } from 'stream'

import {
  lfsObjectKey,
  lfsPointerText,
  materializeLfsPointersFromStore,
  findLfsPointerFiles,
} from '../lfs'

let TEST_DIR: string

const quietLogger = { log: () => {}, warn: () => {}, error: () => {} }

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `lfs-mat-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
})

function writePointer(relPath: string, bytes: Buffer): string {
  const oid = createHash('sha256').update(bytes).digest('hex')
  const full = join(TEST_DIR, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, lfsPointerText(oid, bytes.length))
  return oid
}

/** Fake object store: `objects` maps an S3 key to the bytes it holds. */
function fakeStore(objects: Map<string, Buffer>, calls: string[] = []) {
  return {
    bucket: 'test-bucket',
    client: {
      async send(cmd: any): Promise<any> {
        const key: string = cmd.input?.Key ?? cmd.Key
        calls.push(key)
        const body = objects.get(key)
        if (!body) {
          const err: any = new Error('NoSuchKey')
          err.name = 'NoSuchKey'
          err.$metadata = { httpStatusCode: 404 }
          throw err
        }
        return { Body: Readable.from([body]), ContentLength: body.length }
      },
    },
  }
}

const ATTRS = '*.mp4 filter=lfs diff=lfs merge=lfs -text\n'
const CLIP = Buffer.from('a real mp4 payload '.repeat(64))

describe('materializeLfsPointersFromStore', () => {
  test('streams the object into place, byte-exact (sha256 === oid)', async () => {
    writeFileSync(join(TEST_DIR, '.gitattributes'), ATTRS)
    const oid = writePointer('media/clip.mp4', CLIP)
    const store = fakeStore(new Map([[lfsObjectKey('proj-1', oid), CLIP]]))

    const res = await materializeLfsPointersFromStore(TEST_DIR, 'proj-1', { store, logger: quietLogger })

    expect(res).toEqual({ pointers: 1, materialized: 1, missing: 0, mismatched: 0 })
    const restored = readFileSync(join(TEST_DIR, 'media', 'clip.mp4'))
    expect(createHash('sha256').update(restored).digest('hex')).toBe(oid)
    expect(restored.equals(CLIP)).toBe(true)
    // No staging file left behind.
    expect(existsSync(join(TEST_DIR, 'media', 'clip.mp4.lfs-tmp'))).toBe(false)
  })

  test('a missing object logs and keeps going — the boot must not fail', async () => {
    writeFileSync(join(TEST_DIR, '.gitattributes'), ATTRS)
    const oid = writePointer('media/clip.mp4', CLIP)
    const store = fakeStore(new Map())

    const warnings: string[] = []
    const res = await materializeLfsPointersFromStore(TEST_DIR, 'proj-1', {
      store,
      logger: { log: () => {}, warn: (m: string) => warnings.push(m), error: () => {} },
    })

    expect(res.materialized).toBe(0)
    expect(res.missing).toBe(1)
    expect(warnings.some((w) => w.includes('media/clip.mp4'))).toBe(true)
    // The pointer text is untouched — better a detectable pointer than a
    // truncated media file.
    expect(readFileSync(join(TEST_DIR, 'media', 'clip.mp4'), 'utf-8')).toContain(`oid sha256:${oid}`)
    expect(existsSync(join(TEST_DIR, 'media', 'clip.mp4.lfs-tmp'))).toBe(false)
  })

  test('a size mismatch is reported and the pointer is preserved', async () => {
    writeFileSync(join(TEST_DIR, '.gitattributes'), ATTRS)
    const oid = writePointer('media/clip.mp4', CLIP)
    // Store returns fewer bytes than the pointer promises.
    const store = fakeStore(new Map([[lfsObjectKey('proj-1', oid), CLIP.subarray(0, 10)]]))

    const res = await materializeLfsPointersFromStore(TEST_DIR, 'proj-1', { store, logger: quietLogger })

    expect(res).toMatchObject({ pointers: 1, materialized: 0, mismatched: 1 })
    expect(readFileSync(join(TEST_DIR, 'media', 'clip.mp4'), 'utf-8')).toContain('version https://git-lfs')
    expect(existsSync(join(TEST_DIR, 'media', 'clip.mp4.lfs-tmp'))).toBe(false)
  })

  test('a project that never used LFS is skipped without touching the store', async () => {
    const oid = writePointer('media/clip.mp4', CLIP)
    const calls: string[] = []
    const store = fakeStore(new Map([[lfsObjectKey('proj-1', oid), CLIP]]), calls)

    const res = await materializeLfsPointersFromStore(TEST_DIR, 'proj-1', { store, logger: quietLogger })

    expect(res).toEqual({ pointers: 0, materialized: 0, missing: 0, mismatched: 0 })
    expect(calls).toEqual([])
  })

  test('never reads or rewrites files under node_modules', async () => {
    writeFileSync(join(TEST_DIR, '.gitattributes'), ATTRS)
    const mediaOid = writePointer('media/clip.mp4', CLIP)
    const nestedBytes = Buffer.from('a dependency payload '.repeat(32))
    const nestedOid = writePointer('node_modules/pkg/clip.mp4', nestedBytes)

    const found = findLfsPointerFiles(TEST_DIR).map((f) => f.oid)
    expect(found).toEqual([mediaOid])
    expect(found).not.toContain(nestedOid)
  })
})
