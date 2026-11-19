// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The host↔viewer wire (SHO-426). Everything here runs without a DOM or a
 * WebView on purpose: the chunking, the caps and the message checks are the
 * parts that must not be guessed at on a phone.
 */
import { describe, expect, test } from 'bun:test'
import {
  MAX_SLIDES_BYTES,
  MAX_SLIDES_BYTES_NATIVE,
  NATIVE_CHUNK_BYTES,
  SLIDES_VIEWER_VERSION,
  SlidesFetchError,
  SlidesTooLargeError,
  bytesToBase64,
  fetchSlidesBytes,
  isSlidesPath,
  parseSlidesViewerMessage,
  slidesChunkMessages,
  slidesLoadMessage,
  slidesPreviewErrorText,
  slidesViewerUrl,
  unsupportedPresentationMessage,
} from '../slides-viewer-protocol'

const decode = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))

describe('isSlidesPath', () => {
  test.each(['deck.pptx', 'DECK.PPTM', 'show.ppsx', 'show.ppsm', 'theme.potx', 'theme.potm'])(
    '%s renders as slides',
    (name) => {
      expect(isSlidesPath(name)).toBe(true)
    },
  )

  test.each(['deck.ppt', 'deck.key', 'deck.odp', 'deck.pdf', 'pptx', 'deck.pptx.bak'])(
    '%s does not',
    (name) => {
      expect(isSlidesPath(name)).toBe(false)
    },
  )
})

describe('slidesViewerUrl', () => {
  test('joins the API base and pins the build', () => {
    expect(slidesViewerUrl('http://localhost:8002')).toBe(
      `http://localhost:8002/api/viewers/slides?v=${SLIDES_VIEWER_VERSION}`,
    )
    expect(slidesViewerUrl('https://app.example.com/')).toBe(
      `https://app.example.com/api/viewers/slides?v=${SLIDES_VIEWER_VERSION}`,
    )
  })

  test('encodes the version', () => {
    expect(slidesViewerUrl('http://x', '1.4.0+9')).toBe('http://x/api/viewers/slides?v=1.4.0%2B9')
  })
})

describe('bytesToBase64', () => {
  test('round-trips bytes larger than one call stack', () => {
    const bytes = new Uint8Array(200_000)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
    expect(Array.from(decode(bytesToBase64(bytes)).subarray(0, 5))).toEqual([0, 1, 2, 3, 4])
    expect(decode(bytesToBase64(bytes)).length).toBe(bytes.length)
  })
})

describe('the two transports', () => {
  const sample = () => {
    const bytes = new Uint8Array(1500)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
    return bytes
  }

  test('web posts one transferable load message', () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer
    const { message, transfer } = slidesLoadMessage('deck.pptx', 'dark', bytes)
    expect(message).toMatchObject({ type: 'load', name: 'deck.pptx', theme: 'dark' })
    expect(message.bytes).toBe(bytes)
    expect(transfer).toEqual([bytes])
  })

  test('native sends load, then the chunks, then end', () => {
    const bytes = sample()
    const messages = slidesChunkMessages('deck.pptx', 'light', bytes, 1000)
    expect(messages[0]).toEqual({ type: 'load', name: 'deck.pptx', theme: 'light' })
    expect(messages[messages.length - 1]).toEqual({ type: 'end' })
    const chunks = messages.slice(1, -1).flatMap((message) => (message.type === 'chunk' ? [message] : []))
    expect(chunks.length).toBe(2)
    const rebuilt = new Uint8Array(chunks.reduce((sum, chunk) => sum + decode(chunk.base64).length, 0))
    let offset = 0
    for (const chunk of chunks) {
      const part = decode(chunk.base64)
      rebuilt.set(part, offset)
      offset += part.length
    }
    expect(Array.from(rebuilt)).toEqual(Array.from(bytes))
  })

  test('the default chunk is bounded so one injection is never the whole deck', () => {
    const messages = slidesChunkMessages('deck.pptx', 'dark', new Uint8Array(NATIVE_CHUNK_BYTES + 10))
    const chunks = messages.filter((message) => message.type === 'chunk')
    expect(chunks.length).toBe(2)
  })

  test('native buffers less than web: the bridge costs double', () => {
    expect(MAX_SLIDES_BYTES_NATIVE).toBeLessThan(MAX_SLIDES_BYTES)
  })
})

describe('parseSlidesViewerMessage', () => {
  test('reads the three messages the page sends', () => {
    expect(parseSlidesViewerMessage({ type: 'ready' })).toEqual({ type: 'ready' })
    expect(parseSlidesViewerMessage('{"type":"rendered","slideCount":3}')).toEqual({
      type: 'rendered',
      slideCount: 3,
    })
    expect(parseSlidesViewerMessage({ type: 'error', message: 'bad deck' })).toEqual({
      type: 'error',
      message: 'bad deck',
    })
  })

  test('ignores anything else, including junk from another frame', () => {
    expect(parseSlidesViewerMessage(null)).toBeNull()
    expect(parseSlidesViewerMessage('not json')).toBeNull()
    expect(parseSlidesViewerMessage({ type: 'load' })).toBeNull()
    expect(parseSlidesViewerMessage({ type: 'rendered', slideCount: 'many' })).toEqual({
      type: 'rendered',
      slideCount: 0,
    })
  })
})

describe('fetchSlidesBytes', () => {
  const response = (body: Uint8Array, headers: Record<string, string> = {}, status = 200) =>
    new Response(body as unknown as BodyInit, { status, headers }) as unknown as Response

  test('returns the bytes of a good response', async () => {
    const fetchImpl = (async () => response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch
    const bytes = await fetchSlidesBytes('/api/f/x', { fetchImpl })
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('refuses a deck whose declared length is over the cap, before buffering it', async () => {
    const fetchImpl = (async () =>
      response(new Uint8Array(1), { 'content-length': String(MAX_SLIDES_BYTES + 1) })) as unknown as typeof fetch
    await expect(fetchSlidesBytes('/api/f/x', { fetchImpl })).rejects.toBeInstanceOf(SlidesTooLargeError)
  })

  test('refuses a deck that turns out to be over the cap', async () => {
    const big = new Uint8Array(64)
    const fetchImpl = (async () => response(big)) as unknown as typeof fetch
    await expect(fetchSlidesBytes('/api/f/x', { fetchImpl, maxBytes: 32 })).rejects.toBeInstanceOf(
      SlidesTooLargeError,
    )
  })

  test('reports the HTTP status when the file cannot be read', async () => {
    const fetchImpl = (async () => response(new Uint8Array(0), {}, 404)) as unknown as typeof fetch
    const error = await fetchSlidesBytes('/api/f/x', { fetchImpl }).catch((cause) => cause)
    expect(error).toBeInstanceOf(SlidesFetchError)
    expect((error as SlidesFetchError).status).toBe(404)
  })
})

describe('copy', () => {
  test('a deck over the cap says so, and nothing pretends a spinner is progress', () => {
    expect(slidesPreviewErrorText(new SlidesTooLargeError(60 * 1024 * 1024, MAX_SLIDES_BYTES), 'deck.pptx')).toBe(
      'Too large to preview here',
    )
    expect(slidesPreviewErrorText(new SlidesFetchError(500), 'deck.pptx')).toContain('Could not open deck.pptx')
  })

  test('formats we cannot render name the way out', () => {
    expect(unsupportedPresentationMessage('talk.key')).toContain('Keynote')
    expect(unsupportedPresentationMessage('old.ppt')).toContain('PowerPoint 97–2003')
    expect(unsupportedPresentationMessage('open.odp')).toContain('as text')
    expect(unsupportedPresentationMessage('deck.pptx')).toBeNull()
    expect(unsupportedPresentationMessage('report.pdf')).toBeNull()
  })
})
