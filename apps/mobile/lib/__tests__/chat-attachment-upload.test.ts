// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const uploadCalls: Array<{ url: string; uri: string; options: any }> = []
const readCalls: string[] = []
let uploadResult: { status: number; body: string } = {
  status: 200,
  body: JSON.stringify({ savedPath: 'archive.zip' }),
}
let readResult: string | null = null
/** Progress events the mocked native task replays to its callback. */
let progressEvents: Array<{ totalBytesSent: number; totalBytesExpectedToSend: number }> = []

mock.module('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
  readAsStringAsync: async (uri: string) => {
    readCalls.push(uri)
    if (readResult === null) throw new Error('unreadable')
    return readResult
  },
  createUploadTask: (url: string, uri: string, options: any, callback?: (data: any) => void) => {
    uploadCalls.push({ url, uri, options })
    return {
      uploadAsync: async () => {
        for (const event of progressEvents) callback?.(event)
        return uploadResult
      },
    }
  },
}))

const {
  MAX_INLINE_IMAGE_BYTES,
  prepareOutgoingFiles,
  shouldUploadAttachmentFirst,
  uploadChatAttachment,
} = await import('../chat-attachment-upload')

const AGENT_URL = 'https://api.example.com/api/projects/p1/agent-proxy'

function tinyPngDataUrl(): string {
  return `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`
}

describe('shouldUploadAttachmentFirst', () => {
  test('uploads every non-image attachment', () => {
    expect(shouldUploadAttachmentFirst({ name: 'a.zip', type: 'application/zip' })).toBe(true)
    expect(shouldUploadAttachmentFirst({ name: 'a.pdf', type: 'application/pdf' })).toBe(true)
    expect(shouldUploadAttachmentFirst({ name: 'notes.txt', type: 'text/plain' })).toBe(true)
  })

  test('keeps a small image inline so vision gets its bytes immediately', () => {
    expect(
      shouldUploadAttachmentFirst({ name: 'a.png', type: 'image/png', size: 1024 }),
    ).toBe(false)
  })

  test('uploads an image past the inline cap', () => {
    expect(
      shouldUploadAttachmentFirst({
        name: 'huge.png',
        type: 'image/png',
        size: MAX_INLINE_IMAGE_BYTES + 1,
      }),
    ).toBe(true)
  })
})

describe('uploadChatAttachment', () => {
  beforeEach(() => {
    uploadCalls.length = 0
    progressEvents = []
    uploadResult = { status: 200, body: JSON.stringify({ savedPath: 'archive.zip' }) }
  })

  test('streams a native file from its uri with a binary PUT', async () => {
    const ref = await uploadChatAttachment({
      agentUrl: AGENT_URL,
      file: { name: 'archive.zip', type: 'application/zip', uri: 'file:///tmp/archive.zip' },
      headers: { cookie: 'session=abc' },
    })

    expect(uploadCalls).toHaveLength(1)
    expect(uploadCalls[0].url).toBe(`${AGENT_URL}/agent/chat/attachments?name=archive.zip`)
    expect(uploadCalls[0].uri).toBe('file:///tmp/archive.zip')
    expect(uploadCalls[0].options.httpMethod).toBe('PUT')
    expect(uploadCalls[0].options.uploadType).toBe(0)
    expect(uploadCalls[0].options.headers['content-type']).toBe('application/zip')
    expect(uploadCalls[0].options.headers.cookie).toBe('session=abc')
    expect(ref.savedPath).toBe('archive.zip')
    expect(ref.url).toBe(`${AGENT_URL}/agent/workspace/download/archive.zip`)
  })

  test('reports upload progress from the native task, clamped to 1', async () => {
    const seen: number[] = []
    progressEvents = [
      { totalBytesSent: 0, totalBytesExpectedToSend: 200 },
      { totalBytesSent: 100, totalBytesExpectedToSend: 200 },
      { totalBytesSent: 250, totalBytesExpectedToSend: 200 },
    ]

    await uploadChatAttachment({
      agentUrl: AGENT_URL,
      file: { name: 'archive.zip', type: 'application/zip', uri: 'file:///tmp/archive.zip', size: 200 },
      onProgress: (fraction) => seen.push(fraction),
    })

    expect(seen).toEqual([0, 0.5, 1])
  })

  test('falls back to the declared size when the transport cannot report a total', async () => {
    const seen: number[] = []
    progressEvents = [{ totalBytesSent: 50, totalBytesExpectedToSend: 0 }]

    await uploadChatAttachment({
      agentUrl: AGENT_URL,
      file: { name: 'archive.zip', type: 'application/zip', uri: 'file:///tmp/archive.zip', size: 200 },
      onProgress: (fraction) => seen.push(fraction),
    })

    expect(seen).toEqual([0.25])
  })

  test('reports the server message when the upload is refused', async () => {
    uploadResult = {
      status: 413,
      body: JSON.stringify({ error: { code: 'attachment_too_large', message: 'too big' } }),
    }

    await expect(
      uploadChatAttachment({
        agentUrl: AGENT_URL,
        file: { name: 'big.zip', type: 'application/zip', uri: 'file:///tmp/big.zip' },
      }),
    ).rejects.toThrow('too big')
  })
})

describe('prepareOutgoingFiles', () => {
  const seen: Array<{ url: string; init: any }> = []
  const fetchImpl = (async (url: any, init?: any) => {
    seen.push({ url: String(url), init })
    return new Response(JSON.stringify({ savedPath: 'files/notes.txt' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  beforeEach(() => {
    seen.length = 0
    uploadCalls.length = 0
    uploadResult = { status: 200, body: JSON.stringify({ savedPath: 'files/notes.txt' }) }
  })

  test('replaces an uploaded attachment with a reference part', async () => {
    const parts = await prepareOutgoingFiles(
      [{ name: 'notes.txt', type: 'text/plain', dataUrl: 'data:text/plain;base64,aGk=', size: 2 }],
      { agentUrl: AGENT_URL, fetchImpl },
    )

    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({
      type: 'file',
      mediaType: 'text/plain',
      savedPath: 'files/notes.txt',
      name: 'notes.txt',
    })
    expect(parts[0].url).toBe(`${AGENT_URL}/agent/workspace/download/files/notes.txt`)
    expect(parts[0].url.startsWith('data:')).toBe(false)
    expect(seen[0].init.method).toBe('PUT')
    expect(seen[0].url).toBe(`${AGENT_URL}/agent/chat/attachments?name=notes.txt`)
  })

  test('keeps a small image inline and never uploads it', async () => {
    const dataUrl = tinyPngDataUrl()
    const parts = await prepareOutgoingFiles(
      [{ name: 'a.png', type: 'image/png', dataUrl, size: 4 }],
      { agentUrl: AGENT_URL, fetchImpl },
    )

    expect(parts).toEqual([{ type: 'file', mediaType: 'image/png', url: dataUrl, name: 'a.png' }])
    expect(seen).toHaveLength(0)
  })

  test('falls back to inline bytes when the upload fails and they are still in hand', async () => {
    const failures: string[] = []
    const failing = (async () =>
      new Response(JSON.stringify({ error: { message: 'runtime unreachable' } }), {
        status: 502,
      })) as unknown as typeof fetch
    const dataUrl = 'data:text/plain;base64,aGk='

    const parts = await prepareOutgoingFiles(
      [{ name: 'notes.txt', type: 'text/plain', dataUrl, size: 2 }],
      { agentUrl: AGENT_URL, fetchImpl: failing, onUploadError: (m) => failures.push(m) },
    )

    expect(parts[0].url).toBe(dataUrl)
    expect(parts[0].savedPath).toBeUndefined()
    expect(failures).toEqual(['runtime unreachable'])
  })

  test('falls back to reading the file inline when the transport refuses the upload', async () => {
    // A paired-machine tunnel cannot relay binary uploads; a normal-sized file
    // still goes out inline instead of dead-ending.
    uploadResult = {
      status: 501,
      body: JSON.stringify({
        error: {
          code: 'attachment_upload_unsupported',
          message: 'Streamed attachment uploads are not available through a paired machine tunnel',
        },
      }),
    }
    readResult = Buffer.from('hello').toString('base64')

    const parts = await prepareOutgoingFiles(
      [{ name: 'notes.txt', type: 'text/plain', dataUrl: '', uri: 'file:///tmp/notes.txt', size: 5 }],
      { agentUrl: AGENT_URL, fetchImpl },
    )

    expect(readCalls).toEqual(['file:///tmp/notes.txt'])
    expect(parts[0].url).toBe('data:text/plain;base64,aGVsbG8=')
    expect(parts[0].savedPath).toBeUndefined()
  })

  test('throws when an upload fails and there are no inline bytes to fall back to', async () => {
    uploadResult = { status: 500, body: JSON.stringify({ error: { message: 'nope' } }) }
    readResult = null

    await expect(
      prepareOutgoingFiles(
        [{ name: 'big.zip', type: 'application/zip', dataUrl: '', uri: 'file:///tmp/big.zip' }],
        { agentUrl: AGENT_URL, fetchImpl },
      ),
    ).rejects.toThrow('nope')
  })

  test('leaves everything inline when there is no agent URL to upload to', async () => {
    const dataUrl = 'data:application/pdf;base64,aGk='
    const parts = await prepareOutgoingFiles(
      [{ name: 'a.pdf', type: 'application/pdf', dataUrl, size: 2 }],
      { agentUrl: null, fetchImpl },
    )

    expect(parts[0].url).toBe(dataUrl)
    expect(seen).toHaveLength(0)
  })

  test('passes an already-uploaded reference through instead of uploading it twice', async () => {
    // A resend rebuilt from the persisted message part: the bytes are on the
    // runtime already, so a retry must not PUT them again (or fail trying).
    const url = `${AGENT_URL}/agent/workspace/download/files/big.zip`
    const parts = await prepareOutgoingFiles(
      [{ name: 'big.zip', type: 'application/zip', dataUrl: url, savedPath: 'files/big.zip' }],
      { agentUrl: AGENT_URL, fetchImpl },
    )

    expect(parts).toEqual([
      {
        type: 'file',
        mediaType: 'application/zip',
        url,
        name: 'big.zip',
        savedPath: 'files/big.zip',
      },
    ])
    expect(seen).toHaveLength(0)
    expect(uploadCalls).toHaveLength(0)
  })
})
