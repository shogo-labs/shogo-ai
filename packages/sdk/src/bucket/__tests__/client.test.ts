// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `shogo.bucket` — the project bucket client (SHO-491).
 *
 * `fetch` is injected, so these tests pin the wire contract: which URL each
 * verb hits, the JSON it sends, how a multipart ticket is consumed, and the
 * typed errors a route can catch. Nothing here reaches a real API.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  BucketClient,
  BucketError,
  BucketKeyExistsError,
  BucketNotConfiguredError,
  BucketPaymentRequiredError,
} from '../client'

const API = 'https://api.shogo.test'
const PROJECT = 'p_media'

interface Call {
  url: string
  method: string
  headers: Headers
  body: unknown
}

type Handler = (call: Call) => Response | Promise<Response>

let calls: Call[] = []
let handler: Handler = () => new Response('{}', { status: 200 })

const fakeFetch = (async (input: any, init: RequestInit = {}) => {
  const call: Call = {
    url: String(input),
    method: (init.method ?? 'GET').toUpperCase(),
    headers: new Headers(init.headers),
    body: init.body,
  }
  calls.push(call)
  return handler(call)
}) as unknown as typeof fetch

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

const client = (options: Partial<ConstructorParameters<typeof BucketClient>[0]> = {}) =>
  new BucketClient({
    apiUrl: API,
    projectId: PROJECT,
    runtimeToken: 'rt_test',
    fetch: fakeFetch,
    ...options,
  })

beforeEach(() => {
  calls = []
  handler = () => json({})
})

// ─── construction ───────────────────────────────────────────────────────────

describe('construction', () => {
  const saved = process.env.RUNTIME_AUTH_SECRET

  afterEach(() => {
    if (saved === undefined) delete process.env.RUNTIME_AUTH_SECRET
    else process.env.RUNTIME_AUTH_SECRET = saved
  })

  test('a project id is required — the bucket is per project', () => {
    expect(
      () => new BucketClient({ apiUrl: API, projectId: '', runtimeToken: 'rt', fetch: fakeFetch }),
    ).toThrow(/projectId/)
  })

  test('a credential is required, and the message names both options', () => {
    const savedKey = process.env.RUNTIME_AUTH_SECRET
    delete process.env.RUNTIME_AUTH_SECRET
    try {
      expect(() => new BucketClient({ apiUrl: API, projectId: PROJECT, fetch: fakeFetch })).toThrow(
        /RUNTIME_AUTH_SECRET|shogoApiKey/,
      )
    } finally {
      if (savedKey !== undefined) process.env.RUNTIME_AUTH_SECRET = savedKey
    }
  })

  test('the runtime token is sent as a header, a Shogo key as a bearer', async () => {
    handler = () => json({ objects: [], cursor: null })
    await client().list()
    expect(calls[0].headers.get('x-runtime-token')).toBe('rt_test')

    calls = []
    await client({ runtimeToken: null, shogoApiKey: 'shogo_sk_test' }).list()
    expect(calls[0].headers.get('authorization')).toBe('Bearer shogo_sk_test')
    expect(calls[0].headers.get('x-runtime-token')).toBeNull()
  })
})

// ─── URLs ───────────────────────────────────────────────────────────────────

describe('url()', () => {
  test('answers the API route until the CDN base is known', () => {
    const bucket = client()
    expect(bucket.url('media/a b.png')).toBe(
      `${API}/api/projects/${PROJECT}/bucket/objects/media/a%20b.png`,
    )
  })

  test('answers the CDN URL when the base is configured', () => {
    const bucket = client({ cdnBaseUrl: 'https://cdn.shogo.test/' })
    expect(bucket.url('renders/hero.mp4')).toBe(`https://cdn.shogo.test/${PROJECT}/renders/hero.mp4`)
  })

  test('learns the base from the first object it writes', async () => {
    handler = (call) => {
      if (call.url.endsWith('/bucket/uploads')) {
        return json({
          uploadId: 'u1',
          key: 'a.png',
          visibility: 'public',
          mode: 'single',
          url: 'https://storage.test/a.png',
          method: 'PUT',
          headers: {},
          completeUrl: 'x',
          publicUrl: `https://cdn.shogo.test/${PROJECT}/a.png`,
        })
      }
      if (call.url.includes('/complete')) {
        return json({
          key: 'a.png',
          size: 3,
          etag: 'e',
          visibility: 'public',
          publicUrl: `https://cdn.shogo.test/${PROJECT}/a.png`,
        })
      }
      return json({})
    }
    const bucket = client()
    await bucket.put('a.png', new Blob(['abc'], { type: 'image/png' }))
    expect(bucket.url('b.png')).toBe(`https://cdn.shogo.test/${PROJECT}/b.png`)
  })
})

// ─── uploads ────────────────────────────────────────────────────────────────

describe('put()', () => {
  const singleTicket = (publicUrl: string | null = null) => {
    let completed = false
    handler = (call) => {
      if (call.url.endsWith('/bucket/uploads')) {
        return json(
          {
            uploadId: 'u1',
            key: 'a.png',
            visibility: 'public',
            mode: 'single',
            url: 'https://storage.test/put/a.png',
            method: 'PUT',
            headers: { 'content-type': 'image/png' },
            completeUrl: 'x',
            publicUrl,
          },
          201,
        )
      }
      if (call.url.includes('/complete')) {
        completed = true
        return json({ key: 'a.png', size: 3, etag: 'etag1', visibility: 'public', publicUrl })
      }
      if (completed) return json({})
      return json({})
    }
  }

  test('a blob goes through one ticket → PUT → complete, and the body is the bytes', async () => {
    singleTicket(`https://cdn.shogo.test/${PROJECT}/a.png`)
    const result = await client().put('a.png', new Blob(['abc'], { type: 'image/png' }))

    expect(result).toEqual({
      key: 'a.png',
      size: 3,
      etag: 'etag1',
      visibility: 'public',
      url: `https://cdn.shogo.test/${PROJECT}/a.png`,
    })

    const ticketCall = calls.find((call) => call.url.endsWith('/bucket/uploads'))!
    expect(JSON.parse(String(ticketCall.body))).toEqual({
      key: 'a.png',
      size: 3,
      contentType: 'image/png',
      visibility: 'public',
      overwrite: false,
    })

    const put = calls.find((call) => call.url === 'https://storage.test/put/a.png')!
    expect(put.method).toBe('PUT')
    expect(put.headers.get('content-type')).toBe('image/png')
    expect(await new Response(put.body as BodyInit).text()).toBe('abc')

    const complete = calls.find((call) => call.url.includes('/complete'))!
    expect(JSON.parse(String(complete.body))).toEqual({ parts: [] })
  })

  test('overwrite:true is what allows replacing an existing key', async () => {
    singleTicket()
    await client().put('a.png', new Blob(['abc']), { overwrite: true })
    const ticketCall = calls.find((call) => call.url.endsWith('/bucket/uploads'))!
    expect(JSON.parse(String(ticketCall.body)).overwrite).toBe(true)
  })

  test('a multipart ticket uploads part by part with each ETag', async () => {
    // 4 bytes in 2-byte parts, so the slicing is observable.
    handler = (call) => {
      if (call.url.endsWith('/bucket/uploads')) {
        return json(
          {
            uploadId: 'u2',
            key: 'big.bin',
            visibility: 'public',
            mode: 'multipart',
            url: 'https://storage.test/multipart',
            method: 'PUT',
            headers: {},
            completeUrl: 'x',
            publicUrl: null,
            partSize: 2,
            parts: [
              { partNumber: 1, url: 'https://storage.test/part/1' },
              { partNumber: 2, url: 'https://storage.test/part/2' },
            ],
          },
          201,
        )
      }
      if (call.url.startsWith('https://storage.test/part/')) {
        return new Response(null, {
          status: 200,
          headers: { etag: `"etag-${call.url.slice(-1)}"` },
        })
      }
      return json({ key: 'big.bin', size: 4, etag: 'e', visibility: 'public', publicUrl: null })
    }

    const bucket = client({ cdnBaseUrl: 'https://cdn.shogo.test' })
    const result = await bucket.put('big.bin', new Blob(['abcd']))

    expect(result.size).toBe(4)
    const parts = calls.filter((call) => call.url.startsWith('https://storage.test/part/'))
    expect(parts.map((call) => call.url)).toEqual([
      'https://storage.test/part/1',
      'https://storage.test/part/2',
    ])
    expect(await new Response(parts[0].body as BodyInit).text()).toBe('ab')
    expect(await new Response(parts[1].body as BodyInit).text()).toBe('cd')

    const complete = calls.find((call) => call.url.includes('/complete'))!
    expect(JSON.parse(String(complete.body))).toEqual({
      parts: [
        { ETag: '"etag-1"', PartNumber: 1 },
        { ETag: '"etag-2"', PartNumber: 2 },
      ],
    })
  })

  test('a part without an ETag is a hard failure, not a silent partial upload', async () => {
    handler = (call) => {
      if (call.url.endsWith('/bucket/uploads')) {
        return json(
          {
            uploadId: 'u3',
            key: 'big.bin',
            visibility: 'public',
            mode: 'multipart',
            url: 'x',
            method: 'PUT',
            headers: {},
            completeUrl: 'x',
            publicUrl: null,
            partSize: 2,
            parts: [{ partNumber: 1, url: 'https://storage.test/part/1' }],
          },
          201,
        )
      }
      if (call.url.startsWith('https://storage.test/part/')) {
        return new Response(null, { status: 200 })
      }
      return json({})
    }
    await expect(client().put('big.bin', new Blob(['abcd']))).rejects.toThrow(/ETag/)
  })

  test('a failed upload releases the ticket it minted', async () => {
    handler = (call) => {
      if (call.url.endsWith('/bucket/uploads')) {
        return json(
          {
            uploadId: 'u4',
            key: 'a.png',
            visibility: 'public',
            mode: 'single',
            url: 'https://storage.test/put/a.png',
            method: 'PUT',
            headers: {},
            completeUrl: 'x',
            publicUrl: null,
          },
          201,
        )
      }
      return new Response('nope', { status: 500 })
    }
    await expect(client().put('a.png', new Blob(['abc']))).rejects.toBeInstanceOf(BucketError)
    const abort = calls.find((call) => call.url.endsWith('/bucket/uploads/u4') && call.method === 'DELETE')
    expect(abort).toBeDefined()
  })
})

// ─── errors ─────────────────────────────────────────────────────────────────

describe('typed errors', () => {
  test('bucket_payment_required keeps the numbers and the Billing link', async () => {
    handler = () =>
      json(
        {
          error: {
            code: 'bucket_payment_required',
            message: 'over the allowance',
            reason: 'usage_limit_reached',
            usedBytes: 12,
            allowanceBytes: 10,
            usdPerGbMonth: 0.02,
            billingUrl: 'https://app.test/billing?workspace=ws_1',
          },
        },
        402,
      )

    const error = await client()
      .put('a.png', new Blob(['abc']))
      .catch((caught) => caught)

    expect(error).toBeInstanceOf(BucketPaymentRequiredError)
    expect(error.code).toBe('bucket_payment_required')
    expect(error.status).toBe(402)
    expect(error.reason).toBe('usage_limit_reached')
    expect(error.usedBytes).toBe(12)
    expect(error.allowanceBytes).toBe(10)
    expect(error.billingUrl).toContain('/billing?workspace=ws_1')
  })

  test('key_exists and bucket_not_configured map to their own classes', async () => {
    handler = () => json({ error: { code: 'key_exists', message: 'taken' } }, 409)
    expect(await client().put('a.png', new Blob(['abc'])).catch((e) => e)).toBeInstanceOf(
      BucketKeyExistsError,
    )

    handler = () => json({ error: { code: 'bucket_not_configured', message: 'no bucket' } }, 503)
    expect(await client().list().catch((e) => e)).toBeInstanceOf(BucketNotConfiguredError)
  })

  test('an unknown code keeps its code and status', async () => {
    handler = () => json({ error: { code: 'invalid_key', message: 'bad key' } }, 400)
    const error = await client().list().catch((e) => e)
    expect(error).toBeInstanceOf(BucketError)
    expect(error.code).toBe('invalid_key')
    expect(error.status).toBe(400)
  })

  test('a non-JSON body still yields a usable error', async () => {
    handler = () => new Response('<html>502</html>', { status: 502 })
    const error = await client().list().catch((e) => e)
    expect(error).toBeInstanceOf(BucketError)
    expect(error.code).toBe('http_502')
    expect(error.status).toBe(502)
  })
})

// ─── reads ──────────────────────────────────────────────────────────────────

describe('signedUrl / list / delete / usage', () => {
  test('signedUrl asks for the visibility and expiry, and returns the URL', async () => {
    handler = () => json({ url: 'https://cdn.shogo.test/p_media/x.png', key: 'x.png', visibility: 'public' })
    const url = await client().signedUrl('x.png', { expiresIn: 120 })
    expect(url).toBe('https://cdn.shogo.test/p_media/x.png')

    const call = calls[0]
    expect(call.url).toContain('/bucket/objects/x.png?')
    expect(call.url).toContain('visibility=public')
    expect(call.url).toContain('expiresIn=120')
    expect(call.url).toContain('url=1')
  })

  test('signedUrl for a private object says private', async () => {
    handler = () => json({ url: 'u' })
    await client().signedUrl('x.png', { public: false })
    expect(calls[0].url).toContain('visibility=private')
  })

  test('list passes prefix/visibility/limit/cursor and returns the page', async () => {
    handler = () =>
      json({
        objects: [{ key: 'a.png', visibility: 'public', size: 1 }],
        cursor: 'a.png',
        publicBaseUrl: 'https://cdn.shogo.test',
      })
    const page = await client().list({ prefix: 'media/', visibility: 'private', limit: 5, cursor: 'z' })
    expect(page.cursor).toBe('a.png')
    expect(page.objects).toHaveLength(1)
    const url = calls[0].url
    expect(url).toContain('prefix=media%2F')
    expect(url).toContain('visibility=private')
    expect(url).toContain('limit=5')
    expect(url).toContain('cursor=z')
  })

  test('delete reports what it removed', async () => {
    handler = () => json({ key: 'a.png', visibility: 'private' })
    const result = await client().delete('a.png', { public: false })
    expect(result).toEqual({ key: 'a.png', visibility: 'private' })
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toContain('visibility=private')
  })

  test('usage returns the numbers and teaches url() the public base', async () => {
    handler = () =>
      json({
        projectBytes: 10,
        projectObjects: 1,
        workspaceId: 'ws_1',
        workspaceUsedBytes: 10,
        allowanceBytes: 100,
        billingMode: 'shadow',
        usdPerGbMonth: 0.02,
        publicBaseUrl: 'https://cdn.shogo.test',
      })
    const bucket = client()
    const usage = await bucket.usage()
    expect(usage.billingMode).toBe('shadow')
    expect(usage.allowanceBytes).toBe(100)
    expect(bucket.url('a.png')).toBe(`https://cdn.shogo.test/${PROJECT}/a.png`)
  })
})
