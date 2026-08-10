// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * describeObject — the "look, don't download" step that makes a multi-gigabyte
 * cold boot possible.
 *
 * The properties worth pinning are all about what it DOESN'T do: it must not
 * read the object, it must not turn an S3 outage into "this project has no
 * backup" (that is how a template gets served over real source and then written
 * back over it), and it must not fail a hydrate just because presigning is
 * unavailable.
 */

import { describe, expect, test } from 'bun:test'
import { describeObject } from './archive-ref'

interface FakeOpts {
  exists?: boolean
  etag?: string | null
  size?: number | null
  statThrows?: boolean
  existsThrows?: boolean
  presignThrows?: boolean
}

function fakeClient(opts: FakeOpts) {
  const calls = { exists: 0, stat: 0, presign: 0, download: 0 }
  const client = {
    file(key: string) {
      return {
        key,
        async exists() {
          calls.exists++
          if (opts.existsThrows) throw new Error('connection reset')
          return opts.exists ?? true
        },
        async stat() {
          calls.stat++
          if (opts.statThrows) throw new Error('stat blew up')
          return { etag: opts.etag ?? null, size: opts.size ?? null }
        },
        presign() {
          calls.presign++
          if (opts.presignThrows) throw new Error('cannot presign')
          return `https://s3.example/${key}?X-Amz-Signature=sig`
        },
        async arrayBuffer() {
          calls.download++
          return new Uint8Array([1, 2, 3]).buffer
        },
      }
    },
  }
  return { client: client as any, calls }
}

describe('describeObject', () => {
  test('reports lineage, size and a presigned URL without reading the object', async () => {
    const { client, calls } = fakeClient({ etag: '"abc"', size: 1234 })

    const ref = await describeObject(client, 'p1/project-src.tar.gz', 900)

    expect(ref).not.toBeNull()
    expect(ref!.etag).toBe('"abc"')
    expect(ref!.bytes).toBe(1234)
    expect(ref!.url).toContain('p1/project-src.tar.gz')
    // The entire point: a 2 GB archive must not pass through the host.
    expect(calls.download).toBe(0)
  })

  test('downloads only when the caller asks, for the push fallback', async () => {
    const { client, calls } = fakeClient({ etag: '"abc"', size: 3 })
    const ref = await describeObject(client, 'k', 900)

    expect(calls.download).toBe(0)
    expect(await ref!.load()).toEqual(new Uint8Array([1, 2, 3]))
    expect(calls.download).toBe(1)
  })

  test('returns null when the object does not exist', async () => {
    const { client, calls } = fakeClient({ exists: false })
    expect(await describeObject(client, 'missing', 900)).toBeNull()
    expect(calls.stat).toBe(0)
  })

  test('propagates a transport error instead of reporting the object absent', async () => {
    // "No backup" and "cannot reach S3" must never collapse into one answer.
    // Hydrate is fail-closed precisely so an outage cannot be mistaken for a
    // new project, which would serve the template over real source.
    const { client } = fakeClient({ existsThrows: true })
    await expect(describeObject(client, 'k', 900)).rejects.toThrow(/connection reset/)
  })

  test('still describes the object when stat fails', async () => {
    // Losing the ETag costs lineage (a later export quarantines rather than
    // overwrites) and losing the size costs deadline precision. Both are better
    // than failing a hydrate that would otherwise work.
    const { client } = fakeClient({ statThrows: true })
    const ref = await describeObject(client, 'k', 900)
    expect(ref).not.toBeNull()
    expect(ref!.etag).toBeNull()
    expect(ref!.bytes).toBe(0)
    expect(ref!.url).toBeTruthy()
  })

  test('falls back to no URL when the store cannot presign', async () => {
    // The caller reads a null URL as "push the bytes", so a store without
    // presigning degrades to the old behaviour rather than to an outage.
    const { client } = fakeClient({ presignThrows: true, etag: '"e"', size: 10 })
    const ref = await describeObject(client, 'k', 900)
    expect(ref!.url).toBeNull()
    expect(ref!.etag).toBe('"e"')
  })
})
