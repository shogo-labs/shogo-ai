// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A tiny S3-compatible object store for the two-process harness (SHO-494).
 *
 * A cloud process stores channel attachments, avatars and uploads in the
 * artifact bucket, and with no bucket configured `putConversationFile` throws —
 * so an upload from the cloud could never be exercised in CI, where the only
 * services are Postgres and Redis. This answers the three calls that path makes
 * (PUT, GET, HEAD, DELETE), path-style, in memory, on a port of its own.
 *
 * It is deliberately a *server*, not a mock: the API talks to it through the
 * real AWS SDK — signing, presigned URLs, `Range` — so the code under test is
 * the production code path, not a stub of it.
 */

export interface FakeS3 {
  /** Endpoint the API should be given as S3_ENDPOINT / S3_PUBLIC_ENDPOINT. */
  url: string
  /** Objects by `bucket/key`, for a test that wants to look inside. */
  objects: Map<string, { bytes: Uint8Array; contentType: string }>
  stop: () => void
}

function errorXml(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`
}

export function startFakeS3(): FakeS3 {
  const objects: FakeS3['objects'] = new Map()

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      // Path-style addressing: /<bucket>/<key...>. The presigned query string is
      // signature material for a real bucket; here it is ignored, which is what
      // lets the same server answer both signed and presigned reads.
      const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      if (!key) return new Response(errorXml('InvalidRequest', 'no bucket'), { status: 400 })

      if (request.method === 'PUT') {
        const bytes = new Uint8Array(await request.arrayBuffer())
        objects.set(key, {
          bytes,
          contentType: request.headers.get('content-type') ?? 'application/octet-stream',
        })
        const etag = `"${new Bun.CryptoHasher('md5').update(bytes).digest('hex')}"`
        return new Response(null, { status: 200, headers: { ETag: etag } })
      }

      const object = objects.get(key)
      if (request.method === 'DELETE') {
        objects.delete(key)
        return new Response(null, { status: 204 })
      }
      if (!object) {
        return new Response(errorXml('NoSuchKey', 'The specified key does not exist.'), {
          status: 404,
          headers: { 'content-type': 'application/xml' },
        })
      }

      const headers: Record<string, string> = {
        'Content-Type': object.contentType,
        'Accept-Ranges': 'bytes',
        ETag: `"${new Bun.CryptoHasher('md5').update(object.bytes).digest('hex')}"`,
      }

      if (request.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { ...headers, 'Content-Length': String(object.bytes.length) },
        })
      }

      // A range read, which the attachment route forwards from the caller.
      const range = request.headers.get('range')
      const match = range?.match(/^bytes=(\d+)-(\d*)$/)
      if (match) {
        const start = Number(match[1])
        const end = match[2] ? Math.min(Number(match[2]), object.bytes.length - 1) : object.bytes.length - 1
        if (start > end) {
          return new Response(null, {
            status: 416,
            headers: { ...headers, 'Content-Range': `bytes */${object.bytes.length}` },
          })
        }
        const slice = object.bytes.subarray(start, end + 1)
        return new Response(slice, {
          status: 206,
          headers: {
            ...headers,
            'Content-Length': String(slice.length),
            'Content-Range': `bytes ${start}-${end}/${object.bytes.length}`,
          },
        })
      }

      return new Response(object.bytes, {
        status: 200,
        headers: { ...headers, 'Content-Length': String(object.bytes.length) },
      })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    objects,
    stop: () => server.stop(true),
  }
}

/** Point a process's artifact storage at this stub. */
export function fakeS3Env(s3: FakeS3): Record<string, string> {
  return {
    S3_ENDPOINT: s3.url,
    S3_PUBLIC_ENDPOINT: s3.url,
    S3_FORCE_PATH_STYLE: 'true',
    S3_SCHEMA_BUCKET: 'shogo-artifacts',
    AWS_ACCESS_KEY_ID: 'fake-access-key',
    AWS_SECRET_ACCESS_KEY: 'fake-secret-key',
    AWS_REGION: 'us-east-1',
  }
}
