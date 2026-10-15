// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Byte ranges on the conversation-file route, driven through the real router
 * with a stubbed database.
 *
 * Audio needs this: iOS AVPlayer and Safari issue a range request before they
 * will play a remote clip at all, and every player seeks with one. The route
 * is exercised in-process so the test does not need Postgres.
 */

import { describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const FILE_BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
const attachment = {
  id: 'att-1',
  conversationId: 'conv-1',
  storageKey: 'conversations/ws-1/conv-1/clip.m4a',
  name: 'Voice note.m4a',
  mimeType: 'audio/mp4',
  size: FILE_BYTES.byteLength,
}

const prismaMock = {
  conversationAttachment: {
    findUnique: mock(async ({ where }: any) => (where.id === attachment.id ? attachment : null)),
  },
  conversation: {
    findUnique: mock(async () => ({ workspaceId: 'ws-1' })),
  },
}

// First, before anything else pulls it in: every module below reaches prisma.
mock.module('../lib/prisma', () => ({ prisma: prismaMock }))

const realChatMode = await import('../services/chat-mode')
const realFiles = await import('../lib/conversation-files')

mock.module('../services/chat-mode', () => ({ ...realChatMode, getWorkspaceChatConfig: async () => ({ mode: 'on' }) }))
mock.module('../lib/conversation-files', () => ({
  ...realFiles,
  readConversationFile: async () => ({ kind: 'bytes' as const, bytes: FILE_BYTES }),
}))

const { conversationRoutes } = await import('../routes/conversations')

// The route signs and verifies with this; set it explicitly so the test does
// not depend on the ambient NODE_ENV being a dev one.
process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-conversation-file-secret'

// A signed token is how an <audio> element authenticates: no session, so this
// exercises the same path a player takes.
const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async () => null }))

const token = realFiles.signAttachmentToken(attachment.id)

const getFile = (headers?: Record<string, string>, query = `?t=${token}`) =>
  app.request(`/api/conversation-files/${attachment.id}${query}`, { headers })

describe('GET /conversation-files/:id byte ranges', () => {
  test('advertises range support and serves the whole clip without a Range header', async () => {
    const response = await getFile()
    expect(response.status).toBe(200)
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-length')).toBe(String(FILE_BYTES.byteLength))
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(FILE_BYTES)
  })

  test('answers a closed range with 206 and just those bytes', async () => {
    const response = await getFile({ range: 'bytes=2-5' })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(response.headers.get('content-length')).toBe('4')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([2, 3, 4, 5]))
  })

  test('clamps an end past the last byte', async () => {
    const response = await getFile({ range: 'bytes=8-999' })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 8-9/10')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([8, 9]))
  })

  test('answers the open-ended probe a player opens with', async () => {
    const response = await getFile({ range: 'bytes=0-' })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 0-9/10')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(FILE_BYTES)
  })

  test('answers a suffix range with the tail of the clip', async () => {
    const response = await getFile({ range: 'bytes=-3' })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 7-9/10')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]))
  })

  test('reports 416 when the range starts past the end', async () => {
    const response = await getFile({ range: 'bytes=50-' })
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */10')
  })

  test('falls back to the whole clip for a range it cannot parse', async () => {
    for (const range of ['items=0-1', 'bytes=abc', 'bytes=5-2', 'bytes=0-1,4-5']) {
      const response = await getFile({ range })
      expect(response.status).toBe(200)
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(FILE_BYTES)
    }
  })

  test('keeps serving inline with a filename, and is still 404 for an unknown clip', async () => {
    const response = await getFile({ range: 'bytes=0-1' })
    expect(response.headers.get('content-disposition')).toContain('inline')
    expect(response.headers.get('content-disposition')).toContain('Voice%20note.m4a')
    expect(response.headers.get('content-type')).toBe('audio/mp4')

    const missing = await app.request('/api/conversation-files/nope')
    expect(missing.status).toBe(404)
  })

  test('refuses a clip whose token is missing or wrong', async () => {
    const noToken = await getFile(undefined, '')
    expect(noToken.status).toBe(403)
    const badToken = await getFile(undefined, '?t=deadbeef.abc')
    expect(badToken.status).toBe(403)
  })
})
