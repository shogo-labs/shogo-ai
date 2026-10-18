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
class CopyObjectCommand extends FakeCommand {}
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
  CopyObjectCommand,
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
  buildChatAttachmentUrl,
  copyChatPartsToSession,
  externalizeAssistantTextMedia,
  externalizeMessageAttachments,
  newAssistantMediaBudget,
  workspaceMediaPath,
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

  it('copies referenced attachments into the target session prefix', async () => {
    const key = 'artifacts/chat-attachments/source/abc.png'
    const parts = JSON.stringify([
      { type: 'file', mediaType: 'image/png', url: buildChatAttachmentUrl(key), attachmentKey: key },
      { type: 'tool-browser', output: { type: 'image', url: buildChatAttachmentUrl(key), dataInFile: true } },
      { type: 'text', text: 'hello' },
    ])
    const copies = new Map<string, Promise<string>>()
    const copied = JSON.parse((await copyChatPartsToSession(parts, 'fork', copies))!)
    await copyChatPartsToSession(parts, 'fork', copies)

    const targetKey = 'artifacts/chat-attachments/fork/abc.png'
    expect(copied[0].attachmentKey).toBe(targetKey)
    expect(attachmentKeyFromUrl(copied[0].url)).toBe(targetKey)
    expect(verifyAttachmentToken(targetKey, new URL(copied[0].url, 'http://x').searchParams.get('t'))).toBe(true)
    expect(attachmentKeyFromUrl(copied[1].output.url)).toBe(targetKey)
    expect(copied[2]).toEqual({ type: 'text', text: 'hello' })

    const copyCommands = sends.filter((command) => command instanceof CopyObjectCommand)
    expect(copyCommands).toHaveLength(1)
    expect(copyCommands[0].input).toEqual({
      Bucket: 'test-bucket',
      CopySource: `test-bucket/${key}`,
      Key: targetKey,
    })
  })

  it('leaves parts without attachment references untouched', async () => {
    const parts = JSON.stringify([{ type: 'text', text: 'hi' }])
    await expect(copyChatPartsToSession(parts, 'fork')).resolves.toBe(parts)
    await expect(copyChatPartsToSession(null, 'fork')).resolves.toBeNull()
    expect(sends).toHaveLength(0)
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

describe('externalizeAssistantTextMedia', () => {
  const png = (bytes = [1, 2, 3]) =>
    new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) } })

  it('copies workspace images into chat storage and rewrites the markdown', async () => {
    const requested: string[] = []
    const text = 'Here:\n\n![Faithful](brand/buddy/faithful.png)\n\nand ![](./brand/buddy/faithful.png) again'
    const out = await externalizeAssistantTextMedia('session-1', text, async (path) => {
      requested.push(path)
      return png()
    })

    expect(requested).toEqual(['brand/buddy/faithful.png'])
    const puts = sends.filter((s) => s instanceof PutObjectCommand)
    expect(puts).toHaveLength(1)
    expect(puts[0].input.ContentType).toBe('image/png')
    const url = buildChatAttachmentUrl(puts[0].input.Key)
    expect(out).toBe(`Here:\n\n![Faithful](${url})\n\nand ![](${url}) again`)
  })

  it('leaves URLs, code and unreadable files as written', async () => {
    const text = [
      '![a](https://example.com/a.png)',
      '```\n![b](code/b.png)\n```',
      'Write `![e](inline/e.png)` to embed it.',
      '![c](missing.png)',
      '![d](notes.txt)',
    ].join('\n')
    const out = await externalizeAssistantTextMedia('session-1', text, async (path) => {
      if (path === 'notes.txt') return new Response('hi', { headers: { 'content-type': 'text/plain' } })
      if (path === 'inline/e.png') return png()
      return new Response('nope', { status: 404 })
    })
    expect(out).toBe(text)
    expect(sends.filter((s) => s instanceof PutObjectCommand)).toHaveLength(0)
  })

  it('keeps the ref when storage fails, and shares one budget across parts', async () => {
    failPut = true
    const budget = newAssistantMediaBudget()
    expect(await externalizeAssistantTextMedia('s', '![](a.png)', async () => png(), budget)).toBe('![](a.png)')
    failPut = false
    const out = await externalizeAssistantTextMedia('s', '![](a.png) ![](b.png)', async () => png(), budget)
    expect(out.startsWith('![](a.png) ![](/api/chat-attachments/')).toBe(true)
  })

  it('maps markdown targets to workspace paths', () => {
    expect(workspaceMediaPath('/app/workspace/brand/x.png')).toBe('brand/x.png')
    expect(workspaceMediaPath('/shogo-image?path=brand%2Fx.png')).toBe('brand/x.png')
    expect(workspaceMediaPath('file:///app/workspace/x.mp4')).toBe('x.mp4')
    expect(workspaceMediaPath('../secret.png')).toBeNull()
    expect(workspaceMediaPath('/api/conversation-files/a?t=b')).toBeNull()
    expect(workspaceMediaPath('data:image/png;base64,AA')).toBeNull()
  })
})
