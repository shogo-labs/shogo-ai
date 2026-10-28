// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from '@mariozechner/pi-ai'
import {
  MAX_IMAGE_BASE64_BYTES,
  SUPPORTED_IMAGE_MIME_TYPES,
  buildInvalidImagePlaceholder,
  buildOversizedPlaceholder,
  buildUnsupportedFormatPlaceholder,
  decodeImageInfo,
  enforceImageSizeLimit,
  scrubInvalidImages,
  scrubOversizedImages,
  sniffImageMimeType,
} from '../image-size-guard'

/**
 * Real encoder output (see `fixtures/README` notes in the PR): decode
 * validation rejects anything that isn't a genuine container, so a fake
 * `'AAAA'` payload can no longer stand in for "a fine little PNG".
 */
function fixtureBase64(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url)).toString('base64')
}

const PNG_FILE = fixtureBase64('screenshot-fixture.png')
const JPEG_FILE = fixtureBase64('screenshot-fixture.jpg')
const GIF_FILE = fixtureBase64('screenshot-fixture.gif')
const WEBP_FILE = fixtureBase64('screenshot-fixture.webp')

function smallImage(): ImageContent {
  return { type: 'image', data: PNG_FILE, mimeType: 'image/png' }
}

function bigImage(): ImageContent {
  return {
    type: 'image',
    data: 'A'.repeat(MAX_IMAGE_BASE64_BYTES + 1),
    mimeType: 'image/png',
  }
}

/** A tiny, well-under-size image whose format no provider accepts. */
function unsupportedFormatImage(mimeType = 'image/x-icon'): ImageContent {
  return { type: 'image', data: 'AAAA', mimeType }
}

function text(t: string): TextContent {
  return { type: 'text', text: t }
}

describe('buildOversizedPlaceholder', () => {
  test('reports the byte count and a path-specific downscale hint when given a path', () => {
    const block = buildOversizedPlaceholder({
      label: 'read_file',
      base64Length: 6_000_000,
      mimeType: 'image/png',
      pathHint: 'screenshots/big.png',
    })
    expect(block.type).toBe('text')
    expect(block.text).toContain('6000000')
    expect(block.text).toContain('image/png')
    expect(block.text).toContain('screenshots/big.png')
    expect(block.text.toLowerCase()).toMatch(/sips|convert/)
  })

  test('falls back to a generic hint when no path is available', () => {
    const block = buildOversizedPlaceholder({
      label: 'mcp:foo',
      base64Length: 6_000_000,
    })
    expect(block.text).toContain('mcp:foo')
    expect(block.text.toLowerCase()).toMatch(/sips|convert/)
  })
})

describe('SUPPORTED_IMAGE_MIME_TYPES', () => {
  test('is exactly the formats DeepSeek and Anthropic both document support for', () => {
    expect([...SUPPORTED_IMAGE_MIME_TYPES].sort()).toEqual(
      ['image/gif', 'image/jpeg', 'image/png', 'image/webp'].sort()
    )
  })
})

describe('buildUnsupportedFormatPlaceholder', () => {
  test('names the rejected format and the accepted set, with a convert hint when a path is available', () => {
    const block = buildUnsupportedFormatPlaceholder({
      label: 'read_file',
      mimeType: 'image/x-icon',
      pathHint: 'public/favicon.ico',
    })
    expect(block.type).toBe('text')
    expect(block.text).toContain('image/x-icon')
    expect(block.text).toContain('public/favicon.ico')
    expect(block.text.toLowerCase()).toMatch(/sips|convert/)
    expect(block.text).toContain('png')
  })

  test('falls back to a generic convert hint when no path is available', () => {
    const block = buildUnsupportedFormatPlaceholder({ label: 'mcp:foo', mimeType: 'image/bmp' })
    expect(block.text).toContain('mcp:foo')
    expect(block.text).toContain('image/bmp')
  })
})

describe('enforceImageSizeLimit', () => {
  test('passes through arrays that contain only small images and text', () => {
    const content: (TextContent | ImageContent)[] = [smallImage(), text('hi')]
    const out = enforceImageSizeLimit(content, { label: 'read_file' })
    expect(out).toBe(content)
  })

  test('replaces oversized images with a placeholder text block and keeps the rest', () => {
    const content: (TextContent | ImageContent)[] = [bigImage(), text('details')]
    const out = enforceImageSizeLimit(content, {
      label: 'read_file',
      pathHint: 'a/b.png',
    })
    expect(out).not.toBe(content)
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe('text')
    expect((out[0] as TextContent).text).toContain('Image omitted')
    expect((out[0] as TextContent).text).toContain('a/b.png')
    expect(out[1]).toBe(content[1])
  })

  test('handles arrays with multiple oversized images', () => {
    const a = bigImage()
    const b = bigImage()
    const out = enforceImageSizeLimit([a, b], { label: 'browser:screenshot' })
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe('text')
    expect(out[1].type).toBe('text')
  })

  test('replaces images in an unsupported format (e.g. .ico read via read_file) with a placeholder', () => {
    const content: (TextContent | ImageContent)[] = [unsupportedFormatImage(), text('meta')]
    const out = enforceImageSizeLimit(content, { label: 'read_file', pathHint: 'public/favicon.ico' })
    expect(out).not.toBe(content)
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe('text')
    expect((out[0] as TextContent).text).toContain('Image omitted')
    expect((out[0] as TextContent).text).toContain('image/x-icon')
    expect(out[1]).toBe(content[1])
  })

  test.each(['image/bmp', 'image/avif', 'image/heic', 'image/svg+xml'])(
    'flags %s as unsupported',
    (mimeType) => {
      const out = enforceImageSizeLimit([unsupportedFormatImage(mimeType)], { label: 'read_file' })
      expect(out[0].type).toBe('text')
    }
  )

  test.each([
    ['image/png', PNG_FILE],
    ['image/jpeg', JPEG_FILE],
    ['image/gif', GIF_FILE],
    ['image/webp', WEBP_FILE],
  ])('passes a decodable %s through untouched', (mimeType, data) => {
    const content: (TextContent | ImageContent)[] = [{ type: 'image', data: data as string, mimeType }]
    const out = enforceImageSizeLimit(content, { label: 'read_file' })
    expect(out).toBe(content)
  })

  test.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])(
    'flags %s whose bytes decode to nothing',
    (mimeType) => {
      const content: (TextContent | ImageContent)[] = [unsupportedFormatImage(mimeType)]
      const out = enforceImageSizeLimit(content, { label: 'read_file' })
      expect(out).not.toBe(content)
      expect(out[0].type).toBe('text')
      expect((out[0] as TextContent).text).toContain('not a decodable')
    }
  )

  test('is case-insensitive when matching mimeType against the supported set', () => {
    const content: (TextContent | ImageContent)[] = [{ type: 'image', data: PNG_FILE, mimeType: 'IMAGE/PNG' }]
    const out = enforceImageSizeLimit(content, { label: 'read_file' })
    expect(out).toBe(content)
  })

  test('labels an image that declares no mimeType from its own bytes', () => {
    const content: (TextContent | ImageContent)[] = [{ type: 'image', data: PNG_FILE } as ImageContent]
    const out = enforceImageSizeLimit(content, { label: 'read_file' })
    expect(out[0]).toEqual({ type: 'image', data: PNG_FILE, mimeType: 'image/png' })
  })

  test('rejects an image with no mimeType whose bytes are not an image', () => {
    const content: (TextContent | ImageContent)[] = [{ type: 'image', data: 'AAAA' } as ImageContent]
    const out = enforceImageSizeLimit(content, { label: 'read_file' })
    expect(out).not.toBe(content)
    expect((out[0] as TextContent).text).toContain('Image omitted')
  })

  test('checks format before size, so an unsupported-format image gets the format placeholder even if also oversized', () => {
    const badBoth: ImageContent = {
      type: 'image',
      data: 'A'.repeat(MAX_IMAGE_BASE64_BYTES + 1),
      mimeType: 'image/bmp',
    }
    const out = enforceImageSizeLimit([badBoth], { label: 'read_file' })
    expect((out[0] as TextContent).text).toContain('image/bmp')
    expect((out[0] as TextContent).text).not.toContain('exceeds')
  })

  test('checks size before decoding, so an oversized payload is reported as oversized and never inflated', () => {
    const oversized: ImageContent = {
      type: 'image',
      data: 'A'.repeat(MAX_IMAGE_BASE64_BYTES + 1),
      mimeType: 'image/png',
    }
    const out = enforceImageSizeLimit([oversized], { label: 'read_file', pathHint: 'big.png' })
    const text = (out[0] as TextContent).text
    expect(text).toContain('exceeds')
    expect(text).toContain('big.png')
    expect(text).not.toContain('not a decodable')
  })
})

describe('sniffed image format', () => {
  const b64 = (bytes: number[] | string) =>
    Buffer.from(typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : Uint8Array.from(bytes)).toString('base64')
  const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])
  const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])

  test.each([
    [PNG, 'image/png'],
    [JPEG, 'image/jpeg'],
    [b64('GIF89a\0\0'), 'image/gif'],
    [b64('RIFF\0\0\0\0WEBPVP8 '), 'image/webp'],
    [b64('\0\0\0\x18ftypheic\0\0'), 'image/heic'],
    [b64('\0\0\0\x1cftypavif\0\0'), 'image/avif'],
    [b64('BM6\0\0\0\0\0'), 'image/bmp'],
    [b64([0, 0, 1, 0, 1, 0, 16, 16]), 'image/x-icon'],
    [b64('<?xml version="1.0"?><svg'), 'image/svg+xml'],
    [b64('  <svg xmlns="http://www.w3.org/2000/svg">'), 'image/svg+xml'],
    ['AAAA', undefined],
  ])('sniffs %s as %s', (data, expected) => {
    expect(sniffImageMimeType(data)).toBe(expected)
  })

  test('replaces an SVG mislabeled as PNG (the history image providers 400 on)', () => {
    const svgAsPng: ImageContent = { type: 'image', data: b64('<svg xmlns="http://www.w3.org/2000/svg"/>'), mimeType: 'image/png' }
    const out = enforceImageSizeLimit([svgAsPng], { label: 'read_file' })
    expect(out[0].type).toBe('text')
    expect((out[0] as TextContent).text).toContain('image/svg+xml')
  })

  test('relabels a supported image whose declared type is wrong', () => {
    const jpegAsPng: ImageContent = { type: 'image', data: JPEG_FILE, mimeType: 'image/png' }
    expect(enforceImageSizeLimit([jpegAsPng], { label: 'read_file' })).toEqual([{ ...jpegAsPng, mimeType: 'image/jpeg' }])

    const pngAsIcon: ImageContent = { type: 'image', data: PNG_FILE, mimeType: 'image/x-icon' }
    expect(enforceImageSizeLimit([pngAsIcon], { label: 'read_file' })).toEqual([{ ...pngAsIcon, mimeType: 'image/png' }])
  })

  test('leaves a correctly-labeled image untouched by reference', () => {
    const content: (TextContent | ImageContent)[] = [{ type: 'image', data: PNG_FILE, mimeType: 'image/png' }]
    expect(enforceImageSizeLimit(content, { label: 'read_file' })).toBe(content)
  })
})

describe('scrubOversizedImages', () => {
  function userMsg(content: UserMessage['content']): UserMessage {
    return { role: 'user', content, timestamp: 0 }
  }

  function toolResultMsg(content: ToolResultMessage['content']): ToolResultMessage {
    return {
      role: 'toolResult',
      toolCallId: 't1',
      toolName: 'read_file',
      content,
      isError: false,
      timestamp: 0,
    }
  }

  function assistantMsg(): AssistantMessage {
    return {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 0,
    }
  }

  test('returns the same array reference when nothing needs scrubbing', () => {
    const messages: Message[] = [
      userMsg([text('hi'), smallImage()]),
      toolResultMsg([smallImage(), text('ok')]),
      assistantMsg(),
    ]
    const out = scrubOversizedImages(messages)
    expect(out).toBe(messages)
  })

  test('rewrites oversized images in ToolResultMessage.content', () => {
    const toolResult = toolResultMsg([bigImage(), text('meta')])
    const messages: Message[] = [toolResult]
    const out = scrubOversizedImages(messages)
    expect(out).not.toBe(messages)
    const cleaned = out[0] as ToolResultMessage
    expect(cleaned.role).toBe('toolResult')
    expect(cleaned.toolCallId).toBe('t1')
    expect(cleaned.content[0].type).toBe('text')
    expect((cleaned.content[0] as TextContent).text).toContain('Image omitted')
    expect(cleaned.content[1]).toEqual({ type: 'text', text: 'meta' })
  })

  test('rewrites oversized images in UserMessage.content arrays', () => {
    const messages: Message[] = [userMsg([bigImage()])]
    const out = scrubOversizedImages(messages)
    expect(out).not.toBe(messages)
    const cleaned = out[0] as UserMessage
    expect(Array.isArray(cleaned.content)).toBe(true)
    const arr = cleaned.content as (TextContent | ImageContent)[]
    expect(arr[0].type).toBe('text')
  })

  test('leaves UserMessage with string content untouched', () => {
    const msg: UserMessage = { role: 'user', content: 'plain text', timestamp: 0 }
    const out = scrubOversizedImages([msg])
    expect(out[0]).toBe(msg)
  })

  test('leaves AssistantMessage untouched even when adjacent messages get scrubbed', () => {
    const assistant = assistantMsg()
    const tool = toolResultMsg([bigImage()])
    const messages: Message[] = [assistant, tool]
    const out = scrubOversizedImages(messages)
    expect(out[0]).toBe(assistant)
    expect(out[1]).not.toBe(tool)
  })

  test('is deterministic: re-running on already-scrubbed messages is a no-op', () => {
    const messages: Message[] = [toolResultMsg([bigImage()])]
    const once = scrubOversizedImages(messages)
    const twice = scrubOversizedImages(once)
    expect(twice).toBe(once)
  })

  test('rewrites unsupported-format images already sitting in ToolResultMessage history', () => {
    // Regression test: an agent reading e.g. `public/favicon.ico` via
    // read_file embeds an `image/x-icon` block into a tool result. Every
    // subsequent turn that replays this message from history must NOT
    // resend the raw .ico bytes — DeepSeek (and any provider outside
    // {png,jpeg,gif,webp}) rejects the whole request with a 400, which
    // previously repeated on every later turn in the same session.
    const toolResult = toolResultMsg([unsupportedFormatImage(), text('meta')])
    const messages: Message[] = [toolResult]
    const out = scrubOversizedImages(messages)
    expect(out).not.toBe(messages)
    const cleaned = out[0] as ToolResultMessage
    expect(cleaned.content[0].type).toBe('text')
    expect((cleaned.content[0] as TextContent).text).toContain('Image omitted')
  })
})

/**
 * A valid PNG with one byte flipped inside its IDAT data. Built here from the
 * committed encoder output so no invalid image bytes ever enter the repo.
 * (The card for SHO-41 asks for `len - 40`: that lands in IDAT for this
 * fixture.)
 */
function corruptPngFixture(): Buffer {
  const bytes = readFileSync(new URL('./fixtures/screenshot-fixture.png', import.meta.url))
  const corrupt = Buffer.from(bytes)
  corrupt[corrupt.length - 40] ^= 0xff
  return corrupt
}

describe('decodeImageInfo', () => {
  test('accepts encoder output for every supported format and reports real dims', () => {
    expect(decodeImageInfo(PNG_FILE, 'image/png')).toEqual({ mimeType: 'image/png', width: 64, height: 64 })
    expect(decodeImageInfo(JPEG_FILE, 'image/jpeg')).toEqual({ mimeType: 'image/jpeg', width: 64, height: 64 })
    expect(decodeImageInfo(GIF_FILE, 'image/gif')).toEqual({ mimeType: 'image/gif', width: 64, height: 64 })
    expect(decodeImageInfo(WEBP_FILE, 'image/webp')).toEqual({ mimeType: 'image/webp', width: 64, height: 64 })
  })

  test('trusts the bytes over a wrong declared type', () => {
    expect(decodeImageInfo(JPEG_FILE, 'image/png')).toMatchObject({ mimeType: 'image/jpeg', width: 64 })
    expect(decodeImageInfo(PNG_FILE, undefined)).toMatchObject({ mimeType: 'image/png', width: 64 })
  })

  test('rejects a PNG whose IDAT CRC no longer matches', () => {
    // The exact production-poison shape: valid signature, valid IHDR, corrupt
    // pixel data. Magic-byte sniffing says "image/png"; a real decoder does not.
    const corrupt = corruptPngFixture().toString('base64')
    expect(sniffImageMimeType(corrupt)).toBe('image/png')
    expect(decodeImageInfo(corrupt, 'image/png')).toBeNull()
  })

  test('rejects a truncated PNG', () => {
    const truncated = Buffer.from(PNG_FILE, 'base64').subarray(0, 60).toString('base64')
    expect(decodeImageInfo(truncated, 'image/png')).toBeNull()
  })

  test('rejects a JPEG with no EOI marker', () => {
    const bytes = Buffer.from(JPEG_FILE, 'base64')
    expect(decodeImageInfo(bytes.subarray(0, bytes.length - 2).toString('base64'), 'image/jpeg')).toBeNull()
  })

  test('rejects impossible dimensions', () => {
    const gif = Buffer.from(GIF_FILE, 'base64')
    gif.writeUInt16LE(0, 6) // logical screen width 0
    expect(decodeImageInfo(gif.toString('base64'), 'image/gif')).toBeNull()

    const png = Buffer.from(PNG_FILE, 'base64')
    png.writeUInt32BE(0, 16) // IHDR width 0
    expect(decodeImageInfo(png.toString('base64'), 'image/png')).toBeNull()
  })

  test('rejects bytes that are not an image at all', () => {
    expect(decodeImageInfo('AAAA', 'image/png')).toBeNull()
    expect(decodeImageInfo(Buffer.from('hello world').toString('base64'), undefined)).toBeNull()
  })

  test('is deterministic across repeated calls', () => {
    expect(decodeImageInfo(PNG_FILE, 'image/png')).toEqual(decodeImageInfo(PNG_FILE, 'image/png'))
    const corrupt = corruptPngFixture().toString('base64')
    expect(decodeImageInfo(corrupt, 'image/png')).toBeNull()
    expect(decodeImageInfo(corrupt, 'image/png')).toBeNull()
  })
})

describe('buildInvalidImagePlaceholder', () => {
  test('names the source, the reason and the on-disk path with a re-export hint', () => {
    const block = buildInvalidImagePlaceholder({
      label: 'read_file',
      mimeType: 'image/png',
      pathHint: '.shogo/screenshots/run/step-01.png',
    })
    expect(block.type).toBe('text')
    expect(block.text).toContain('[Image omitted — read_file]')
    expect(block.text).toContain('not a decodable image/png')
    expect(block.text).toContain('.shogo/screenshots/run/step-01.png')
    expect(block.text.toLowerCase()).toContain('sips')
  })

  test('uses an explicit reason when the caller has one', () => {
    const block = buildInvalidImagePlaceholder({ label: 'mcp:foo', reason: 'the model rejected it' })
    expect(block.text).toContain('the model rejected it')
  })
})

describe('corrupt images in a tool result', () => {
  test('enforceImageSizeLimit replaces the image with one text placeholder', () => {
    const corrupt: ImageContent = {
      type: 'image',
      data: corruptPngFixture().toString('base64'),
      mimeType: 'image/png',
    }
    const content: (TextContent | ImageContent)[] = [corrupt, text('{"path":".shogo/screenshots/s.png"}')]
    const out = enforceImageSizeLimit(content, { label: 'read_file', pathHint: '.shogo/screenshots/s.png' })
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe('text')
    expect((out[0] as TextContent).text).toContain('Image omitted')
    expect((out[0] as TextContent).text).toContain('not a decodable image/png')
    expect(out[1]).toBe(content[1])
  })

  test('scrubInvalidImages cleans a tool result already sitting in history', () => {
    const corrupt: ImageContent = {
      type: 'image',
      data: corruptPngFixture().toString('base64'),
      mimeType: 'image/png',
    }
    const messages: Message[] = [
      {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'browser',
        content: [corrupt, text('{"path":".shogo/screenshots/s.png"}')],
        isError: false,
        timestamp: 0,
      },
    ]
    const out = scrubInvalidImages(messages)
    expect(out).not.toBe(messages)
    const cleaned = out[0] as ToolResultMessage
    expect(cleaned.content[0].type).toBe('text')
    expect((cleaned.content[0] as TextContent).text).toContain('Image omitted')
    expect(scrubInvalidImages(out)).toBe(out)
  })

  test('scrubInvalidImages leaves a real screenshot alone by reference', () => {
    const messages: Message[] = [
      { role: 'user', content: [text('look'), smallImage()], timestamp: 0 },
      {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'browser',
        content: [smallImage(), text('ok')],
        isError: false,
        timestamp: 0,
      },
    ]
    expect(scrubInvalidImages(messages)).toBe(messages)
  })

  test('keeps the old name as an alias so existing imports keep working', () => {
    expect(scrubOversizedImages).toBe(scrubInvalidImages)
  })
})
