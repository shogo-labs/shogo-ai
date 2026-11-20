// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The host↔viewer wire (SHO-426, SHO-467). Everything here runs without a DOM
 * or a WebView on purpose: the chunking, the caps and the message checks are
 * the parts that must not be guessed at on a phone.
 */
import { describe, expect, test } from 'bun:test'
import {
  DOCUMENT_VIEWER_VERSION,
  MAX_SLIDES_BYTES,
  MAX_SLIDES_BYTES_NATIVE,
  NATIVE_CHUNK_BYTES,
  SLIDES_VIEWER_VERSION,
  SlidesFetchError,
  SlidesTooLargeError,
  bytesToBase64,
  fetchSlidesBytes,
  isDocumentPath,
  isSlidesPath,
  parseDocumentViewerMessage,
  parseSlidesViewerMessage,
  slidesChunkMessages,
  slidesLoadMessage,
  slidesPreviewErrorText,
  slidesViewerUrl,
  documentViewerUrl,
  unsupportedDocumentMessage,
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

describe('isDocumentPath (SHO-467)', () => {
  test.each(['report.docx', 'LETTER.DOCM', 'template.dotx', 'template.dotm'])(
    '%s renders as a document',
    (name) => {
      expect(isDocumentPath(name)).toBe(true)
    },
  )

  test.each(['report.doc', 'report.odt', 'report.rtf', 'report.pdf', 'docx', 'report.docx.bak'])(
    '%s does not',
    (name) => {
      expect(isDocumentPath(name)).toBe(false)
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

describe('documentViewerUrl (SHO-467)', () => {
  test('joins the API base and pins the build', () => {
    expect(documentViewerUrl('http://localhost:8002')).toBe(
      `http://localhost:8002/api/viewers/document?v=${DOCUMENT_VIEWER_VERSION}`,
    )
  })

  test('encodes the version', () => {
    expect(documentViewerUrl('http://x', '0.4.1+2')).toBe('http://x/api/viewers/document?v=0.4.1%2B2')
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

  test('native chunks the deck into base64 slices', () => {
    const bytes = sample()
    const messages = slidesChunkMessages('deck.pptx', 'light', bytes, 512)
    expect(messages[0]).toMatchObject({ type: 'load', name: 'deck.pptx', theme: 'light' })
    expect(messages[messages.length - 1]).toMatchObject({ type: 'end' })
    const chunks = messages.slice(1, -1)
    expect(chunks.every((m) => m.type === 'chunk')).toBe(true)
    // Reassembled round-trip.
    const all = chunks.flatMap((m) => Array.from(decode((m as { base64: string }).base64)))
    expect(all.slice(0, 5)).toEqual([0, 1, 2, 3, 4])
    expect(all.length).toBe(bytes.length)
  })
})

describe('parseSlidesViewerMessage', () => {
  test('parses ready', () => expect(parseSlidesViewerMessage({ type: 'ready' })).toEqual({ type: 'ready' }))
  test('parses rendered', () => expect(parseSlidesViewerMessage({ type: 'rendered', slideCount: 5 })).toEqual({ type: 'rendered', slideCount: 5 }))
  test('parses error', () => expect(parseSlidesViewerMessage({ type: 'error', message: 'oops' })).toEqual({ type: 'error', message: 'oops' }))
  test('ignores unknown', () => expect(parseSlidesViewerMessage({ type: 'unknown' })).toBeNull())
  test('round-trips a JSON string', () => {
    expect(parseSlidesViewerMessage(JSON.stringify({ type: 'ready' }))).toEqual({ type: 'ready' })
  })
})

describe('parseDocumentViewerMessage (SHO-467)', () => {
  test('parses ready', () => expect(parseDocumentViewerMessage({ type: 'ready' })).toEqual({ type: 'ready' }))
  test('parses rendered with itemCount', () => expect(parseDocumentViewerMessage({ type: 'rendered', itemCount: 3 })).toEqual({ type: 'rendered', itemCount: 3 }))
  test('defaults to 1 page when count is missing', () => expect(parseDocumentViewerMessage({ type: 'rendered' })).toEqual({ type: 'rendered', itemCount: 1 }))
  test('parses error', () => expect(parseDocumentViewerMessage({ type: 'error', message: 'oops' })).toEqual({ type: 'error', message: 'oops' }))
  test('ignores unknown', () => expect(parseDocumentViewerMessage({ type: 'unknown' })).toBeNull())
})

describe('fetchSlidesBytes', () => {
  test('returns the bytes on 2xx', async () => {
    const data = new Uint8Array([1, 2, 3])
    const mockFetch = async () =>
      new Response(data, {
        headers: { 'content-length': String(data.length), 'content-type': 'application/octet-stream' },
      })
    const result = await fetchSlidesBytes('http://example.com/file.pptx', { fetchImpl: mockFetch as unknown as typeof fetch })
    expect(new Uint8Array(result)).toEqual(data)
  })

  test('throws SlidesTooLargeError when the declared length exceeds the cap', async () => {
    const mockFetch = async () =>
      new Response(new Uint8Array(1), {
        headers: { 'content-length': String(60 * 1024 * 1024) },
      })
    await expect(
      fetchSlidesBytes('http://example.com/file.pptx', {
        maxBytes: MAX_SLIDES_BYTES,
        fetchImpl: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(SlidesTooLargeError)
  })

  test('throws SlidesFetchError on a non-2xx response', async () => {
    const mockFetch = async () => new Response(null, { status: 404 })
    await expect(
      fetchSlidesBytes('http://example.com/file.pptx', { fetchImpl: mockFetch as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(SlidesFetchError)
  })
})

describe('size caps', () => {
  test('web cap is 50 MB', () => expect(MAX_SLIDES_BYTES).toBe(50 * 1024 * 1024))
  test('native cap is 25 MB', () => expect(MAX_SLIDES_BYTES_NATIVE).toBe(25 * 1024 * 1024))
  test('native chunk size is 512 KB', () => expect(NATIVE_CHUNK_BYTES).toBe(512 * 1024))
})

describe('error formatters', () => {
  test('formats errors', () => {
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

  test('unsupportedDocumentMessage names the way out (SHO-467)', () => {
    expect(unsupportedDocumentMessage('old.doc')).toContain('Word 97–2003')
    expect(unsupportedDocumentMessage('open.odt')).toContain('extracted text')
    // .rtf is not binary in the SDK — it opens as text, so no message is needed
    expect(unsupportedDocumentMessage('text.rtf')).toBeNull()
    expect(unsupportedDocumentMessage('report.docx')).toBeNull()
    expect(unsupportedDocumentMessage('report.pdf')).toBeNull()
  })
})
