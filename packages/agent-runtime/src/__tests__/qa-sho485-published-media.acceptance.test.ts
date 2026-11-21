// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-485: a published pod's cold start must not depend on how
 * much media the project has.
 *
 * The card's ACs, as driven here:
 *
 *   1. an image-booted pod never materializes LFS objects (the boot plan), and
 *      the bytes it serves come from `<projectId>/lfs/objects`;
 *   2. over real HTTP: the exact bytes (sha256), `Content-Type`,
 *      `Content-Length`, `ETag`, `Range` → 206 with the exact slice, `HEAD`,
 *      `If-None-Match` → 304, and a pointer with no object → 404 (never
 *      pointer text);
 *   3. serving a large file keeps RSS flat — measured, not asserted by
 *      inspection;
 *   4. `/agent/publish-artifact` uploads its own tar to the named bucket/key,
 *      answers `{ key, bytes }`, leaves LFS paths and `dist/` files ≥ 5 MiB as
 *      pointer text, and every pointer's object is in the store;
 *   5. a project with no LFS and no ≥ 5 MiB file publishes byte-for-byte as the
 *      legacy path did.
 *
 * The store is a mock client (the same shape `s3-sync-streaming.test.ts` uses)
 * because what is under test is our code, not the SDK's transport; every body
 * it returns is a real Node stream, which is what the real SDK hands the
 * runtime, so `toBodyInit`'s Node→web-stream branch is exercised for real.
 *
 * Sized for CI by default. `SHO485_MEDIA_MB=1600` reproduces the Samsara-class
 * project from the card (1.6 GB of media); it passes at that size too.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { Hono } from 'hono'
import { lfsObjectStoreFromEnv, lfsPointerText, parseLfsPointer } from '@shogo/shared-runtime'
import { serveDistResponse, type DistServeContext } from '../dist-response'
import { handlePublishArtifact, type PublishEndpointDeps } from '../publish-endpoints'
import { PUBLISH_STAGING_DIR, publishedBootPlan } from '../preview-manager'

const MEDIA_MB = Number(process.env.SHO485_MEDIA_MB || 192)
/** Media split: a fifth in Git LFS source, the rest as a Vite-built `dist/` file. */
const LFS_BYTES = Math.round((MEDIA_MB * 1024 * 1024) / 5)
const DIST_BYTES = Math.round(MEDIA_MB * 1024 * 1024) - LFS_BYTES
/** How much the serving process may grow while handing out one large file. */
const RSS_LIMIT_BYTES = Number(process.env.SHO485_RSS_LIMIT_MB || 96) * 1024 * 1024
/**
 * How much building the artifact may add. Larger than the serve bound because
 * this process also holds the fixtures it just wrote and Bun's allocator does
 * not return pages promptly; the measured growth is ~24-71 MB for 1.56 GB of
 * media (see the probe in the card), i.e. it does not track media size.
 */
const ARTIFACT_RSS_LIMIT_BYTES =
  Number(process.env.SHO485_ARTIFACT_RSS_LIMIT_MB || 256) * 1024 * 1024

const MB = 1024 * 1024

// ---------------------------------------------------------------------------
// A minimal S3 object store, as a client — files on disk, ranged GETs, HEAD,
// single PUT and multipart. Same contract the real SDK exposes.
//
// File-backed on purpose: the object must not live in this process's heap, or
// the RSS assertions below would measure the fake store instead of the runtime.
// ---------------------------------------------------------------------------

type Stored = {
  file: string
  size: number
  etag: string
  /**
   * The object's own metadata. A published pod serves a store body with the
   * object's `Content-Type`/`Cache-Control` (Bun refuses per-response headers on
   * it), so this, not a per-request header, is what a browser sees.
   */
  contentType?: string
  cacheControl?: string
}

let objects = new Map<string, Stored>()
let parts = new Map<string, Array<{ file: string; size: number }>>()
/** The content type/cache control a multipart upload was started with. */
let stamped = new Map<string, string | undefined>()
let uploadSeq = 0
let objectSeq = 0
let objectsDir = ''

class StubS3Error extends Error {
  $metadata: Record<string, unknown>
  constructor(name: string, statusCode: number) {
    super(name)
    this.name = name
    this.$metadata = { httpStatusCode: statusCode }
  }
}

/** md5 of a file, streamed: computing it must not read the object into memory. */
async function md5File(path: string): Promise<string> {
  const hash = createHash('md5')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return `"${hash.digest('hex')}"`
}

function nextPath(prefix: string): string {
  objectSeq += 1
  return join(objectsDir, `${prefix}-${objectSeq}`)
}

function bodyFor(value: Stored, range?: { start: number; end: number }): Readable {
  return range
    ? createReadStream(value.file, { start: range.start, end: range.end })
    : createReadStream(value.file)
}

class MockS3Client {
  constructor(_opts?: unknown) {}

  async send(command: any): Promise<any> {
    const name = command.constructor.name as string
    const input = command.input ?? {}
    const id = `${input.Bucket}/${input.Key}`

    switch (name) {
      case 'HeadObjectCommand': {
        const value = objects.get(id)
        if (!value) throw new StubS3Error('NotFound', 404)
        return {
          ContentLength: value.size,
          ETag: value.etag,
          ContentType: value.contentType,
          CacheControl: value.cacheControl,
        }
      }
      case 'GetObjectCommand': {
        const value = objects.get(id)
        if (!value) throw new StubS3Error('NoSuchKey', 404)
        const raw = input.Range as string | undefined
        if (!raw) return { ContentLength: value.size, ETag: value.etag, Body: bodyFor(value) }
        const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(raw) ?? []
        const range = { start: Number(start), end: Number(end) }
        return {
          ContentLength: range.end - range.start + 1,
          ETag: value.etag,
          Body: bodyFor(value, range),
        }
      }
      case 'PutObjectCommand': {
        const file = nextPath('obj')
        const body = input.Body
        const hash = createHash('md5')
        if (Buffer.isBuffer(body) || typeof body === 'string') {
          const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
          hash.update(bytes)
          writeFileSync(file, bytes)
        } else {
          const out = createWriteStream(file)
          for await (const chunk of body) {
            hash.update(chunk as Buffer)
            if (!out.write(chunk)) await once(out, 'drain')
          }
          out.end()
          await once(out, 'close')
        }
        const value = {
          file,
          size: statSync(file).size,
          etag: `"${hash.digest('hex')}"`,
          contentType: input.ContentType,
          cacheControl: input.CacheControl,
        }
        objects.set(id, value)
        return { ETag: value.etag }
      }
      case 'CreateMultipartUploadCommand':
        uploadSeq += 1
        parts.set(`mpu-${uploadSeq}`, [])
        stamped.set(`type-mpu-${uploadSeq}`, input.ContentType)
        stamped.set(`cache-mpu-${uploadSeq}`, input.CacheControl)
        return { UploadId: `mpu-${uploadSeq}` }
      case 'UploadPartCommand': {
        const list = parts.get(input.UploadId)!
        const file = nextPath(`part-${input.PartNumber}`)
        writeFileSync(file, input.Body)
        const size = statSync(file).size
        list[input.PartNumber - 1] = { file, size }
        return { ETag: `"${createHash('md5').update(input.Body as Buffer).digest('hex')}"` }
      }
      case 'CompleteMultipartUploadCommand': {
        const list = parts.get(input.UploadId)!
        parts.delete(input.UploadId)
        const file = nextPath('obj')
        const out = createWriteStream(file)
        const hash = createHash('md5')
        for (const part of list) {
          for await (const chunk of createReadStream(part.file)) {
            hash.update(chunk as Buffer)
            if (!out.write(chunk)) await once(out, 'drain')
          }
        }
        out.end()
        await once(out, 'close')
        const value = {
          file,
          size: statSync(file).size,
          etag: `"${hash.digest('hex')}"`,
          contentType: stamped.get(`type-${input.UploadId}`),
          cacheControl: stamped.get(`cache-${input.UploadId}`),
        }
        objects.set(id, value)
        return { ETag: value.etag }
      }
      case 'AbortMultipartUploadCommand':
        parts.delete(input.UploadId)
        return {}
      case 'CopyObjectCommand': {
        // A re-stamp is metadata-only: the bytes are never rewritten.
        const value = objects.get(id)
        if (!value) throw new StubS3Error('NotFound', 404)
        if (input.MetadataDirective === 'REPLACE') {
          value.contentType = input.ContentType
          value.cacheControl = input.CacheControl
        }
        return { CopyObjectResult: { ETag: value.etag } }
      }
      default:
        throw new Error(`MockS3Client: unhandled ${name}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let root: string
let distDir: string
let storeClip: string
let clipOid: string
let clipSize: number
let view: any

/** Write `bytes` deterministic bytes without ever holding them all in memory. */
function writeBigFile(path: string, bytes: number, seed: number): void {
  const chunk = Buffer.allocUnsafe(MB)
  for (let i = 0; i < chunk.length; i += 1) chunk[i] = (i + seed) & 0xff
  const fd = openSync(path, 'w')
  try {
    let written = 0
    while (written < bytes) {
      const length = Math.min(chunk.length, bytes - written)
      writeSync(fd, chunk, 0, length)
      written += length
    }
  } finally {
    closeSync(fd)
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk as Buffer))
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

/** Same, without loading a large fixture into memory to hash its first bytes. */
function sha256FileSync(path: string): string {
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(MB)
  const fd = openSync(path, 'r')
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null)
      if (read <= 0) break
      hash.update(chunk.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

const objectKey = (projectId: string, oid: string) =>
  `${projectId}/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`

/**
 * An S3-compatible origin over the same file-backed objects, so the read path
 * can be built the way a published pod builds it.
 *
 * `Bun.serve` answers a plain `ReadableStream` with `Transfer-Encoding: chunked`
 * and drops `Content-Length` (QA round 1), so the pod reads through Bun's own S3
 * file — a Blob it can measure. A mock client cannot exercise that shape, so the
 * spec drives a real client over real HTTP.
 */
let origin: ReturnType<typeof Bun.serve>
let store: NonNullable<ReturnType<typeof lfsObjectStoreFromEnv>>

function startOrigin(): void {
  origin = Bun.serve({
    port: 0,
    fetch(req) {
      // Path-style, as Bun's S3 client addresses a custom endpoint.
      const pathname = new URL(req.url).pathname.replace(/^\/+/, '')
      const value = objects.get(decodeURIComponent(pathname))
      if (!value) return new Response('not found', { status: 404 })
      const headers: Record<string, string> = {
        'content-type': value.contentType ?? 'application/octet-stream',
        etag: value.etag,
        'accept-ranges': 'bytes',
        'last-modified': 'Mon, 03 Nov 2025 10:00:00 GMT',
      }
      if (value.cacheControl) headers['cache-control'] = value.cacheControl
      if (req.method === 'HEAD') {
        return new Response(null, { headers: { ...headers, 'content-length': String(value.size) } })
      }
      const range = req.headers.get('range')
      if (!range) return new Response(Bun.file(value.file), { headers })
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
      if (!m) return new Response('bad range', { status: 400 })
      const [, rawStart, rawEnd] = m
      let start: number
      let end: number
      if (rawStart === '') {
        // Suffix form: the last N bytes.
        const suffix = Number(rawEnd)
        start = Math.max(0, value.size - suffix)
        end = value.size - 1
      } else {
        start = Number(rawStart)
        end = rawEnd === '' ? value.size - 1 : Math.min(Number(rawEnd), value.size - 1)
      }
      if (start >= value.size) {
        return new Response('range', {
          status: 416,
          headers: { ...headers, 'content-range': `bytes */${value.size}` },
        })
      }
      return new Response(Bun.file(value.file).slice(start, end + 1), {
        status: 206,
        headers: {
          ...headers,
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${value.size}`,
        },
      })
    },
  })
  store = lfsObjectStoreFromEnv({
    S3_WORKSPACES_BUCKET: 'workspaces',
    S3_ENDPOINT: `http://127.0.0.1:${origin.port}`,
    S3_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'qa-from-env',
    AWS_SECRET_ACCESS_KEY: 'qa-from-env-secret',
  } as unknown as NodeJS.ProcessEnv)!
  if (!store) throw new Error('lfsObjectStoreFromEnv returned null')
}

const context = (): DistServeContext & { lfs: { store: any; projectId: string } } => ({
  lfs: { store, projectId: 'p1' },
  injectHtml: (html) => `${html}<!--injected-->`,
  renderBuildingPlaceholder: () => new Response('building', { status: 503 }),
})

function startView(): any {
  const serveContext = context()
  return Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      const response = await serveDistResponse(
        {
          distDir,
          requestPath: url.pathname,
          buildInFlight: false,
          method: req.method,
          range: req.headers.get('range'),
          ifNoneMatch: req.headers.get('if-none-match'),
        },
        serveContext,
      )
      return response ?? new Response('not found', { status: 404 })
    },
  })
}

const viewUrl = (path: string) => `http://localhost:${view.port}${path}`

/** Drain a response, hashing it and sampling RSS without retaining chunks. */
async function drain(response: Response): Promise<{ bytes: number; sha: string; peakRss: number }> {
  const reader = response.body!.getReader()
  const hash = createHash('sha256')
  let bytes = 0
  let peakRss = process.memoryUsage().rss
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    hash.update(value)
    const rss = process.memoryUsage().rss
    if (rss > peakRss) peakRss = rss
  }
  return { bytes, sha: hash.digest('hex'), peakRss }
}

function settleHeap(): void {
  ;(Bun as any).gc?.(true)
}

/** What the artifact leaves on the pod for this file: pointer text. */
function writePointer(path: string, oid: string, size: number): void {
  writeFileSync(path, lfsPointerText(oid, size))
}

/** Register the real media in the store, under the layout the pod reads. */
function storeMedia(projectId: string, oid: string, size: number, file: string): void {
  objects.set(`workspaces/${objectKey(projectId, oid)}`, {
    file,
    size,
    etag: `"${oid}"`,
    // What `offloadArtifactMedia` stamps at publish time; the pod can only
    // serve what the object carries.
    contentType: 'video/mp4',
    cacheControl: 'no-cache',
  })
}

beforeEach(() => {
  if (!root) {
    root = mkdtempSync(join(tmpdir(), 'sho485-acceptance-'))
    distDir = join(root, 'dist')
    mkdirSync(join(distDir, 'assets'), { recursive: true })
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>media app</title>')
    writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("app")\n')
    // The media exists once on disk; the "pod" gets only its copy of the tree.
    objectsDir = join(root, 'objects')
    mkdirSync(objectsDir, { recursive: true })
    storeClip = join(root, 'store-clip.mp4')
    writeBigFile(storeClip, DIST_BYTES, 29)
    copyFileSync(storeClip, join(distDir, 'assets', 'clip.mp4'))
    clipSize = statSync(storeClip).size
    clipOid = sha256FileSync(storeClip)
    startOrigin()
    view = startView()
  }
  objects = new Map()
  parts = new Map()
})

afterAll(() => {
  view?.stop?.(true)
  origin?.stop?.(true)
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

// ---------------------------------------------------------------------------
// AC1 — the boot contract the pod runs on
// ---------------------------------------------------------------------------

describe('AC1: an image-booted pod must not materialize media', () => {
  it('does not hydrate source and does not materialize LFS on a prebuilt image', () => {
    const boot = publishedBootPlan({ SHOGO_PREBUILT_IMAGE: 'true' })
    // hydrateSource false keeps `downloadAll` (and the materialize call inside
    // it) off the cold-start path; materializeLfs false is the explicit guard
    // on the git path.
    expect(boot.hydrateSource).toBe(false)
    expect(boot.materializeLfs).toBe(false)
  })

  it('still materializes on the legacy source-hydrate path, which runs a build', () => {
    expect(publishedBootPlan({}).materializeLfs).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC2 / AC3 — the HTTP contract, and flat memory
// ---------------------------------------------------------------------------

describe('AC2: media is served from the store, over HTTP', () => {
  beforeEach(() => {
    writePointer(join(distDir, 'assets', 'clip.mp4'), clipOid, clipSize)
    storeMedia('p1', clipOid, clipSize, storeClip)
  })

  it('returns the object’s exact bytes, type, length and ETag', async () => {
    const response = await fetch(viewUrl('/assets/clip.mp4'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    // The whole point of QA round 1: a streamed body arrives chunked and loses
    // its length, which breaks `<video>` progress and range continuation.
    expect(response.headers.get('transfer-encoding')).toBeNull()
    expect(response.headers.get('content-length')).toBe(String(clipSize))
    expect(response.headers.get('etag')).toBe(`"${clipOid}"`)
    expect(response.headers.get('accept-ranges')).toBe('bytes')

    const body = await drain(response)
    expect(body.bytes).toBe(clipSize)
    expect(body.sha).toBe(clipOid)
  }, 600_000)

  it('answers a Range with a 206 and exactly that slice', async () => {
    const response = await fetch(viewUrl('/assets/clip.mp4'), {
      headers: { range: 'bytes=1000-1999' },
    })
    expect(response.status).toBe(206)
    expect(response.headers.get('transfer-encoding')).toBeNull()
    expect(response.headers.get('content-range')).toBe(`bytes 1000-1999/${clipSize}`)
    expect(response.headers.get('content-length')).toBe('1000')
    const body = await drain(response)
    expect(body.bytes).toBe(1000)
  }, 600_000)

  it('answers HEAD with the headers and no body', async () => {
    const response = await fetch(viewUrl('/assets/clip.mp4'), { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(clipSize))
    expect(response.headers.get('etag')).toBe(`"${clipOid}"`)
  }, 600_000)

  it('answers 304 when the client already has the object', async () => {
    const response = await fetch(viewUrl('/assets/clip.mp4'), {
      headers: { 'if-none-match': `W/"${clipOid}"` },
    })
    expect(response.status).toBe(304)
  }, 600_000)

  it('answers a suffix range and keeps the length on it', async () => {
    const response = await fetch(viewUrl('/assets/clip.mp4'), { headers: { range: 'bytes=-4096' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-length')).toBe('4096')
    expect(response.headers.get('content-range')).toBe(`bytes ${clipSize - 4096}-${clipSize - 1}/${clipSize}`)
    const body = await drain(response)
    expect(body.bytes).toBe(4096)
  }, 600_000)

  it('404s a pointer with no object behind it, never pointer text', async () => {
    objects.clear()
    const response = await fetch(viewUrl('/assets/clip.mp4'))
    expect(response.status).toBe(404)
    const body = await response.text()
    expect(body).not.toContain('git-lfs.github.com')
    expect(body).not.toContain(clipOid)
  }, 600_000)

  it('serves a large file without letting RSS track its size', async () => {
    expect(clipSize).toBeGreaterThan(60 * MB)
    settleHeap()
    const baseline = process.memoryUsage().rss
    const response = await fetch(viewUrl('/assets/clip.mp4'))
    const body = await drain(response)
    const growth = body.peakRss - baseline
    console.log(
      `[test] served ${(clipSize / MB).toFixed(0)} MB, sha ok=${body.sha === clipOid}, ` +
        `peak RSS growth=${(growth / MB).toFixed(1)} MB`,
    )
    expect(body.sha).toBe(clipOid)
    expect(growth).toBeLessThan(RSS_LIMIT_BYTES)
  }, 600_000)
})

describe('AC5: a project with no LFS serves its own bytes', () => {
  it('streams a real file unchanged', async () => {
    const logo = Buffer.from('small real asset, not a pointer\n')
    writeFileSync(join(distDir, 'assets', 'logo.png'), logo)
    const response = await fetch(viewUrl('/assets/logo.png'))
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(logo)
  })

  it('still injects the runtime bridge into HTML', async () => {
    const response = await fetch(viewUrl('/'))
    expect(await response.text()).toContain('<!--injected-->')
  })
})

// ---------------------------------------------------------------------------
// AC2 — the documented fallback: a host with no Bun S3 file
// ---------------------------------------------------------------------------

describe('AC2: a host without Bun’s S3 file', () => {
  it('still serves the object, losing only the length header', async () => {
    // A published pod always has `Bun.S3Client`; the node test runner does not,
    // and that is the one place the piped fallback runs. Asserted so the shape
    // stays a documented degradation instead of quietly becoming the production
    // path again.
    writePointer(join(distDir, 'assets', 'clip.mp4'), clipOid, clipSize)
    storeMedia('p1', clipOid, clipSize, storeClip)
    const fallback = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url)
        const response = await serveDistResponse(
          {
            distDir,
            requestPath: url.pathname,
            buildInFlight: false,
            method: req.method,
            range: req.headers.get('range'),
            ifNoneMatch: req.headers.get('if-none-match'),
          },
          {
            lfs: { store: { bucket: 'workspaces', client: new MockS3Client() }, projectId: 'p1' },
            injectHtml: (html) => html,
            renderBuildingPlaceholder: () => new Response('building', { status: 503 }),
          },
        )
        return response ?? new Response('not found', { status: 404 })
      },
    })
    try {
      const response = await fetch(`http://127.0.0.1:${fallback.port}/assets/clip.mp4`, {
        headers: { range: 'bytes=0-99' },
      })
      expect(response.status).toBe(206)
      expect(response.headers.get('content-range')).toBe(`bytes 0-99/${clipSize}`)
      const body = await drain(response)
      expect(body.bytes).toBe(100)
    } finally {
      fallback.stop(true)
    }
  }, 600_000)
})

// ---------------------------------------------------------------------------
// AC4 — the artifact leaves the media out and never crosses the API
// ---------------------------------------------------------------------------

function seedMediaProject(dir: string): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'media-demo' }))
  writeFileSync(join(dir, '.gitattributes'), '*.mp4 filter=lfs diff=lfs merge=lfs -text\n')
  mkdirSync(join(dir, 'public'), { recursive: true })
  writeBigFile(join(dir, 'public', 'clip.mp4'), LFS_BYTES, 41)

  const staging = join(dir, PUBLISH_STAGING_DIR)
  mkdirSync(join(staging, 'assets'), { recursive: true })
  writeFileSync(join(staging, 'index.html'), '<!doctype html><title>published</title>')
  writeFileSync(join(staging, 'assets', 'notes.txt'), 'small files travel in the image')
  writeBigFile(join(staging, 'assets', 'hero.mp4'), DIST_BYTES, 53)

  execFileSync('git', ['init', '-q'], { cwd: dir })
}

function mountArtifact(dir: string, client: any): Hono {
  const deps: PublishEndpointDeps = {
    projectDir: () => dir,
    outputRoot: (_projectId, projectDir) => projectDir,
    objectStore: () => ({ client, bucket: 'workspaces' }),
  }
  const hono = new Hono()
  hono.get('/agent/publish-artifact', (c) => handlePublishArtifact(c, deps))
  return hono
}

function extractUploaded(key: string): string {
  const stored = objects.get(`workspaces/${key}`)
  if (!stored) throw new Error(`no uploaded artifact at ${key}`)
  const archivePath = stored.file
  const out = mkdtempSync(join(root, 'extract-'))
  execFileSync('tar', ['-xzf', archivePath, '-C', out])
  return out
}

describe('AC4: the publish artifact streams to the store with large bytes left out', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(root, 'workspace-'))
    seedMediaProject(workspace)
  })

  it('uploads its own tar, answers { key, bytes }, and keeps every pointer backed', async () => {
    const app = mountArtifact(workspace, new MockS3Client())
    // The artifact call deletes the staging dir, so fingerprint the sources first.
    const expectedClip = await sha256File(join(workspace, 'public', 'clip.mp4'))
    const expectedHero = await sha256File(
      join(workspace, PUBLISH_STAGING_DIR, 'assets', 'hero.mp4'),
    )

    settleHeap()
    const baseline = process.memoryUsage().rss
    let peak = baseline
    const timer = setInterval(() => {
      const rss = process.memoryUsage().rss
      if (rss > peak) peak = rss
    }, 20)

    let response: Response
    try {
      response = await app.fetch(
        new Request(
          'http://runtime.test/agent/publish-artifact?projectId=p1&bucket=workspaces&key=acme/artifacts/abc.tar.gz',
        ),
      )
    } finally {
      clearInterval(timer)
    }

    expect(response.status).toBe(200)
    const body = (await response.json()) as { key: string; bytes: number; archive?: string }
    expect(body.archive).toBeUndefined()
    expect(body.key).toBe('acme/artifacts/abc.tar.gz')
    expect(body.bytes).toBeGreaterThan(0)
    // Nothing in the response carries the bytes: the archive never crossed the API.
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(1024)

    const contextDir = extractUploaded('acme/artifacts/abc.tar.gz')

    // LFS-tracked source path → pointer text, object durable in the store.
    const clipPointer = parseLfsPointer(
      readFileSync(join(contextDir, 'public', 'clip.mp4'), 'utf-8'),
    )
    expect(clipPointer).not.toBeNull()
    expect(clipPointer!.size).toBe(LFS_BYTES)
    expect(clipPointer!.oid).toBe(expectedClip)
    const clipObject = objects.get(`workspaces/${objectKey('p1', clipPointer!.oid)}`)
    expect(clipObject).toBeDefined()
    expect(clipObject!.size).toBe(LFS_BYTES)

    // dist file ≥ 5 MiB → pointer text, object durable; no source mapping needed.
    const heroPointer = parseLfsPointer(
      readFileSync(join(contextDir, 'dist', 'assets', 'hero.mp4'), 'utf-8'),
    )
    expect(heroPointer).not.toBeNull()
    expect(heroPointer!.size).toBe(DIST_BYTES)
    expect(heroPointer!.oid).toBe(expectedHero)
    expect(objects.get(`workspaces/${objectKey('p1', heroPointer!.oid)}`)).toBeDefined()

    // Small files and HTML are untouched.
    expect(readFileSync(join(contextDir, 'dist', 'assets', 'notes.txt'), 'utf-8')).toBe(
      'small files travel in the image',
    )
    expect(readFileSync(join(contextDir, 'dist', 'index.html'), 'utf-8')).toContain('published')

    // The artifact is small however big the media is, and building it stays flat.
    expect(body.bytes).toBeLessThan(10 * MB)
    const growth = peak - baseline
    console.log(
      `[test] artifact ${(body.bytes / MB).toFixed(2)} MB for ` +
        `${MEDIA_MB >= 1024 ? `${(MEDIA_MB / 1024).toFixed(2)} GB` : `${MEDIA_MB} MB`} of media, ` +
        `peak RSS growth=${(growth / MB).toFixed(1)} MB`,
    )
    expect(growth).toBeLessThan(ARTIFACT_RSS_LIMIT_BYTES)
    // ...and at a real media size it does not scale with it, which is the point.
    if (MEDIA_MB >= 512) expect(growth).toBeLessThan((MEDIA_MB * MB) / 4)
  }, 900_000)

  it('gives one object one cache policy when two paths reference it', async () => {
    // The bare-blob response carries the *object's* `Cache-Control`, so a
    // content-addressed object referenced from two places can only have one
    // policy. `public/About-Us.png` is served at the stable `/About-Us.png`
    // while the same bytes are also emitted hashed (`/assets/About-Us-<hash>.png`):
    // the hashed path must not be allowed to stamp `immutable` onto the stable
    // one, or a later publish serves a year-old image from every cache.
    const dir = mkdtempSync(join(root, 'workspace-shared-'))
    writeFileSync(join(dir, 'package.json'), '{}')
    mkdirSync(join(dir, 'public'), { recursive: true })
    writeBigFile(join(dir, 'public', 'About-Us.png'), 6 * MB, 67)
    const staging = join(dir, PUBLISH_STAGING_DIR)
    mkdirSync(join(staging, 'assets'), { recursive: true })
    writeFileSync(join(staging, 'index.html'), '<!doctype html><title>shared</title>')
    copyFileSync(join(dir, 'public', 'About-Us.png'), join(staging, 'About-Us.png'))
    copyFileSync(
      join(dir, 'public', 'About-Us.png'),
      join(staging, 'assets', 'About-Us-9f2c1ab3.png'),
    )
    execFileSync('git', ['init', '-q'], { cwd: dir })

    const app = mountArtifact(dir, new MockS3Client())
    const response = await app.fetch(
      new Request(
        'http://runtime.test/agent/publish-artifact?projectId=p1&bucket=workspaces&key=acme/artifacts/shared.tar.gz',
      ),
    )
    expect(response.status).toBe(200)

    const oid = sha256FileSync(join(dir, 'public', 'About-Us.png'))
    const stored = objects.get(`workspaces/${objectKey('p1', oid)}`)
    expect(stored).toBeDefined()
    expect(stored!.cacheControl).toBe('no-cache')
  }, 300_000)

  it('refuses a pointer it cannot back with an object', async () => {
    const broken = {
      send: async (command: any) => {
        if (command.constructor.name === 'HeadObjectCommand') {
          throw new StubS3Error('NotFound', 404)
        }
        throw new StubS3Error('InternalError', 500)
      },
    }
    const app = mountArtifact(workspace, broken)
    const response = await app.fetch(
      new Request(
        'http://runtime.test/agent/publish-artifact?projectId=p1&bucket=workspaces&key=acme/artifacts/abc.tar.gz',
      ),
    )
    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: string; message: string }
    expect(body.error).toBe('lfs_object_missing')
    expect(body.message).toContain('lfs_object_missing')
  }, 900_000)
})

describe('AC5: a small project publishes exactly as before', () => {
  it('keeps the base64 body when no target is named, byte-for-byte', async () => {
    const dir = mkdtempSync(join(root, 'small-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'small' }))
    const staging = join(dir, PUBLISH_STAGING_DIR)
    mkdirSync(join(staging, 'assets'), { recursive: true })
    writeFileSync(join(staging, 'index.html'), '<!doctype html><title>small</title>')
    writeFileSync(join(staging, 'assets', 'app.js'), 'console.log("small")')
    try {
      const app = mountArtifact(dir, new MockS3Client())
      const response = await app.fetch(
        new Request('http://runtime.test/agent/publish-artifact?projectId=p1'),
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as { archive?: string; bytes?: number }
      expect(typeof body.archive).toBe('string')
      expect(body.archive!.length).toBeGreaterThan(0)

      const archivePath = join(root, 'small-legacy.tar.gz')
      writeFileSync(archivePath, Buffer.from(body.archive!, 'base64'))
      const out = mkdtempSync(join(root, 'small-extract-'))
      execFileSync('tar', ['-xzf', archivePath, '-C', out])
      expect(readFileSync(join(out, 'dist', 'assets', 'app.js'), 'utf-8')).toBe(
        'console.log("small")',
      )
      expect(readFileSync(join(out, 'dist', 'index.html'), 'utf-8')).toContain('small')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 600_000)
})
