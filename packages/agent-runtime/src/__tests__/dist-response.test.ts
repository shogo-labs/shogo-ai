// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Serving `dist/` with media that is not on disk (SHO-485 §1a/§1b).
 *
 * Two failures motivated this: `readFileSync` per request, so a 300 MB video
 * cost 300 MB of heap per concurrent request and `<video>` could not seek; and
 * a published pod that materialized every LFS object onto its 2 Gi volume at
 * boot. A file whose content is an LFS pointer is now answered from the object
 * store, streamed and ranged, and a pointer with no object behind it is a 404 —
 * never pointer text.
 *
 * Driven against a real directory and a fake store, so it exercises the real
 * function rather than a mock of it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveDistResponse, type DistServeContext } from '../dist-response'
import { lfsPointerText } from '@shogo/shared-runtime'

let distDir: string

/** An LFS object store whose objects are in memory. */
function fakeLfsStore(objects: Map<string, Buffer>) {
  return {
    bucket: 'workspaces',
    client: {
      async send(command: any) {
        const key = command.input.Key as string
        if (command.constructor.name === 'HeadObjectCommand') {
          if (!objects.has(key)) {
            const err: any = new Error('NotFound')
            err.name = 'NotFound'
            err.$metadata = { httpStatusCode: 404 }
            throw err
          }
          return {}
        }
        const body = objects.get(key)
        if (!body) {
          const err: any = new Error('NoSuchKey')
          err.name = 'NoSuchKey'
          err.$metadata = { httpStatusCode: 404 }
          throw err
        }
        const range = command.input.Range as string | undefined
        const slice = range ? sliceFor(body, range) : body
        return {
          Body: new Blob([new Uint8Array(slice)]).stream(),
          ContentLength: slice.length,
          ...(range ? { ContentRange: range.replace('bytes=', 'bytes ') + `/${body.length}` } : {}),
        }
      },
    },
  }
}

function sliceFor(body: Buffer, range: string): Buffer {
  const [, raw] = /^bytes=(\d+-\d+)$/.exec(range) ?? []
  const [start, end] = raw.split('-').map(Number)
  return body.subarray(start, end + 1)
}

const context = (store?: ReturnType<typeof fakeLfsStore>): DistServeContext => ({
  lfs: store ? { store, projectId: 'proj-1' } : null,
  injectHtml: (html) => `${html}<!--injected-->`,
  renderBuildingPlaceholder: () => new Response('building', { status: 503 }),
})

const serve = (requestPath: string, opts: Partial<Parameters<typeof serveDistResponse>[0]> = {}, store?: ReturnType<typeof fakeLfsStore>) =>
  serveDistResponse(
    { distDir, requestPath, buildInFlight: false, method: 'GET', ...opts },
    context(store),
  )

const oidOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const objectKey = (oid: string) => `proj-1/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`

beforeEach(() => {
  distDir = mkdtempSync(join(tmpdir(), 'shogo-dist-response-'))
  mkdirSync(join(distDir, 'assets'), { recursive: true })
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>app</title>')
  writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("hello")\n')
  writeFileSync(join(distDir, 'assets', 'logo.png'), Buffer.alloc(1024, 3))
})

afterEach(() => {
  rmSync(distDir, { recursive: true, force: true })
})

describe('serveDistResponse — files on disk', () => {
  it('streams a real file with its length and type instead of reading it into heap', async () => {
    const res = await serve('/assets/app.js')
    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('application/javascript')
    expect(res?.headers.get('content-length')).toBe(String(statSync(join(distDir, 'assets/app.js')).size))
    expect(res?.headers.get('accept-ranges')).toBe('bytes')
    expect(await res!.text()).toBe('console.log("hello")\n')
  })

  it('answers a Range with 206 and the exact slice, so a player can seek', async () => {
    const res = await serve('/assets/logo.png', { range: 'bytes=0-15' })
    expect(res?.status).toBe(206)
    expect(res?.headers.get('content-range')).toBe('bytes 0-15/1024')
    expect(res?.headers.get('content-length')).toBe('16')
    expect((await res!.arrayBuffer()).byteLength).toBe(16)
  })

  it('answers HEAD with the headers and no body', async () => {
    const res = await serve('/assets/logo.png', { method: 'HEAD' })
    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-length')).toBe('1024')
    expect(await res!.text()).toBe('')
  })

  it('still injects the runtime bridge into HTML', async () => {
    const res = await serve('/')
    expect(res?.headers.get('content-type')).toBe('text/html')
    expect(await res!.text()).toContain('<!--injected-->')
  })
})

describe('serveDistResponse — LFS pointers', () => {
  it('serves the object’s bytes with the request path’s type, length and ETag', async () => {
    const media = Buffer.alloc(300 * 1024, 7)
    const oid = oidOf(media)
    writeFileSync(join(distDir, 'assets', 'clip.mp4'), lfsPointerText(oid, media.length))
    const store = fakeLfsStore(new Map([[objectKey(oid), media]]))

    const res = await serve('/assets/clip.mp4', {}, store)
    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('video/mp4')
    expect(res?.headers.get('content-length')).toBe(String(media.length))
    expect(res?.headers.get('etag')).toBe(`"${oid}"`)
    expect(res?.headers.get('accept-ranges')).toBe('bytes')
    const body = Buffer.from(await res!.arrayBuffer())
    expect(body.length).toBe(media.length)
    expect(oidOf(body)).toBe(oid)
  })

  it('ranges the object from the store', async () => {
    const media = Buffer.alloc(4096, 5)
    const oid = oidOf(media)
    writeFileSync(join(distDir, 'assets', 'clip.mp4'), lfsPointerText(oid, media.length))
    const store = fakeLfsStore(new Map([[objectKey(oid), media]]))

    const res = await serve('/assets/clip.mp4', { range: 'bytes=100-199' }, store)
    expect(res?.status).toBe(206)
    expect(res?.headers.get('content-range')).toBe(`bytes 100-199/${media.length}`)
    expect((await res!.arrayBuffer()).byteLength).toBe(100)
  })

  it('answers 304 when the client already has the object', async () => {
    const media = Buffer.alloc(64, 1)
    const oid = oidOf(media)
    writeFileSync(join(distDir, 'assets', 'clip.mp4'), lfsPointerText(oid, media.length))
    const store = fakeLfsStore(new Map([[objectKey(oid), media]]))

    const res = await serve('/assets/clip.mp4', { ifNoneMatch: `"${oid}"` }, store)
    expect(res?.status).toBe(304)
  })

  it('404s a pointer whose object is missing, and never serves pointer text', async () => {
    const oid = oidOf(Buffer.from('gone'))
    writeFileSync(join(distDir, 'assets', 'clip.mp4'), lfsPointerText(oid, 12345))
    const res = await serve('/assets/clip.mp4', {}, fakeLfsStore(new Map()))

    expect(res?.status).toBe(404)
    const body = await res!.text()
    expect(body).not.toContain('git-lfs.github.com')
  })

  it('serves a project with no LFS exactly as before', async () => {
    // No pointer anywhere: the same bytes, from disk.
    const res = await serve('/assets/logo.png', {}, fakeLfsStore(new Map()))
    expect(res?.status).toBe(200)
    expect(Buffer.from(await res!.arrayBuffer())).toEqual(readFileSync(join(distDir, 'assets', 'logo.png')))
  })
})
