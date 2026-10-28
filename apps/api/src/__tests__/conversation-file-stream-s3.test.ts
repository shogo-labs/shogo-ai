// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-240, driven the way the browser drives it: over real HTTP, through the
 * real route, with the real AWS SDK talking to a real (fake) object store.
 *
 * The card's bug is that `GET /conversation-files/:id` answered a script fetch
 * with a `302` to presigned object storage, and the bucket's `ACAO: *` is
 * refused for a credentialed cross-origin request. The sibling
 * `conversation-file-stream.test.ts` proves the route's branch against a stubbed
 * read; this file proves the part a stub cannot — that the bytes really do come
 * through the API: `GetObjectCommand` over the wire, `Body.transformToWebStream`
 * in the SDK, chunks arriving before the object has finished uploading, and the
 * `Range` header reaching storage instead of being sliced in memory.
 *
 * Only the database and the browser's CORS enforcement are absent.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const OBJECT_BYTES = new Uint8Array(1024 * 1024)
for (let i = 0; i < OBJECT_BYTES.length; i++) OBJECT_BYTES[i] = (i * 7) % 251

const OBJECT_KEY = 'artifacts/conversations/ws-1/conv-1/pdf-240/Job_Description_3pg.docx.pdf'

const attachment = {
  id: 'att-qa-240',
  conversationId: 'conv-1',
  storageKey: OBJECT_KEY,
  name: 'Job Description 3pg.docx.pdf',
  mimeType: 'application/pdf',
  size: OBJECT_BYTES.byteLength,
}

// ─── the object store: a real HTTP server, plus the request log ──────────────

interface StorageRequest {
  method: string
  range: string | null
  path: string
}

const storageRequests: StorageRequest[] = []

/** Lets the test hold the tail of an object back to prove chunks are live. */
let tailGate: { promise: Promise<void>; release: () => void } | null = null
let gatedTailFrom = -1

function openGate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const storage = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const path = decodeURIComponent(url.pathname)
    const range = request.headers.get('range')

    storageRequests.push({ method: request.method, range, path })
    if (request.method !== 'GET' || !path.includes(OBJECT_KEY)) {
      return new Response('not found', { status: 404 })
    }

    let start = 0
    let end = OBJECT_BYTES.byteLength - 1
    let status = 200
    const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null
    if (match) {
      start = Number(match[1])
      end = match[2] ? Math.min(Number(match[2]), end) : end
      if (start >= OBJECT_BYTES.byteLength) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${OBJECT_BYTES.byteLength}` },
        })
      }
      status = 206
    }

    const slice = OBJECT_BYTES.subarray(start, end + 1)
    const headers: Record<string, string> = {
      'Content-Type': 'application/pdf',
      'Content-Length': String(slice.byteLength),
      'Accept-Ranges': 'bytes',
    }
    if (status === 206) {
      headers['Content-Range'] = `bytes ${start}-${end}/${OBJECT_BYTES.byteLength}`
    }

    // A plain body so the object store states the length the way the real one
    // does; the gated case below is the only one that has to stream.
    if (gatedTailFrom <= 0) return new Response(slice.slice(), { status, headers })

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const cut = Math.min(gatedTailFrom, slice.byteLength)
        controller.enqueue(slice.subarray(0, cut))
        await tailGate!.promise
        controller.enqueue(slice.subarray(cut))
        controller.close()
      },
    })

    return new Response(stream, { status, headers })
  },
})

// ─── the database the route reads (cloud rows; no Postgres here) ─────────────

mock.module('../lib/prisma', () => ({
  prisma: {
    conversationAttachment: {
      findUnique: mock(async ({ where }: any) => (where.id === attachment.id ? attachment : null)),
    },
    conversation: { findUnique: mock(async () => ({ workspaceId: 'ws-1' })) },
  },
}))

const realChatMode = await import('../services/chat-mode')
mock.module('../services/chat-mode', () => ({ ...realChatMode, getWorkspaceChatConfig: async () => ({ mode: 'on' }) }))

// Cloud mode: no SHOGO_LOCAL_MODE, and storage points at the server above.
delete process.env.SHOGO_LOCAL_MODE
process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'qa-sho-240-signing-secret'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'qa-sho-240-auth-secret'
process.env.AWS_REGION = 'us-east-1'
process.env.S3_ARTIFACT_BUCKET = 'shogo-workspaces-production'
process.env.S3_ARTIFACT_ENDPOINT = `http://127.0.0.1:${storage.port}`
process.env.S3_ARTIFACT_FORCE_PATH_STYLE = 'true'
process.env.S3_ARTIFACT_ACCESS_KEY_ID = 'qa-access-key'
process.env.S3_ARTIFACT_SECRET_ACCESS_KEY = 'qa-secret-key'

const realFiles = await import('../lib/conversation-files')
const { conversationRoutes } = await import('../routes/conversations')

const routes = conversationRoutes({ resolveUserId: async () => null })
const app = new Hono()
app.route('/api', routes)

const api = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) })
const base = `http://127.0.0.1:${api.port}/api/conversation-files/${attachment.id}`
const token = realFiles.signAttachmentToken(attachment.id)

const get = (headers: Record<string, string> = {}, search = `?t=${token}`) =>
  fetch(`${base}${search}`, { headers, redirect: 'manual' })

beforeEach(() => {
  storageRequests.length = 0
  tailGate = null
  gatedTailFrom = -1
})

afterAll(() => {
  storage.stop(true)
  api.stop(true)
})

describe('SHO-240: GET /conversation-files/:id in cloud mode, over real HTTP', () => {
  test('a script fetch gets 200 and the object itself, not a redirect to storage', async () => {
    const response = await get({ 'sec-fetch-mode': 'cors' })

    expect(response.status).toBe(200)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-disposition')).toContain('inline')
    // Bun re-frames a streamed body as chunked, so the outer response may or may
    // not carry the length; what matters is that the bytes are the object.
    const declared = response.headers.get('content-length')
    if (declared !== null) expect(declared).toBe(String(OBJECT_BYTES.byteLength))
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(OBJECT_BYTES)

    // The bytes came from storage through the API — one object GET, no browser
    // hop (a redirect would leave storage untouched here).
    expect(storageRequests).toHaveLength(1)
    expect(storageRequests[0]!.method).toBe('GET')
    expect(storageRequests[0]!.range).toBeNull()
    expect(storageRequests[0]!.path).toContain(OBJECT_KEY)
  })

  test('a navigation, an image load and a client with no fetch metadata still get the cheap 302', async () => {
    for (const headers of [{ 'sec-fetch-mode': 'navigate' }, { 'sec-fetch-mode': 'no-cors' }, {}]) {
      const response = await get(headers)
      expect(response.status).toBe(302)
      const location = response.headers.get('location') ?? ''
      expect(location).toContain('X-Amz-Signature')
      expect(location).toContain(OBJECT_KEY)
    }
    // Nothing was read: the whole point of keeping the redirect.
    expect(storageRequests).toHaveLength(0)
  })

  test('a Range reaches storage as a Range and comes back 206 with the right Content-Range', async () => {
    const response = await get({ 'sec-fetch-mode': 'cors', range: 'bytes=0-99' })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes 0-99/${OBJECT_BYTES.byteLength}`)
    expect(response.headers.get('content-length')).toBe('100')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(OBJECT_BYTES.slice(0, 100))

    // Forwarded, not sliced in memory: the API asked storage for those bytes.
    expect(storageRequests).toHaveLength(1)
    expect(storageRequests[0]!.range).toBe('bytes=0-99')
  })

  test('the body streams: the first chunk arrives while storage still holds the rest', async () => {
    tailGate = openGate()
    gatedTailFrom = 64 * 1024

    const response = await get({ 'sec-fetch-mode': 'cors' })
    expect(response.status).toBe(200)

    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    // Storage has not been released yet, so these bytes can only be live ones.
    expect(first.value!.byteLength).toBeGreaterThan(0)
    expect(first.value!.byteLength).toBeLessThan(OBJECT_BYTES.byteLength)

    tailGate.release()
    let received = first.value!.byteLength
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value!.byteLength
    }
    expect(received).toBe(OBJECT_BYTES.byteLength)
  })

  test('a download (?dl=1) streams with an attachment disposition', async () => {
    const response = await get({ 'sec-fetch-mode': 'cors' }, `?t=${token}&dl=1`)

    expect(response.status).toBe(200)
    const disposition = response.headers.get('content-disposition') ?? ''
    expect(disposition).toContain('attachment')
    expect(disposition).not.toContain('inline')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(OBJECT_BYTES)
  })

  test('a same-origin fetch (the app reading its own API) also gets the bytes', async () => {
    const response = await get({ 'sec-fetch-mode': 'same-origin' })

    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(OBJECT_BYTES)
  })

  test('a bad token is refused before storage is touched', async () => {
    const response = await get({ 'sec-fetch-mode': 'cors' }, '?t=deadbeef.abc')

    expect(response.status).toBe(403)
    expect(storageRequests).toHaveLength(0)
  })
})
