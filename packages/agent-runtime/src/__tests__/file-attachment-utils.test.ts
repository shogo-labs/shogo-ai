// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, test, expect } from 'bun:test'
import {
  _fileAttachmentSeamForTests,
  extractFilePartsAsText,
  parseFileAttachments,
  transcribeAudioParts,
  type FilePart,
} from '../file-attachment-utils'

function dataUrl(mediaType: string, content: Buffer | string): string {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content
  return `data:${mediaType};base64,${buf.toString('base64')}`
}

const defaultDecode = _fileAttachmentSeamForTests.decodeBase64Utf8

describe('parseFileAttachments', () => {
  afterEach(() => {
    _fileAttachmentSeamForTests.decodeBase64Utf8 = defaultDecode
  })

  test('returns empty result when no file parts present', () => {
    const result = parseFileAttachments([])
    expect(result.images).toEqual([])
    expect(result.textContext).toBe('')
  })

  test('inlines text-based file content with delimiters', () => {
    const parts: FilePart[] = [
      {
        type: 'file',
        mediaType: 'text/plain',
        url: dataUrl('text/plain', 'hello world'),
        name: 'note.txt',
        savedPath: 'files/note.txt',
      },
    ]
    const { textContext, images } = parseFileAttachments(parts)
    expect(images).toEqual([])
    expect(textContext).toContain('[Attached File (note.txt (text/plain))]:')
    expect(textContext).toContain('Saved to workspace at `files/note.txt`')
    expect(textContext).toContain('hello world')
    expect(textContext).toContain('[End of Attached File]')
  })

  test('emits a binary placeholder with the saved path for archives', () => {
    const zipBytes = Buffer.from([
      0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00,
      0x08, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x00,
    ])
    const parts: FilePart[] = [
      {
        type: 'file',
        mediaType: 'application/zip',
        url: dataUrl('application/zip', zipBytes),
        name: 'archive.zip',
        savedPath: 'files/archive.zip',
      },
    ]
    const { textContext, images } = parseFileAttachments(parts)
    expect(images).toEqual([])
    expect(textContext).toContain('[Attached File (archive.zip (application/zip))]:')
    expect(textContext).toContain('Binary content')
    expect(textContext).toContain('Saved to workspace at `files/archive.zip`')
    expect(textContext).not.toContain('[End of Attached File]')
  })

  test('routes images to the images array and announces saved path when present', () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const parts: FilePart[] = [
      {
        type: 'file',
        mediaType: 'image/png',
        url: dataUrl('image/png', pngBytes),
        name: 'pic.png',
        savedPath: 'files/pic.png',
      },
    ]
    const { textContext, images } = parseFileAttachments(parts)
    expect(images).toHaveLength(1)
    expect(images[0].mimeType).toBe('image/png')
    expect(images[0].data).toBe(pngBytes.toString('base64'))
    expect(textContext).toContain('[Attached Image (pic.png (image/png))]:')
    expect(textContext).toContain('Saved to workspace at `files/pic.png`')
  })

  test('omits saved-path note when no savedPath is provided', () => {
    const parts: FilePart[] = [
      {
        type: 'file',
        mediaType: 'application/zip',
        url: dataUrl('application/zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])),
        name: 'noisy.zip',
      },
    ]
    const { textContext } = parseFileAttachments(parts)
    expect(textContext).toContain('Binary content')
    expect(textContext).not.toContain('Saved to workspace at')
  })

  test('skips file parts that are not data URLs', () => {
    const parts: FilePart[] = [
      {
        type: 'file',
        mediaType: 'text/plain',
        url: 'https://example.com/file.txt',
        name: 'remote.txt',
      },
    ]
    const { textContext, images } = parseFileAttachments(parts)
    expect(textContext).toBe('')
    expect(images).toEqual([])
  })

  test('routes audio/* parts to audioParts instead of inlining or images, and leaves textContext untouched', () => {
    const parts: FilePart[] = [
      {
        type: 'file',
        mediaType: 'audio/wav',
        url: dataUrl('audio/wav', Buffer.from([1, 2, 3, 4])),
        name: 'memo.wav',
        savedPath: 'files/memo.wav',
      },
    ]
    const { images, textContext, audioParts } = parseFileAttachments(parts)
    expect(images).toEqual([])
    // Audio is deferred for async transcription, not inlined synchronously —
    // parseFileAttachments itself never mentions the audio attachment.
    expect(textContext).toBe('')
    expect(audioParts).toHaveLength(1)
    expect(audioParts[0].name).toBe('memo.wav')
    expect(audioParts[0].mediaType).toBe('audio/wav')
  })

  test('handles a mix of image, text, and audio parts in one call', () => {
    const parts: FilePart[] = [
      { type: 'file', mediaType: 'image/png', url: dataUrl('image/png', Buffer.from([0x89])), name: 'a.png' },
      { type: 'file', mediaType: 'text/plain', url: dataUrl('text/plain', 'hi'), name: 'b.txt' },
      { type: 'file', mediaType: 'audio/mpeg', url: dataUrl('audio/mpeg', Buffer.from([1])), name: 'c.mp3' },
    ]
    const { images, textContext, audioParts } = parseFileAttachments(parts)
    expect(images).toHaveLength(1)
    expect(audioParts).toHaveLength(1)
    expect(audioParts[0].name).toBe('c.mp3')
    expect(textContext).toContain('b.txt')
    expect(textContext).not.toContain('c.mp3')
  })
})

describe('transcribeAudioParts', () => {
  const originalFetch = globalThis.fetch
  const originalProxyUrl = process.env.AI_PROXY_URL
  const originalProxyToken = process.env.AI_PROXY_TOKEN
  const originalOpenAIKey = process.env.OPENAI_API_KEY

  beforeEach(() => {
    delete process.env.AI_PROXY_URL
    delete process.env.AI_PROXY_TOKEN
    delete process.env.OPENAI_API_KEY
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalProxyUrl === undefined) delete process.env.AI_PROXY_URL
    else process.env.AI_PROXY_URL = originalProxyUrl
    if (originalProxyToken === undefined) delete process.env.AI_PROXY_TOKEN
    else process.env.AI_PROXY_TOKEN = originalProxyToken
    if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalOpenAIKey
  })

  test('returns empty string for an empty batch (no network call)', async () => {
    let called = false
    globalThis.fetch = (async () => { called = true; return new Response('{}') }) as any
    const result = await transcribeAudioParts([])
    expect(result).toBe('')
    expect(called).toBe(false)
  })

  test('emits a placeholder when no API key is configured', async () => {
    const parts: FilePart[] = [
      { type: 'file', mediaType: 'audio/wav', url: dataUrl('audio/wav', Buffer.from([1, 2])), name: 'x.wav' },
    ]
    const result = await transcribeAudioParts(parts)
    expect(result).toContain('[Attached Audio (x.wav (audio/wav))]:')
    expect(result).toContain('no OpenAI API key configured')
  })

  test('transcribes via the AI proxy URL, stripping a trailing /v1 before appending /v1/audio/transcriptions', async () => {
    process.env.AI_PROXY_URL = 'https://api.internal.example/api/ai/v1'
    process.env.AI_PROXY_TOKEN = 'proxy-tok'

    let capturedUrl = ''
    let capturedAuth = ''
    globalThis.fetch = (async (url: string, init: any) => {
      capturedUrl = url
      capturedAuth = init.headers.Authorization
      return new Response(JSON.stringify({ text: 'hello from whisper' }), { status: 200 })
    }) as any

    const parts: FilePart[] = [
      { type: 'file', mediaType: 'audio/wav', url: dataUrl('audio/wav', Buffer.from([1, 2, 3])), name: 'memo.wav' },
    ]
    const result = await transcribeAudioParts(parts)

    expect(capturedUrl).toBe('https://api.internal.example/api/ai/v1/audio/transcriptions')
    expect(capturedAuth).toBe('Bearer proxy-tok')
    expect(result).toBe('[Attached Audio (memo.wav (audio/wav)) — auto-transcribed]: hello from whisper')
  })

  test('falls back to OpenAI directly when no proxy is configured', async () => {
    process.env.OPENAI_API_KEY = 'sk-direct'
    let capturedUrl = ''
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url
      return new Response(JSON.stringify({ text: 'direct transcript' }), { status: 200 })
    }) as any

    const parts: FilePart[] = [
      { type: 'file', mediaType: 'audio/mpeg', url: dataUrl('audio/mpeg', Buffer.from([9])), name: 'clip.mp3' },
    ]
    const result = await transcribeAudioParts(parts)
    expect(capturedUrl).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(result).toContain('direct transcript')
  })

  test('emits a size-limit placeholder for audio over the 25MB Whisper cap, without calling fetch', async () => {
    process.env.OPENAI_API_KEY = 'sk-direct'
    let called = false
    globalThis.fetch = (async () => { called = true; return new Response('{}') }) as any

    // ~26MB of raw bytes, base64-encoded.
    const bigBuffer = Buffer.alloc(26 * 1024 * 1024)
    const parts: FilePart[] = [
      { type: 'file', mediaType: 'audio/wav', url: dataUrl('audio/wav', bigBuffer), name: 'huge.wav' },
    ]
    const result = await transcribeAudioParts(parts)
    expect(called).toBe(false)
    expect(result).toContain('exceeds the 25MB Whisper upload limit')
  })

  test('emits a failure placeholder on a non-2xx upstream response', async () => {
    process.env.OPENAI_API_KEY = 'sk-direct'
    globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as any

    const parts: FilePart[] = [
      { type: 'file', mediaType: 'audio/wav', url: dataUrl('audio/wav', Buffer.from([1])), name: 'y.wav' },
    ]
    const result = await transcribeAudioParts(parts)
    expect(result).toContain('Transcription failed (429)')
    expect(result).toContain('rate limited')
  })

  test('emits a failure placeholder when fetch throws', async () => {
    process.env.OPENAI_API_KEY = 'sk-direct'
    globalThis.fetch = (async () => { throw new Error('network down') }) as any

    const parts: FilePart[] = [
      { type: 'file', mediaType: 'audio/wav', url: dataUrl('audio/wav', Buffer.from([1])), name: 'z.wav' },
    ]
    const result = await transcribeAudioParts(parts)
    expect(result).toContain('Transcription failed: network down')
  })

  test('handles multiple audio parts, joining announcements with a blank line', async () => {
    process.env.OPENAI_API_KEY = 'sk-direct'
    let call = 0
    globalThis.fetch = (async () => {
      call++
      return new Response(JSON.stringify({ text: `clip ${call}` }), { status: 200 })
    }) as any

    const parts: FilePart[] = [
      { type: 'file', mediaType: 'audio/wav', url: dataUrl('audio/wav', Buffer.from([1])), name: 'a.wav' },
      { type: 'file', mediaType: 'audio/wav', url: dataUrl('audio/wav', Buffer.from([2])), name: 'b.wav' },
    ]
    const result = await transcribeAudioParts(parts)
    expect(result).toContain('clip 1')
    expect(result).toContain('clip 2')
    expect(result.split('\n\n')).toHaveLength(2)
  })
})

describe('parseFileAttachments — base64 decode failure (catch arm)', () => {
  test('emits the "Could not decode" placeholder when the decode helper throws', () => {
    // Buffer.from(..., 'base64').toString('utf-8') does not throw on invalid
    // input under Bun/Node — it silently filters — so the catch in
    // parseFileAttachments is otherwise unreachable. Swap the seam to force
    // a throw and assert the user-facing fallback section.
    _fileAttachmentSeamForTests.decodeBase64Utf8 = () => {
      throw new Error('forced decode failure')
    }
    const parts: FilePart[] = [
      {
        type: 'file',
        mediaType: 'text/plain',
        url: 'data:text/plain;base64,aGVsbG8=', // "hello"
        name: 'broken.txt',
        savedPath: 'files/broken.txt',
      },
    ]
    const { textContext, images } = parseFileAttachments(parts)
    expect(images).toEqual([])
    expect(textContext).toContain(
      '[Attached File (broken.txt (text/plain))]: Could not decode file content.',
    )
    expect(textContext).toContain('Saved to workspace at `files/broken.txt`')
    // Restored automatically by the afterEach above.
    _fileAttachmentSeamForTests.decodeBase64Utf8 = defaultDecode
  })
})

describe('extractFilePartsAsText (deprecated re-export)', () => {
  test('delegates to parseFileAttachments and returns just the textContext', () => {
    const parts: FilePart[] = [
      {
        type: 'file',
        mediaType: 'text/plain',
        url: 'data:text/plain;base64,' + Buffer.from('hi from deprecated', 'utf-8').toString('base64'),
        name: 'note.txt',
      },
    ]
    const text = extractFilePartsAsText(parts)
    expect(typeof text).toBe('string')
    expect(text).toContain('hi from deprecated')
    expect(text).toContain('[Attached File (note.txt (text/plain))]:')
    // Parity check: extractFilePartsAsText is documented as a thin wrapper
    // around parseFileAttachments — confirm both produce identical strings.
    expect(text).toBe(parseFileAttachments(parts).textContext)
  })
})
