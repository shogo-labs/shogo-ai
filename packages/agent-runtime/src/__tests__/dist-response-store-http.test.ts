// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The store-served media path **on the wire** (SHO-485 §1a, QA round 1).
 *
 * `Bun.serve` replies to any `ReadableStream` body with `Transfer-Encoding:
 * chunked` and drops an explicit `Content-Length`, so a piped `GetObject` body
 * looked right in a unit test and lost the header over HTTP. This drives the
 * real thing end to end: a real `Bun.S3Client` against a small S3-compatible
 * origin, `serveDistResponse` deciding, and a real `Bun.serve` writing the
 * response — then asserts the headers a browser and a `<video>` actually see.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { lfsObjectStoreFromEnv, lfsPointerText } from '@shogo/shared-runtime'
import { serveDistResponse } from '../dist-response'

const PROJECT_ID = 'proj-store'
const OID = 'b'.repeat(64)
const OBJECT_ETAG = '"etag-from-store"'
const MEDIA = Buffer.alloc(64 * 1024)
for (let i = 0; i < MEDIA.length; i += 1) MEDIA[i] = i % 251

let origin: ReturnType<typeof Bun.serve>
let app: ReturnType<typeof Bun.serve>
let distDir: string
/** Set per test: what the origin answers for the object. */
let stored: { body: Buffer; contentType: string } | null = { body: MEDIA, contentType: 'video/mp4' }

beforeAll(() => {
  origin = Bun.serve({
    port: 0,
    fetch(req) {
      // Path-style: /<bucket>/<key>
      const path = new URL(req.url).pathname
      const expected = `/workspaces/${PROJECT_ID}/lfs/objects/bb/bb/${OID}`
      if (path !== expected) return new Response('not found', { status: 404 })
      if (!stored) return new Response('not found', { status: 404 })
      const headers: Record<string, string> = {
        'content-type': stored.contentType,
        etag: OBJECT_ETAG,
        'accept-ranges': 'bytes',
        'last-modified': 'Mon, 03 Nov 2025 10:00:00 GMT',
        // The publish path stamps this onto the object; the pod can only serve
        // what the object carries (`new Response(s3File, init)` throws).
        'cache-control': 'no-cache',
      }
      if (req.method === 'HEAD') {
        return new Response(null, { headers: { ...headers, 'content-length': String(stored.body.length) } })
      }
      const range = req.headers.get('range')
      if (!range) {
        return new Response(new Uint8Array(stored.body), {
          headers: { ...headers, 'content-length': String(stored.body.length) },
        })
      }
      const m = /bytes=(\d+)-(\d*)/.exec(range)!
      const start = Number(m[1])
      const end = m[2] ? Number(m[2]) : stored.body.length - 1
      if (start >= stored.body.length) {
        return new Response('range', { status: 416, headers: { ...headers, 'content-range': `bytes */${stored.body.length}` } })
      }
      const slice = stored.body.subarray(start, end + 1)
      return new Response(new Uint8Array(slice), {
        status: 206,
        headers: {
          ...headers,
          'content-length': String(slice.length),
          'content-range': `bytes ${start}-${end}/${stored.body.length}`,
        },
      })
    },
  })

  distDir = mkdtempSync(join(tmpdir(), 'sho485-store-'))
  mkdirSync(join(distDir, 'assets'), { recursive: true })
  writeFileSync(join(distDir, 'assets', 'clip.mp4'), lfsPointerText(OID, MEDIA.length))

  const store = lfsObjectStoreFromEnv({
    S3_WORKSPACES_BUCKET: 'workspaces',
    S3_ENDPOINT: `http://127.0.0.1:${origin.port}`,
    S3_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test-key',
    AWS_SECRET_ACCESS_KEY: 'test-secret',
  } as unknown as NodeJS.ProcessEnv)
  if (!store) throw new Error('store from env returned null')

  app = Bun.serve({
    port: 0,
    async fetch(req) {
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
          lfs: { store, projectId: PROJECT_ID },
          injectHtml: (html) => html,
          renderBuildingPlaceholder: () => new Response('building'),
        },
      )
      return response ?? new Response('not found', { status: 404 })
    },
  })
})

afterAll(() => {
  app?.stop(true)
  origin?.stop(true)
  if (distDir) rmSync(distDir, { recursive: true, force: true })
})

afterEach(() => {
  stored = { body: MEDIA, contentType: 'video/mp4' }
})

const url = (path: string) => `http://127.0.0.1:${app.port}${path}`

describe('store-served media over HTTP', () => {
  it('answers a GET with the real Content-Length and the object’s Content-Type', async () => {
    const res = await fetch(url('/assets/clip.mp4'))
    const body = Buffer.from(await res.arrayBuffer())
    expect(res.status).toBe(200)
    expect(res.headers.get('transfer-encoding')).toBeNull()
    expect(res.headers.get('content-length')).toBe(String(MEDIA.length))
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('etag')).toBe(OBJECT_ETAG)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(body.length).toBe(MEDIA.length)
    expect(body.equals(MEDIA)).toBe(true)
  })

  it('keeps Content-Length on a 206 and returns the requested slice', async () => {
    const res = await fetch(url('/assets/clip.mp4'), { headers: { range: 'bytes=1000-1999' } })
    const body = Buffer.from(await res.arrayBuffer())
    expect(res.status).toBe(206)
    expect(res.headers.get('transfer-encoding')).toBeNull()
    expect(res.headers.get('content-length')).toBe('1000')
    expect(res.headers.get('content-range')).toBe(`bytes 1000-1999/${MEDIA.length}`)
    expect(body.equals(MEDIA.subarray(1000, 2000))).toBe(true)
  })

  it('answers HEAD with the length and no body', async () => {
    const res = await fetch(url('/assets/clip.mp4'), { method: 'HEAD' })
    const body = Buffer.from(await res.arrayBuffer())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(MEDIA.length))
    expect(res.headers.get('etag')).toBe(OBJECT_ETAG)
    expect(body.length).toBe(0)
  })

  it('answers 304 for the ETag it served', async () => {
    const res = await fetch(url('/assets/clip.mp4'), { headers: { 'if-none-match': OBJECT_ETAG } })
    expect(res.status).toBe(304)
    expect((await res.arrayBuffer()).byteLength).toBe(0)
  })

  it('answers 416 for a range past the end', async () => {
    const res = await fetch(url('/assets/clip.mp4'), { headers: { range: `bytes=${MEDIA.length + 10}-` } })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe(`bytes */${MEDIA.length}`)
  })

  it('answers 404 — never pointer text — when the object is gone', async () => {
    stored = null
    const res = await fetch(url('/assets/clip.mp4'))
    const text = await res.text()
    expect(res.status).toBe(404)
    expect(text).not.toContain('oid sha256')
    expect(text).not.toContain(OID)
  })
})
