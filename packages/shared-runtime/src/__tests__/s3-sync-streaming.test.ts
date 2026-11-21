// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-478 — `S3Sync` must stream archives, never buffer them.
 *
 * A 1.76 GB `project-src.tar.gz` OOMKilled every 1 GiB published pod on cold
 * start because `downloadLayered` read the whole object into memory
 * (`Body.transformToByteArray()`) before writing it to `/tmp`. The same
 * pattern was in `restoreDeps`, `downloadLegacy` and all four uploaders.
 *
 * These tests pin the behaviour, not the implementation:
 *   1. hydrate a project whose archive is far larger than the memory we allow
 *      the process to grow, and fail if RSS tracks the archive size;
 *   2. fail if `transformToByteArray` / a `readFile` of an archive comes back;
 *   3. upload above the multipart threshold without buffering, keeping the
 *      lineage guard (stale ETag → conflict, stored object untouched);
 *   4. an LFS project's archive carries pointer text (bytes stay in
 *      `lfs/objects`), and a hydrate puts the real bytes back.
 *
 * Archive size defaults to 128 MB — big enough that any buffering
 * implementation blows the 64 MB memory assertion, small enough for CI. Set
 * `SHO478_ARCHIVE_MB=1600` to reproduce the production failure with a >1.5 GB
 * archive.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
  createReadStream,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import { Readable } from 'stream'

// ---------------------------------------------------------------------------
// In-memory S3 store. A value is either bytes or a file path, so a large
// archive can be streamed from disk instead of living in this process.
// ---------------------------------------------------------------------------

type Stored = { bytes: Buffer } | { file: string; size: number; etag: string }

const s3Store = new Map<string, Stored>()
const s3Calls: Array<{ command: string; key: string; precondition?: Record<string, string> }> = []
const multipartParts = new Map<string, Array<{ PartNumber: number; body: Buffer }>>()
let multipartId = 0

function resetS3() {
  s3Store.clear()
  s3Calls.length = 0
  multipartParts.clear()
  multipartId = 0
}

class StubS3Error extends Error {
  name: string
  $metadata: Record<string, any>
  constructor(name: string, statusCode: number) {
    super(name)
    this.name = name
    this.$metadata = { httpStatusCode: statusCode }
  }
}

function etagOf(buf: Buffer): string {
  return `"${createHash('md5').update(buf).digest('hex')}"`
}

function etagOfFile(path: string): string {
  return `"${createHash('md5').update(readFileSync(path)).digest('hex')}"`
}

function storeBytes(key: string, bytes: Buffer) {
  s3Store.set(key, { bytes })
}

function storeFile(key: string, file: string) {
  s3Store.set(key, { file, size: statSync(file).size, etag: etagOfFile(file) })
}

class MockS3Client {
  constructor(_opts: any) {}
  async send(cmd: any): Promise<any> {
    const { __type, Bucket, Key, Body, IfMatch, IfNoneMatch } = cmd
    const id = `${Bucket}/${Key}`
    const precondition = {
      ...(IfMatch ? { IfMatch } : {}),
      ...(IfNoneMatch ? { IfNoneMatch } : {}),
    }
    s3Calls.push({ command: __type, key: id, ...(Object.keys(precondition).length ? { precondition } : {}) })

    switch (__type) {
      case 'HeadObject': {
        const v = s3Store.get(id)
        if (!v) throw new StubS3Error('NotFound', 404)
        return 'bytes' in v
          ? { ETag: etagOf(v.bytes), ContentLength: v.bytes.length }
          : { ETag: v.etag, ContentLength: v.size }
      }
      case 'GetObject': {
        const v = s3Store.get(id)
        if (!v) throw new StubS3Error('NoSuchKey', 404)
        if ('file' in v) {
          return { ContentLength: v.size, ETag: v.etag, Body: createReadStream(v.file) }
        }
        return {
          ContentLength: v.bytes.length,
          ETag: etagOf(v.bytes),
          Body: Object.assign(Readable.from([v.bytes]), {
            transformToString: async () => v.bytes.toString('utf-8'),
          }),
        }
      }
      case 'PutObject': {
        const buf = Buffer.from(Body)
        const current = s3Store.get(id)
        if (IfNoneMatch === '*' && current) throw new StubS3Error('PreconditionFailed', 412)
        if (IfMatch && (!current || currentEtag(current) !== IfMatch)) {
          throw new StubS3Error('PreconditionFailed', 412)
        }
        storeBytes(id, buf)
        return { ETag: etagOf(buf) }
      }
      case 'CreateMultipartUpload': {
        multipartId += 1
        const uploadId = `mpu-${multipartId}`
        multipartParts.set(uploadId, [])
        return { UploadId: uploadId }
      }
      case 'UploadPart': {
        const parts = multipartParts.get(cmd.UploadId)
        if (!parts) throw new StubS3Error('NoSuchUpload', 404)
        const buf = Buffer.from(Body)
        parts.push({ PartNumber: cmd.PartNumber, body: buf })
        return { ETag: etagOf(buf) }
      }
      case 'CompleteMultipartUpload': {
        const parts = multipartParts.get(cmd.UploadId)
        if (!parts) throw new StubS3Error('NoSuchUpload', 404)
        const body = Buffer.concat([...parts].sort((a, b) => a.PartNumber - b.PartNumber).map((p) => p.body))
        const current = s3Store.get(id)
        if (IfNoneMatch === '*' && current) throw new StubS3Error('PreconditionFailed', 412)
        if (IfMatch && (!current || currentEtag(current) !== IfMatch)) {
          throw new StubS3Error('PreconditionFailed', 412)
        }
        storeBytes(id, body)
        multipartParts.delete(cmd.UploadId)
        return { ETag: etagOf(body) }
      }
      case 'AbortMultipartUpload': {
        multipartParts.delete(cmd.UploadId)
        return {}
      }
      default:
        throw new Error(`MockS3Client: unhandled command ${__type}`)
    }
  }
}

function currentEtag(v: Stored): string {
  return 'bytes' in v ? etagOf(v.bytes) : v.etag
}

mock.module('@aws-sdk/client-s3', () => ({
  S3Client: MockS3Client,
  HeadObjectCommand: class { constructor(opts: any) { Object.assign(this, opts, { __type: 'HeadObject' }) } },
  GetObjectCommand: class { constructor(opts: any) { Object.assign(this, opts, { __type: 'GetObject' }) } },
  PutObjectCommand: class { constructor(opts: any) { Object.assign(this, opts, { __type: 'PutObject' }) } },
  CreateMultipartUploadCommand: class { constructor(opts: any) { Object.assign(this, opts, { __type: 'CreateMultipartUpload' }) } },
  UploadPartCommand: class { constructor(opts: any) { Object.assign(this, opts, { __type: 'UploadPart' }) } },
  CompleteMultipartUploadCommand: class { constructor(opts: any) { Object.assign(this, opts, { __type: 'CompleteMultipartUpload' }) } },
  AbortMultipartUploadCommand: class { constructor(opts: any) { Object.assign(this, opts, { __type: 'AbortMultipartUpload' }) } },
}))

import { S3Sync } from '../s3-sync'
import { lfsObjectKey, lfsPointerText } from '../lfs'

// ---------------------------------------------------------------------------
// Scratch dir per test
// ---------------------------------------------------------------------------

const SRC = readFileSync(join(import.meta.dir, '..', 's3-sync.ts'), 'utf-8')
/** `SRC` without comments — the guards below are about code, not prose. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

let TEST_DIR: string
let TMP_FILES: string[] = []

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `s3-stream-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(TEST_DIR, { recursive: true })
  resetS3()
  TMP_FILES = []
})

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
  for (const f of TMP_FILES) {
    try { rmSync(f, { force: true }) } catch {}
  }
})

function mkSync(opts: Partial<ConstructorParameters<typeof S3Sync>[0]> = {}) {
  return new S3Sync({
    bucket: 'test-bucket',
    prefix: 'test-prefix',
    localDir: TEST_DIR,
    syncInterval: 0,
    watchEnabled: false,
    allowUnconditionalWrite: true,
    ...opts,
  })
}

function scratchFile(name: string): string {
  const p = join(tmpdir(), `sho478-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  TMP_FILES.push(p)
  return p
}

/** Deterministic, incompressible content so the archive is as big as the file. */
function writePatternFile(path: string, sizeBytes: number): void {
  const block = Buffer.alloc(1024 * 1024)
  let x = 0x9e3779b9
  for (let i = 0; i < block.length; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    block[i] = x & 0xff
  }
  const fd = openSync(path, 'w')
  try {
    let written = 0
    while (written < sizeBytes) {
      const n = Math.min(block.length, sizeBytes - written)
      writeSync(fd, block, 0, n)
      written += n
    }
  } finally {
    closeSync(fd)
  }
}

async function hashFileStreamed(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function git(args: string[], cwd: string) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
  return res.stdout
}

// ---------------------------------------------------------------------------
// 1. Hydrate a big archive without buffering it
// ---------------------------------------------------------------------------

describe('downloadAll streams a large archive instead of buffering it', () => {
  const archiveMb = Number(process.env.SHO478_ARCHIVE_MB || 128)

  test(
    `hydrates a ${archiveMb} MB archive with flat memory (production case: 1.76 GB into a 1 GiB pod)`,
    async () => {
      const bigName = 'media/big.bin'
      const size = archiveMb * 1024 * 1024
      mkdirSync(join(TEST_DIR, 'media'), { recursive: true })
      const sourceFile = join(TEST_DIR, bigName)
      writePatternFile(sourceFile, size)
      const expectedSha = await hashFileStreamed(sourceFile)

      // Stand-in for `project-src.tar.gz`: one entry, kept incompressible.
      const archivePath = scratchFile('big-src.tar.gz')
      const tarRes = spawnSync(
        'tar',
        ['-czf', archivePath, '-C', TEST_DIR, '--no-xattrs', bigName],
        { encoding: 'utf-8' },
      )
      expect(tarRes.status).toBe(0)
      const archiveSize = statSync(archivePath).size
      expect(archiveSize).toBeGreaterThan(size * 0.9)

      storeFile('test-bucket/test-prefix/project-src.tar.gz', archivePath)
      // Hydrating into a clean dir, as a cold pod does.
      rmSync(TEST_DIR, { recursive: true, force: true })
      mkdirSync(TEST_DIR, { recursive: true })

      const sync = mkSync()
      const gc = (globalThis as any).Bun?.gc
      gc?.(true)
      const baseline = process.memoryUsage().rss

      let peak = baseline
      const sampler = setInterval(() => {
        const rss = process.memoryUsage().rss
        if (rss > peak) peak = rss
      }, 15)
      let stats
      try {
        stats = await sync.downloadAll()
      } finally {
        clearInterval(sampler)
      }

      const growth = peak - baseline
      const restored = join(TEST_DIR, bigName)
      expect(existsSync(restored)).toBe(true)
      expect(statSync(restored).size).toBe(size)
      expect(await hashFileStreamed(restored)).toBe(expectedSha)
      expect(stats.errors).toEqual([])
      expect(stats.archiveSize).toBe(archiveSize)

      // The point of the whole card: memory must not track the archive size.
      // Buffering grew RSS by ~archiveSize; a streaming pipeline grows by a
      // few MB of chunk buffers whatever the object is.
      console.log(
        `[test] archive=${(archiveSize / (1024 * 1024)).toFixed(0)} MB, peak RSS growth=${(growth / (1024 * 1024)).toFixed(1)} MB`,
      )
      expect(growth).toBeLessThan(64 * 1024 * 1024)
      expect(growth).toBeLessThan(archiveSize / 2)
    },
    { timeout: 240_000 },
  )
})

// ---------------------------------------------------------------------------
// 2. The buffering primitives must not come back
// ---------------------------------------------------------------------------

describe('no archive is ever read into memory', () => {
  test('s3-sync.ts contains no transformToByteArray()', () => {
    expect(CODE.includes('transformToByteArray')).toBe(false)
  })

  test('s3-sync.ts never readFile()s an archive', () => {
    const offenders = CODE.split('\n')
      .map((line, i) => ({ line: line.trim(), i: i + 1 }))
      .filter(({ line }) => /readFile\s*\(\s*(temp|dest|archive|bodyP|projectData)/.test(line))
    expect(offenders).toEqual([])
  })

  test('every archive download goes through the streaming helper', () => {
    const streaming = (CODE.match(/downloadObjectToFile\(/g) || []).length
    // Three call sites (layered, deps, legacy) + the definition.
    expect(streaming).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// 3. Uploads above the multipart threshold keep the lineage guard
// ---------------------------------------------------------------------------

describe('large archive uploads use multipart without buffering the archive', () => {
  test('a 70 MB archive is uploaded in parts and lands byte-for-byte', async () => {
    const sync = mkSync()
    const filePath = scratchFile('big-upload.tar.gz')
    const size = 70 * 1024 * 1024
    writePatternFile(filePath, size)

    s3Calls.length = 0
    const outcome = await (sync as any).putProjectArchive(filePath, size)
    expect(outcome).toBe('written')

    const commands = s3Calls.map((c) => c.command)
    expect(commands).toContain('CreateMultipartUpload')
    expect(commands.filter((c) => c === 'UploadPart').length).toBeGreaterThan(1)
    expect(commands).toContain('CompleteMultipartUpload')
    // Never a single buffered PUT for an object this size.
    expect(commands).not.toContain('PutObject')

    const stored = s3Store.get('test-bucket/test-prefix/project-src.tar.gz')!
    expect(stored).toBeDefined()
    expect('bytes' in stored && stored.bytes.length).toBe(size)
    expect('bytes' in stored && etagOf(stored.bytes)).toBe(`"${createHash('md5').update(readFileSync(filePath)).digest('hex')}"`)
  }, { timeout: 120_000 })

  test('the complete call carries the lineage precondition', async () => {
    const sync = mkSync()
    const filePath = scratchFile('preconditioned.tar.gz')
    const size = 70 * 1024 * 1024
    writePatternFile(filePath, size)

    // Pretend we read an object that is no longer there: the ETag check
    // before Complete must catch it, because a store may ignore If-Match.
    ;(sync as any).projectLineage = { kind: 'descends', etag: '"stale-etag"' }
    s3Calls.length = 0
    const outcome = await (sync as any).putProjectArchive(filePath, size)

    expect(outcome).toBe('conflict')
    // Stored archive untouched: we never wrote it in the first place.
    expect(s3Store.has('test-bucket/test-prefix/project-src.tar.gz')).toBe(false)
    // The losing archive is parked under conflict/ so the work is recoverable.
    const quarantined = [...s3Store.keys()].filter((k) => k.startsWith('test-bucket/conflict/test-prefix/'))
    expect(quarantined.length).toBe(1)
    expect('bytes' in s3Store.get(quarantined[0])!).toBe(true)
    // And it says why.
    expect(sync.getStats().errors.some((e) => e.includes('LINEAGE CONFLICT'))).toBe(true)
  }, { timeout: 120_000 })

  test('a stale ETag rejected by the store itself (412 on complete) is the same conflict path', async () => {
    const sync = mkSync()
    const filePath = scratchFile('store-rejects.tar.gz')
    const size = 70 * 1024 * 1024
    writePatternFile(filePath, size)

    // Object appears between the head check and the complete call.
    const key = 'test-bucket/test-prefix/project-src.tar.gz'
    ;(sync as any).projectLineage = { kind: 'absent' }
    const origSend = (sync as any).client.send.bind((sync as any).client)
    let completed = false
    ;(sync as any).client.send = async (cmd: any) => {
      if (cmd.__type === 'CompleteMultipartUpload' && !completed) {
        completed = true
        storeBytes(key, Buffer.from('someone else won the race'))
        throw new StubS3Error('PreconditionFailed', 412)
      }
      return origSend(cmd)
    }
    try {
      const outcome = await (sync as any).putProjectArchive(filePath, size)
      expect(outcome).toBe('conflict')
      const stored = s3Store.get(key)!
      expect('bytes' in stored && stored.bytes.toString('utf-8')).toBe('someone else won the race')
    } finally {
      ;(sync as any).client.send = origSend
    }
  }, { timeout: 120_000 })

  test('an archive below the threshold still uses one PutObject', async () => {
    const sync = mkSync()
    writeFileSync(join(TEST_DIR, 'index.html'), '<html>hello</html>')
    s3Calls.length = 0
    await sync.uploadAll()

    const commands = s3Calls.map((c) => c.command)
    expect(commands).toContain('PutObject')
    expect(commands).not.toContain('CreateMultipartUpload')
  })
})

// ---------------------------------------------------------------------------
// 4. LFS bytes stay in lfs/objects, and come back on hydrate
// ---------------------------------------------------------------------------

describe('LFS-tracked files travel as pointer text and are materialized on hydrate', () => {
  const CLIP_BYTES = Buffer.from('fake mp4 payload '.repeat(200))
  const CLIP_SHA = createHash('sha256').update(CLIP_BYTES).digest('hex')

  function makeLfsProject() {
    git(['init', '-q'], TEST_DIR)
    writeFileSync(
      join(TEST_DIR, '.gitattributes'),
      '*.mp4 filter=lfs diff=lfs merge=lfs -text\n',
    )
    mkdirSync(join(TEST_DIR, 'media'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'media', 'clip.mp4'), CLIP_BYTES)
    writeFileSync(join(TEST_DIR, 'index.html'), '<html>published</html>')
  }

  test('with LFS durable, the packed archive holds the pointer and not the media bytes', async () => {
    makeLfsProject()
    const sync = mkSync()
    sync.setLfsObjectsDurable(true)

    const dest = scratchFile('packed.tar.gz')
    const res = await sync.packProjectArchive(dest)
    expect(res).not.toBeNull()

    const entries = spawnSync('tar', ['-tzf', dest], { encoding: 'utf-8' }).stdout.split('\n').filter(Boolean)
    expect(entries).toContain('media/clip.mp4')
    const clip = spawnSync('tar', ['-xzOf', dest, 'media/clip.mp4'], { encoding: 'utf-8' }).stdout
    expect(clip).toBe(lfsPointerText(CLIP_SHA, CLIP_BYTES.length))
    expect(clip).not.toContain('fake mp4 payload')
    // Everything else keeps its real content.
    const html = spawnSync('tar', ['-xzOf', dest, 'index.html'], { encoding: 'utf-8' }).stdout
    expect(html).toBe('<html>published</html>')
  }, { timeout: 60_000 })

  test('without a durable push the archive keeps the bytes (never lose the only copy)', async () => {
    makeLfsProject()
    const sync = mkSync()
    sync.setLfsObjectsDurable(false)

    const dest = scratchFile('packed-bytes.tar.gz')
    await sync.packProjectArchive(dest)
    const clip = spawnSync('tar', ['-xzOf', dest, 'media/clip.mp4'], { encoding: 'utf-8' }).stdout
    expect(clip).toBe(CLIP_BYTES.toString('utf-8'))
  }, { timeout: 60_000 })

  test('upload -> download round trip restores the real media bytes from lfs/objects', async () => {
    makeLfsProject()

    // Upload side: pointers only, and the object bytes already in the store.
    const uploader = mkSync()
    uploader.setLfsObjectsDurable(true)
    await uploader.uploadAll()
    const archived = s3Store.get('test-bucket/test-prefix/project-src.tar.gz')!
    expect('bytes' in archived && archived.bytes.includes(Buffer.from('fake mp4 payload'))).toBe(false)
    storeBytes(`test-bucket/${lfsObjectKey('test-prefix', CLIP_SHA)}`, CLIP_BYTES)

    // Cold hydrate into an empty dir (a published pod).
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    writeFileSync(join(TEST_DIR, '.gitattributes'), '*.mp4 filter=lfs diff=lfs merge=lfs -text\n')

    const downloader = mkSync()
    const stats = await downloader.downloadAll()
    expect(stats.errors).toEqual([])

    const restored = readFileSync(join(TEST_DIR, 'media', 'clip.mp4'))
    expect(restored.equals(CLIP_BYTES)).toBe(true)
    expect(createHash('sha256').update(restored).digest('hex')).toBe(CLIP_SHA)
    expect(readFileSync(join(TEST_DIR, 'index.html'), 'utf-8')).toBe('<html>published</html>')
  }, { timeout: 60_000 })
})
