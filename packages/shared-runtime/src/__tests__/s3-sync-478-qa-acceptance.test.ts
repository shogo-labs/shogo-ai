// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-478 — QA acceptance tests, written against the card's acceptance
 * criteria rather than the implementation.
 *
 * These cover two behaviours the dev's own suite does not:
 *   1. a download that dies mid-stream leaves no partial archive in `/tmp`,
 *      records the failure instead of throwing, and a retry still works
 *      (plan §1: "Delete the temp file in a `finally` … so a failed attempt
 *      doesn't fill `/tmp`");
 *   2. the lineage still comes from the streamed response: the ETag served on
 *      the hydrate is the `If-Match` of the next upload (AC3, end to end,
 *      instead of asserting the precondition on a hand-set lineage).
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, createReadStream, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import { Readable } from 'stream'

// ---------------------------------------------------------------------------
// Fake S3: objects are Buffers, GetObject can be told to fail mid-body.
// ---------------------------------------------------------------------------

const s3Store = new Map<string, Buffer>()
const s3Calls: Array<{ command: string; key: string; ifMatch?: string; ifNoneMatch?: string }> = []
/** When set, the next GetObject for this key streams `bytes` then errors. */
let failAfterBytes: { key: string; bytes: number } | null = null

class StubS3Error extends Error {
  name: string
  $metadata: Record<string, any>
  constructor(name: string, statusCode: number) {
    super(name)
    this.name = name
    this.$metadata = { httpStatusCode: statusCode }
  }
}

const etagOf = (b: Buffer) => `"${createHash('md5').update(b).digest('hex')}"`

class MockS3Client {
  constructor(_opts: any) {}
  async send(cmd: any): Promise<any> {
    const { __type, Bucket, Key, Body, IfMatch, IfNoneMatch } = cmd
    const id = `${Bucket}/${Key}`
    s3Calls.push({ command: __type, key: id, ...(IfMatch ? { ifMatch: IfMatch } : {}), ...(IfNoneMatch ? { ifNoneMatch: IfNoneMatch } : {}) })

    switch (__type) {
      case 'HeadObject': {
        const v = s3Store.get(id)
        if (!v) throw new StubS3Error('NotFound', 404)
        return { ETag: etagOf(v), ContentLength: v.length }
      }
      case 'GetObject': {
        const v = s3Store.get(id)
        if (!v) throw new StubS3Error('NoSuchKey', 404)
        if (failAfterBytes && failAfterBytes.key === id) {
          const cut = failAfterBytes.bytes
          failAfterBytes = null
          const body = new Readable({
            read() {
              this.push(v.subarray(0, cut))
              this.destroy(new Error('connection reset by peer'))
            },
          })
          return { ContentLength: v.length, ETag: etagOf(v), Body: Object.assign(body, { transformToString: async () => v.toString('utf-8') }) }
        }
        return {
          ContentLength: v.length,
          ETag: etagOf(v),
          Body: Object.assign(Readable.from([v]), { transformToString: async () => v.toString('utf-8') }),
        }
      }
      case 'PutObject': {
        const buf = Buffer.from(Body)
        const current = s3Store.get(id)
        if (IfNoneMatch === '*' && current) throw new StubS3Error('PreconditionFailed', 412)
        if (IfMatch && (!current || etagOf(current) !== IfMatch)) throw new StubS3Error('PreconditionFailed', 412)
        s3Store.set(id, buf)
        return { ETag: etagOf(buf) }
      }
      case 'CreateMultipartUpload':
        return { UploadId: `mpu-${Math.random().toString(36).slice(2)}` }
      case 'UploadPart':
        return { ETag: etagOf(Buffer.from(Body)) }
      case 'CompleteMultipartUpload':
        return { ETag: `"${Math.random().toString(36).slice(2)}"` }
      case 'AbortMultipartUpload':
        return {}
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
  CreateMultipartUploadCommand: class { constructor(o: any) { Object.assign(this, o, { __type: 'CreateMultipartUpload' }) } },
  UploadPartCommand: class { constructor(o: any) { Object.assign(this, o, { __type: 'UploadPart' }) } },
  CompleteMultipartUploadCommand: class { constructor(o: any) { Object.assign(this, o, { __type: 'CompleteMultipartUpload' }) } },
  AbortMultipartUploadCommand: class { constructor(o: any) { Object.assign(this, o, { __type: 'AbortMultipartUpload' }) } },
}))

import { S3Sync } from '../s3-sync'

let DIR: string
const PREFIX = `qa478-${process.pid}`
const TEMP_ARCHIVE = join('/tmp', `project-${PREFIX}-src.tar.gz`)

beforeEach(() => {
  DIR = join(tmpdir(), `qa478-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(DIR, { recursive: true })
  s3Store.clear()
  s3Calls.length = 0
  failAfterBytes = null
  rmSync(TEMP_ARCHIVE, { force: true })
})

afterEach(() => {
  try { rmSync(DIR, { recursive: true, force: true }) } catch {}
  rmSync(TEMP_ARCHIVE, { force: true })
})

function mkSync() {
  return new S3Sync({
    bucket: 'test-bucket',
    prefix: PREFIX,
    localDir: DIR,
    syncInterval: 0,
    watchEnabled: false,
    allowUnconditionalWrite: true,
  })
}

/** A real gzipped tar of `srcDir`, so the extract step is the real one. */
function makeArchive(srcDir: string, destPath: string): void {
  const res = spawnSync('tar', ['-czf', destPath, '-C', srcDir, '.'], { encoding: 'utf-8' })
  if (res.status !== 0) throw new Error(`tar failed: ${res.stderr}`)
}

describe('a hydrate that dies mid-download cleans up after itself', () => {
  test('no partial archive is left in /tmp, the failure is reported, and a retry succeeds', async () => {
    const src = join(tmpdir(), `qa478-src-${process.pid}`)
    mkdirSync(join(src, 'media'), { recursive: true })
    writeFileSync(join(src, 'index.html'), '<html>published</html>')
    const payload = Buffer.alloc(512 * 1024, 7)
    writeFileSync(join(src, 'media', 'clip.bin'), payload)
    const archivePath = join(tmpdir(), `qa478-archive-${process.pid}.tar.gz`)
    makeArchive(src, archivePath)
    const archive = readFileSync(archivePath)
    try { rmSync(archivePath, { force: true }) } catch {}

    const key = `test-bucket/${PREFIX}/project-src.tar.gz`
    s3Store.set(key, archive)

    // First attempt: the body dies after 4 KB, well into the archive.
    failAfterBytes = { key, bytes: 4096 }
    const first = mkSync()
    const firstStats = await first.downloadAll()

    expect(firstStats.errors.join(' ')).toContain('Download failed')
    // The card's rule: a failed attempt must not leave a partial file behind.
    expect(existsSync(TEMP_ARCHIVE)).toBe(false)
    // And it must not look like a successful hydrate.
    expect(existsSync(join(DIR, 'index.html'))).toBe(false)

    // Second attempt (same instance, fresh transfer) hydrates normally.
    const second = mkSync()
    const secondStats = await second.downloadAll()
    expect(secondStats.errors).toEqual([])
    expect(readFileSync(join(DIR, 'index.html'), 'utf-8')).toBe('<html>published</html>')
    expect(statSync(join(DIR, 'media', 'clip.bin')).size).toBe(payload.length)
    expect(existsSync(TEMP_ARCHIVE)).toBe(false)
  }, { timeout: 60_000 })
})

describe('the lineage comes from the streamed response, not from a guess', () => {
  test('the ETag served on hydrate is the If-Match of the next upload', async () => {
    const src = join(tmpdir(), `qa478-lineage-src-${process.pid}`)
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'index.html'), '<html>one</html>')
    const archivePath = join(tmpdir(), `qa478-lineage-${process.pid}.tar.gz`)
    makeArchive(src, archivePath)
    const archive = readFileSync(archivePath)
    try { rmSync(archivePath, { force: true }) } catch {}

    const key = `test-bucket/${PREFIX}/project-src.tar.gz`
    s3Store.set(key, archive)
    const servedEtag = etagOf(archive)

    const sync = mkSync()
    const stats = await sync.downloadAll()
    expect(stats.errors).toEqual([])
    expect(readFileSync(join(DIR, 'index.html'), 'utf-8')).toBe('<html>one</html>')

    // Change the tree, then save: the write must be conditional on exactly the
    // object we read, so a second runtime cannot be silently overwritten.
    writeFileSync(join(DIR, 'index.html'), '<html>two, changed</html>')
    s3Calls.length = 0
    await sync.uploadAll()

    const put = s3Calls.find((c) => c.command === 'PutObject' && c.key === key)
    expect(put).toBeDefined()
    expect(put?.ifMatch).toBe(servedEtag)
    expect(s3Store.get(key)!.toString('utf-8')).not.toBe(archive.toString('utf-8'))
    expect(sync.getStats().errors).toEqual([])
  }, { timeout: 60_000 })
})
