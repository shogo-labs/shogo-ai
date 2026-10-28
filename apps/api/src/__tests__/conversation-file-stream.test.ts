// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloud file routes serve a script fetch the bytes instead of the 302.
 *
 * In cloud mode every one of these routes answers with a redirect to a
 * presigned object-storage URL. An `<img>`, `<video>` or a link click follows
 * that redirect happily, but a `fetch()` cannot: the bucket answers
 * `Access-Control-Allow-Origin: *`, which a browser refuses for a credentialed
 * cross-origin request. The PDF preview in the side panel is exactly such a
 * fetch (SHO-224), so the routes now stream the object through the API when the
 * request says `Sec-Fetch-Mode: cors`/`same-origin`.
 *
 * The routes run in-process against a stubbed database and stubbed storage, so
 * this file needs neither Postgres nor a bucket.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-conversation-file-secret'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret-file-stream'
// Presigning is offline crypto; the chat-attachment route needs a bucket and a
// key to sign with, nothing else.
process.env.S3_ARTIFACT_BUCKET = process.env.S3_ARTIFACT_BUCKET || 'artifacts-bucket'
process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1'
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test-access-key'
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test-secret-key'

const FILE_BYTES = new Uint8Array(200)
for (let i = 0; i < FILE_BYTES.length; i++) FILE_BYTES[i] = i % 256

const PRESIGNED = 'https://objectstorage.example.com/shogo-workspaces/artifacts/conversations/doc.pdf?X-Amz-Signature=abc'

const attachment = {
  id: 'att-pdf',
  conversationId: 'conv-1',
  storageKey: 'artifacts/conversations/ws-1/conv-1/doc.pdf',
  name: 'Job Description 3pg.docx.pdf',
  mimeType: 'application/pdf',
  size: FILE_BYTES.byteLength,
}

let attachmentRow = attachment

const prismaMock = {
  conversationAttachment: {
    findUnique: mock(async ({ where }: any) => (where.id === attachmentRow.id ? attachmentRow : null)),
  },
  conversation: {
    findUnique: mock(async () => ({ workspaceId: 'ws-1' })),
  },
  customEmoji: {
    findUnique: mock(async ({ where }: any) =>
      where.id === 'emoji-1'
        ? { id: 'emoji-1', storageKey: 'artifacts/emoji/ws-1/emoji-1.png', mimeType: 'image/png' }
        : null,
    ),
  },
}

// First, before anything else pulls it in: every module below reaches prisma.
mock.module('../lib/prisma', () => ({ prisma: prismaMock }))

const realChatMode = await import('../services/chat-mode')
const realFiles = await import('../lib/conversation-files')
const realChatAttachments = await import('../lib/chat-attachments')

/** The shape the routes see: cloud redirects, local hands over the bytes. */
let storageMode: 'cloud' | 'local' = 'cloud'

const streamCalls: Array<{ key: string; range?: { start: number; end: number } | null }> = []

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

const readConversationFileStream = mock(async (key: string, options: any = {}) => {
  streamCalls.push({ key, range: options.range ?? null })
  const range = options.range as { start: number; end: number } | null | undefined
  const slice = range ? FILE_BYTES.slice(range.start, range.end + 1) : FILE_BYTES
  return {
    body: streamOf(slice),
    contentLength: slice.byteLength,
    contentType: key.endsWith('.png') ? 'image/png' : 'application/pdf',
  }
})

const readConversationFile = mock(async () =>
  storageMode === 'cloud'
    ? { kind: 'redirect' as const, url: PRESIGNED }
    : { kind: 'bytes' as const, bytes: FILE_BYTES },
)

mock.module('../services/chat-mode', () => ({ ...realChatMode, getWorkspaceChatConfig: async () => ({ mode: 'on' }) }))
mock.module('../lib/conversation-files', () => ({
  ...realFiles,
  readConversationFile,
  readConversationFileStream,
}))

const { conversationRoutes } = await import('../routes/conversations')
const { mountConversationExtras } = await import('../routes/conversation-extras')
const { userProfileRoutes } = await import('../routes/local-user')
const { chatAttachmentRoutes } = await import('../routes/chat-attachments')

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async () => null }))
mountConversationExtras(app as any, {
  requireUser: async () => 'user-1',
  requireWorkspace: async () => ({ userId: 'user-1', workspaceId: 'ws-1' }),
  errorResponse: (c: any, err: unknown) => c.json({ error: String(err) }, 500),
  readJson: async (c: any) => c.req.json(),
})
app.route('/api', userProfileRoutes())
app.route('/api', chatAttachmentRoutes())

const token = realFiles.signAttachmentToken(attachment.id)

const getFile = (headers?: Record<string, string>, query = `?t=${token}`) =>
  app.request(`/api/conversation-files/${attachment.id}${query}`, { headers })

const EMOJI_ID = 'emoji-1'
const emojiToken = realFiles.signConversationFileToken(`emoji:${EMOJI_ID}`)
const getEmoji = (headers?: Record<string, string>) =>
  app.request(`/api/custom-emoji/${EMOJI_ID}?t=${emojiToken}`, { headers })

const AVATAR_USER = 'user-1'
const AVATAR_KEY = '0123456789abcdef.png'
const avatarToken = realFiles.signConversationFileToken(`avatar:${AVATAR_USER}:${AVATAR_KEY}`)
const getAvatar = (headers?: Record<string, string>) =>
  app.request(`/api/user-avatar/${AVATAR_USER}?k=${AVATAR_KEY}&t=${avatarToken}`, { headers })

const CHAT_KEY = 'artifacts/chat-attachments/ws-1/session-1/clip.mp4'
const chatToken = realChatAttachments.signAttachmentToken(CHAT_KEY)
const getChatAttachment = (headers?: Record<string, string>) =>
  app.request(`/api/chat-attachments/${CHAT_KEY}?t=${chatToken}`, { headers })

beforeEach(() => {
  attachmentRow = attachment
  storageMode = 'cloud'
  streamCalls.length = 0
  readConversationFileStream.mockClear()
  readConversationFile.mockClear()
})

describe('GET /conversation-files/:id in cloud mode', () => {
  test('streams the bytes to a script fetch instead of redirecting', async () => {
    const response = await getFile({ 'sec-fetch-mode': 'cors' })

    expect(response.status).toBe(200)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-disposition')).toContain('inline')
    expect(response.headers.get('content-disposition')).toContain(encodeURIComponent(attachment.name))
    expect(response.headers.get('content-length')).toBe(String(FILE_BYTES.byteLength))
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(FILE_BYTES)

    expect(streamCalls).toHaveLength(1)
    expect(streamCalls[0]!.key).toBe(attachment.storageKey)
    expect(streamCalls[0]!.range).toBeNull()
  })

  test('still redirects a navigation, an image and a client that sends no fetch metadata', async () => {
    for (const headers of [{ 'sec-fetch-mode': 'navigate' }, { 'sec-fetch-mode': 'no-cors' }, undefined]) {
      const response = await getFile(headers)
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(PRESIGNED)
    }
    expect(streamCalls).toHaveLength(0)
  })

  test('answers a range with 206 and a Content-Range of the file', async () => {
    const response = await getFile({ 'sec-fetch-mode': 'cors', range: 'bytes=0-99' })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes 0-99/${FILE_BYTES.byteLength}`)
    expect(response.headers.get('content-length')).toBe('100')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(FILE_BYTES.slice(0, 100))
    expect(streamCalls[0]!.range).toEqual({ kind: 'range', start: 0, end: 99 })
  })

  test('reports 416 for a range past the end without touching storage', async () => {
    const response = await getFile({ 'sec-fetch-mode': 'cors', range: 'bytes=500-' })

    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe(`bytes */${FILE_BYTES.byteLength}`)
    expect(streamCalls).toHaveLength(0)
  })

  test('streams a download with an attachment disposition', async () => {
    const response = await getFile({ 'sec-fetch-mode': 'cors' }, `?t=${token}&dl=1`)

    expect(response.status).toBe(200)
    const disposition = response.headers.get('content-disposition')!
    expect(disposition).toContain('attachment')
    expect(disposition).not.toContain('inline')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(FILE_BYTES)
  })

  test('refuses a bad token before any storage call, in both modes', async () => {
    for (const mode of ['cloud', 'local'] as const) {
      storageMode = mode
      for (const query of ['', '?t=deadbeef.abc']) {
        const response = await getFile({ 'sec-fetch-mode': 'cors' }, query)
        expect(response.status).toBe(403)
      }
    }
    expect(readConversationFile).toHaveBeenCalledTimes(0)
    expect(streamCalls).toHaveLength(0)
  })

  test('local mode is untouched: the same fetch gets the bytes from disk', async () => {
    storageMode = 'local'
    const response = await getFile({ 'sec-fetch-mode': 'cors', range: 'bytes=2-5' })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes 2-5/${FILE_BYTES.byteLength}`)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(FILE_BYTES.slice(2, 6))
    expect(streamCalls).toHaveLength(0)
  })
})

describe('the other routes that 302 to object storage', () => {
  const cases = [
    ['custom emoji', getEmoji],
    ['user avatar', getAvatar],
    ['chat attachment', getChatAttachment],
  ] as const

  for (const [label, request] of cases) {
    test(`${label}: a script fetch gets the bytes, a navigation gets the 302`, async () => {
      const fetched = await request({ 'sec-fetch-mode': 'cors' })
      expect(fetched.status).toBe(200)
      expect(fetched.headers.get('location')).toBeNull()
      expect(fetched.headers.get('x-content-type-options')).toBe('nosniff')
      expect((await fetched.arrayBuffer()).byteLength).toBe(FILE_BYTES.byteLength)

      const navigated = await request({ 'sec-fetch-mode': 'navigate' })
      expect(navigated.status).toBe(302)
      expect(navigated.headers.get('location')).toBeTruthy()
    })
  }

  test('the emoji and avatar responses keep their own content type', async () => {
    const emoji = await getEmoji({ 'sec-fetch-mode': 'cors' })
    expect(emoji.headers.get('content-type')).toBe('image/png')

    const avatar = await getAvatar({ 'sec-fetch-mode': 'cors' })
    expect(avatar.headers.get('content-type')).toBe('image/png')
  })

  test('a bad emoji, avatar or chat-attachment token is still refused', async () => {
    expect((await app.request(`/api/custom-emoji/${EMOJI_ID}?t=deadbeef`, { headers: { 'sec-fetch-mode': 'cors' } })).status).toBe(403)
    expect((await app.request(`/api/user-avatar/${AVATAR_USER}?k=${AVATAR_KEY}&t=deadbeef`, { headers: { 'sec-fetch-mode': 'cors' } })).status).toBe(403)
    expect((await app.request(`/api/chat-attachments/${CHAT_KEY}?t=deadbeef`, { headers: { 'sec-fetch-mode': 'cors' } })).status).toBe(403)
  })
})
