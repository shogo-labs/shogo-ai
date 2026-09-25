// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'

const sends: any[] = []
let nextResponse: any = null
let failPut = false

class FakeCommand {
  constructor(public input: any) {}
}
class PutObjectCommand extends FakeCommand {}
class GetObjectCommand extends FakeCommand {}
class DeleteObjectCommand extends FakeCommand {}
class ListObjectsV2Command extends FakeCommand {}

class S3Client {
  async send(command: any) {
    sends.push(command)
    if (failPut && command instanceof PutObjectCommand) throw new Error('S3 unavailable')
    return nextResponse || {}
  }
}

mock.module('@aws-sdk/client-s3', () => ({
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
}))

mock.module('../s3', () => ({
  getArtifactBucket: () => 'test-bucket',
  getArtifactS3Client: () => new S3Client({}),
  getArtifactPresignedReadUrl: async (key: string) => `https://signed.example/${key}`,
}))

const {
  attachmentKeyFromUrl,
  buildChatAttachmentKey,
  externalizeMessageAttachments,
  inlineChatBodyAttachments,
  loadAttachmentAsDataUrl,
  signAttachmentToken,
  verifyAttachmentToken,
} = await import('../chat-attachments')
const { chatAttachmentRoutes } = await import('../../routes/chat-attachments')

beforeEach(() => {
  sends.length = 0
  nextResponse = null
  failPut = false
  process.env.NODE_ENV = 'test'
})

describe('chat attachments', () => {
  it('creates and verifies scoped capability URLs', () => {
    const key = buildChatAttachmentKey('session-1', Buffer.from('hello'), 'text/plain', 'note.txt')
    const url = `/api/chat-attachments/${key}?t=${signAttachmentToken(key)}`
    expect(attachmentKeyFromUrl(url)).toBe(key)
    expect(verifyAttachmentToken(key, signAttachmentToken(key))).toBe(true)
    expect(verifyAttachmentToken(key, 'bad')).toBe(false)
  })

  it('externalizes file parts and clears the duplicate imageData field', async () => {
    const dataUrl = 'data:image/png;base64,aGVsbG8='
    const result = await externalizeMessageAttachments(
      'session-1',
      JSON.stringify([{ type: 'file', mediaType: 'image/png', url: dataUrl, name: 'a.png' }]),
      dataUrl,
    )
    expect(result.changed).toBe(true)
    expect(result.imageData).toBeNull()
    expect(JSON.parse(result.parts!).at(0).url).toStartWith('/api/chat-attachments/')
    expect(JSON.parse(result.parts!).at(0).attachmentKey).toContain('session-1/')
    expect(sends.some((command) => command instanceof PutObjectCommand)).toBe(true)
  })

  it('keeps inline data when object storage is unavailable', async () => {
    failPut = true
    const dataUrl = 'data:application/pdf;base64,aGVsbG8='
    const result = await externalizeMessageAttachments(
      'session-1',
      JSON.stringify([{ type: 'file', mediaType: 'application/pdf', url: dataUrl }]),
      dataUrl,
    )
    expect(result.changed).toBe(false)
    expect(result.imageData).toBe(dataUrl)
    expect(JSON.parse(result.parts!).at(0).url).toBe(dataUrl)
  })

  it('loads an object back into a data URL', async () => {
    nextResponse = {
      ContentType: 'image/png',
      Body: { transformToByteArray: async () => new Uint8Array([104, 105]) },
    }
    const key = 'artifacts/chat-attachments/session-1/hash.png'
    await expect(loadAttachmentAsDataUrl(key)).resolves.toBe('data:image/png;base64,aGk=')
  })

  it('hydrates attachment references in the current chat turn', async () => {
    nextResponse = {
      ContentType: 'application/pdf',
      Body: { transformToByteArray: async () => new Uint8Array([112, 100, 102]) },
    }
    const key = 'artifacts/chat-attachments/session-1/file.pdf'
    const body = await inlineChatBodyAttachments({
      files: [{ type: 'file', mediaType: 'application/pdf', url: `/api/chat-attachments/${key}` }],
      messages: [{
        role: 'user',
        parts: [{ type: 'file', mediaType: 'application/pdf', url: `/api/chat-attachments/${key}` }],
      }],
    })
    expect(body.files[0].url).toBe('data:application/pdf;base64,cGRm')
    expect(body.messages[0].parts[0].url).toBe('data:application/pdf;base64,cGRm')
  })

  it('redirects only with a valid capability token', async () => {
    const app = new Hono()
    app.route('/api', chatAttachmentRoutes())
    const key = 'artifacts/chat-attachments/session-1/hash.png'
    const denied = await app.request(`/api/chat-attachments/${key}`)
    expect(denied.status).toBe(403)

    const allowed = await app.request(
      `/api/chat-attachments/${key}?t=${signAttachmentToken(key)}`,
    )
    expect(allowed.status).toBe(302)
    expect(allowed.headers.get('location')).toBe(`https://signed.example/${key}`)
  })
})
