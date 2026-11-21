// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `openLfsObjectStream` — the read side of the object store (SHO-485 §1a).
 *
 * A published pod has no media on disk: the pointer file names the object and
 * this streams it, ranged when a `<video>` seeks. What is pinned here is the
 * contract the HTTP layer relies on: status, the exact slice, the length, the
 * ETag, and that a missing object is `missing` (a 404) rather than a throw or
 * pointer text.
 */
import { describe, expect, it } from 'bun:test'
import { openLfsObjectStream, parseLfsPointer, lfsPointerText } from '../lfs'

const OID = 'a'.repeat(64)
const BODY = Buffer.from('0123456789abcdef')

/** A store whose single object is `BODY`, recording the commands it received. */
function storeWith(options: { present?: boolean } = {}) {
  const commands: any[] = []
  return {
    commands,
    store: {
      bucket: 'workspaces',
      client: {
        async send(command: any) {
          commands.push(command)
          if (command.constructor.name === 'HeadObjectCommand') {
            if (options.present === false) throw notFound()
            return {}
          }
          if (options.present === false) throw notFound()
          const range = command.input.Range as string | undefined
          const body = range ? BODY.subarray(...(parseRange(range) as [number, number])) : BODY
          return { Body: new Blob([body]).stream(), ContentLength: body.length }
        },
      },
    },
  }
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
  it('streams the whole object with the pointer’s length and an oid ETag', async () => {
    const { store } = storeWith()
    const res = await openLfsObjectStream({ projectId: 'proj-1', oid: OID, size: BODY.length, store })
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.contentLength).toBe(BODY.length)
    expect(res.totalSize).toBe(BODY.length)
    expect(res.etag).toBe(`"${OID}"`)
    expect(res.contentRange).toBeUndefined()
    expect(Buffer.from(await new Response(res.body as any).arrayBuffer())).toEqual(BODY)
  })

  it('asks the store only for the requested slice', async () => {
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
    expect((commands.at(-1) as any).input.Range).toBe('bytes=4-7')
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

  it('answers 304 from the ETag without touching the store', async () => {
    const { store, commands } = storeWith()
    const res = await openLfsObjectStream({
      projectId: 'proj-1',
      oid: OID,
      size: BODY.length,
      store,
      ifNoneMatch: `W/"${OID}", "other"`,
    })
    expect(res.status).toBe('not-modified')
    expect(commands.length).toBe(0)
  })

  it('is missing, not an error, for an object the store does not have', async () => {
    const { store } = storeWith({ present: false })
    const res = await openLfsObjectStream({ projectId: 'proj-1', oid: OID, size: BODY.length, store })
    expect(res.status).toBe('missing')
  })

  it('HEADs the object rather than streaming it', async () => {
    const { store, commands } = storeWith()
    const res = await openLfsObjectStream({ projectId: 'proj-1', oid: OID, size: BODY.length, store, head: true })
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.body).toBeNull()
    expect(res.contentLength).toBe(BODY.length)
    expect(commands.map((c) => c.constructor.name)).toEqual(['HeadObjectCommand'])
  })

  it('reads the same key layout the materializer writes', async () => {
    const { store, commands } = storeWith()
    await openLfsObjectStream({ projectId: 'proj-1', oid: OID, size: BODY.length, store })
    expect((commands.at(-1) as any).input.Key).toBe(`proj-1/lfs/objects/aa/aa/${OID}`)
  })

  it('agrees with the pointer text the artifact writes', () => {
    const pointer = parseLfsPointer(lfsPointerText(OID, BODY.length))
    expect(pointer).toEqual({ oid: OID, size: BODY.length })
  })
})
