// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `openLfsObjectStream` — the read side of the object store (SHO-485 §1a).
 *
 * A published pod has no media on disk: the pointer file names the object and
 * this opens it, ranged when a `<video>` seeks. What is pinned here is the
 * contract the HTTP layer relies on: status, the store's ETag (the one a
 * length-known body actually serves), range math, the length, and that a
 * missing object is `missing` (a 404) rather than a throw or pointer text.
 *
 * `lengthKnown` matters as much as the bytes: `Bun.serve` answers a piped
 * stream with chunked encoding and no `Content-Length`, so the HTTP layer must
 * know which body shape it got (QA round 1).
 */
import { describe, expect, it } from 'bun:test'
import { openLfsObjectStream, parseLfsPointer, lfsPointerText } from '../lfs'

const OID = 'a'.repeat(64)
const BODY = Buffer.from('0123456789abcdef')
const STORE_ETAG = '"etag-from-store"'

/** A store whose single object is `BODY`, recording the commands it received. */
function storeWith(options: { present?: boolean; lengthKnown?: boolean } = {}) {
  const commands: any[] = []
  const present = options.present !== false
  const store: any = {
    bucket: 'workspaces',
    client: {
      async send(command: any) {
        commands.push(command)
        if (command.constructor.name === 'HeadObjectCommand') {
          if (!present) throw notFound()
          return { ETag: STORE_ETAG, ContentLength: BODY.length }
        }
        if (!present) throw notFound()
        const range = command.input.Range as string | undefined
        const body = range ? BODY.subarray(...(parseRange(range) as [number, number])) : BODY
        return { Body: new Blob([body]).stream(), ContentLength: body.length }
      },
    },
  }
  if (options.lengthKnown !== false) {
    store.bodyFile = () => new Blob([BODY], { type: 'video/mp4' })
  }
  return { store, commands }
}

function parseRange(range: string): [number, number] {
  const [start, end] = /^bytes=(\d+)-(\d+)$/.exec(range)!.slice(1).map(Number)
  return [start, end + 1]
}

function notFound(): Error {
  const err: any = new Error('NotFound')
  err.name = 'NotFound'
  err.$metadata = { httpStatusCode: 404 }
  return err
}

describe('openLfsObjectStream', () => {
  it('hands back a length-known body and the store’s ETag', async () => {
    const { store, commands } = storeWith()
    const res = await openLfsObjectStream({ projectId: 'proj-1', oid: OID, size: BODY.length, store })
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.lengthKnown).toBe(true)
    expect(res.contentLength).toBe(BODY.length)
    expect(res.totalSize).toBe(BODY.length)
    expect(res.etag).toBe(STORE_ETAG)
    expect(res.contentRange).toBeUndefined()
    expect(Buffer.from(await new Response(res.body as any).arrayBuffer())).toEqual(BODY)
    // One HEAD for existence + ETag + size; the body comes from the store on demand.
    expect(commands.map((c) => c.constructor.name)).toEqual(['HeadObjectCommand'])
  })

  it('reports the slice it would serve, and lets the host do the ranging', async () => {
    const { store, commands } = storeWith()
    const res = await openLfsObjectStream({
      projectId: 'proj-1',
      oid: OID,
      size: BODY.length,
      store,
      range: 'bytes=4-7',
    })
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.contentRange).toBe(`bytes 4-7/${BODY.length}`)
    expect(res.contentLength).toBe(4)
    // The length-known body is the whole object; Bun applies the request's Range
    // itself, so no ranged GetObject is issued.
    expect(commands.some((c) => c.input?.Range)).toBe(false)
  })

  it('resolves a suffix range (`bytes=-4`) to the tail', async () => {
    const { store } = storeWith()
    const res = await openLfsObjectStream({
      projectId: 'proj-1',
      oid: OID,
      size: BODY.length,
      store,
      range: 'bytes=-4',
    })
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.contentRange).toBe(`bytes ${BODY.length - 4}-${BODY.length - 1}/${BODY.length}`)
  })

  it('reports an unsatisfiable range instead of a truncated body', async () => {
    const { store } = storeWith()
    const res = await openLfsObjectStream({
      projectId: 'proj-1',
      oid: OID,
      size: BODY.length,
      store,
      range: 'bytes=999-1000',
    })
    expect(res.status).toBe('unsatisfiable')
    if (res.status !== 'unsatisfiable') return
    expect(res.totalSize).toBe(BODY.length)
  })

  it('answers 304 against the ETag the body will actually serve', async () => {
    const { store } = storeWith()
    const res = await openLfsObjectStream({
      projectId: 'proj-1',
      oid: OID,
      size: BODY.length,
      store,
      ifNoneMatch: `W/${STORE_ETAG}, "other"`,
    })
    expect(res.status).toBe('not-modified')
    if (res.status !== 'not-modified') return
    expect(res.etag).toBe(STORE_ETAG)
  })

  it('is missing, not an error, for an object the store does not have', async () => {
    const { store } = storeWith({ present: false })
    const res = await openLfsObjectStream({ projectId: 'proj-1', oid: OID, size: BODY.length, store })
    expect(res.status).toBe('missing')
  })

  it('HEADs the object rather than opening a body', async () => {
    const { store, commands } = storeWith()
    const res = await openLfsObjectStream({ projectId: 'proj-1', oid: OID, size: BODY.length, store, head: true })
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.body).toBeNull()
    expect(res.contentLength).toBe(BODY.length)
    expect(commands.map((c) => c.constructor.name)).toEqual(['HeadObjectCommand'])
  })

  it('falls back to a piped, ranged GetObject when the host has no S3 file', async () => {
    const { store, commands } = storeWith({ lengthKnown: false })
    const res = await openLfsObjectStream({
      projectId: 'proj-1',
      oid: OID,
      size: BODY.length,
      store,
      range: 'bytes=4-7',
    })
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.lengthKnown).toBe(false)
    expect(res.contentLength).toBe(4)
    expect(res.contentRange).toBe(`bytes 4-7/${BODY.length}`)
    expect(commands.at(-1).input.Range).toBe('bytes=4-7')
    expect(Buffer.from(await new Response(res.body as any).arrayBuffer())).toEqual(BODY.subarray(4, 8))
  })

  it('prefers the store’s own length over a stale pointer', async () => {
    const { store } = storeWith()
    const res = await openLfsObjectStream({ projectId: 'proj-1', oid: OID, size: 3, store })
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.totalSize).toBe(BODY.length)
  })

  it('reads the same key layout the materializer writes', async () => {
    const { store, commands } = storeWith()
    await openLfsObjectStream({ projectId: 'proj-1', oid: OID, size: BODY.length, store })
    expect(commands[0].input.Key).toBe(`proj-1/lfs/objects/aa/aa/${OID}`)
  })

  it('agrees with the pointer text the artifact writes', () => {
    const pointer = parseLfsPointer(lfsPointerText(OID, BODY.length))
    expect(pointer).toEqual({ oid: OID, size: BODY.length })
  })
})
