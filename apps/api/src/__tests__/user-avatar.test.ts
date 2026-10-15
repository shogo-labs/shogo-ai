// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Profile picture validation and keys.
 *
 * The format checks matter more than they look: avatar bytes are stored by us
 * and then served back with an image content type to every client that renders
 * a message. Deciding the format from the file's own header — never from the
 * upload's `Content-Type` — is what stops arbitrary content being stored and
 * served as an image, and the dimension ceiling is what stops a client that
 * skips the resize leaving a 40-megapixel picture to be decoded on every phone.
 */

process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret-user-avatar'

import { describe, expect, test } from 'bun:test'

const {
  AVATAR_MAX_BYTES,
  avatarContentKey,
  avatarHash,
  avatarStorageKey,
  avatarTokenPayload,
  avatarUrl,
  isSafeAvatarUserId,
  mimeForAvatarContentKey,
  parseAvatarUrl,
  readImageInfo,
  stripJpegMetadata,
  validateAvatarUpload,
} = await import('../lib/user-avatar')
const { verifyConversationFileToken } = await import('../lib/conversation-files')

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}

function png(width: number, height: number, padding = 0): Uint8Array {
  const bytes = new Uint8Array(24 + padding)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  writeUint32BE(bytes, 16, width)
  writeUint32BE(bytes, 20, height)
  return bytes
}

/** SOI, then a segment, then EOI. `segment` starts at its 0xFF marker. */
function jpegWith(segment: number[], width: number, height: number): Uint8Array {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03]
  const bytes = new Uint8Array([0xff, 0xd8, ...segment, ...sof, 0xff, 0xd9])
  return bytes
}

function exifSegment(payload: number[] = []): number[] {
  const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...payload]
  const length = body.length + 2
  return [0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...body]
}

function webpVp8x(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0)
  bytes.set([0x57, 0x45, 0x42, 0x50], 8)
  bytes.set([0x56, 0x50, 0x38, 0x58], 12)
  // Canvas size stored as 24-bit little-endian, minus one.
  const w = width - 1
  const h = height - 1
  bytes[24] = w & 0xff
  bytes[25] = (w >>> 8) & 0xff
  bytes[26] = (w >>> 16) & 0xff
  bytes[27] = h & 0xff
  bytes[28] = (h >>> 8) & 0xff
  bytes[29] = (h >>> 16) & 0xff
  return bytes
}

function webpVp8l(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0)
  bytes.set([0x57, 0x45, 0x42, 0x50], 8)
  bytes.set([0x56, 0x50, 0x38, 0x4c], 12)
  bytes[20] = 0x2f
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
  bytes[21] = bits & 0xff
  bytes[22] = (bits >>> 8) & 0xff
  bytes[23] = (bits >>> 16) & 0xff
  bytes[24] = (bits >>> 24) & 0xff
  return bytes
}

function webpVp8(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0)
  bytes.set([0x57, 0x45, 0x42, 0x50], 8)
  bytes.set([0x56, 0x50, 0x38, 0x20], 12)
  bytes.set([0x9d, 0x01, 0x2a], 23)
  bytes[26] = (width >> 8) & 0x3f
  bytes[27] = width & 0xff
  bytes[28] = (height >> 8) & 0x3f
  bytes[29] = height & 0xff
  return bytes
}

describe('readImageInfo', () => {
  test('reads PNG dimensions from the IHDR chunk', () => {
    expect(readImageInfo(png(512, 384))).toEqual({ mime: 'image/png', width: 512, height: 384 })
  })

  test('reads JPEG dimensions, skipping the metadata segments before the frame', () => {
    // The APP1 length in front must be walked past, not parsed as a frame.
    expect(readImageInfo(jpegWith(exifSegment([1, 2, 3, 4]), 300, 200)))
      .toEqual({ mime: 'image/jpeg', width: 300, height: 200 })
  })

  test('does not mistake a huffman table segment (0xc4) for a frame header', () => {
    // Length counts itself, so 0x0006 covers 4 payload bytes.
    const dht = [0xff, 0xc4, 0x00, 0x06, 0x11, 0x22, 0x33, 0x44]
    expect(readImageInfo(jpegWith(dht, 64, 48)))
      .toEqual({ mime: 'image/jpeg', width: 64, height: 48 })
  })

  test('reads all three WebP container variants', () => {
    expect(readImageInfo(webpVp8x(640, 480))).toEqual({ mime: 'image/webp', width: 640, height: 480 })
    expect(readImageInfo(webpVp8l(120, 90))).toEqual({ mime: 'image/webp', width: 120, height: 90 })
    expect(readImageInfo(webpVp8(200, 150))).toEqual({ mime: 'image/webp', width: 200, height: 150 })
  })

  test('rejects anything that is not a decodable image', () => {
    expect(readImageInfo(new Uint8Array(0))).toBeNull()
    expect(readImageInfo(new TextEncoder().encode('<html>not an image</html>'))).toBeNull()
    // A RIFF container that is not WebP (e.g. a wav).
    const wav = new Uint8Array(30)
    wav.set([0x52, 0x49, 0x46, 0x46], 0)
    wav.set([0x57, 0x41, 0x56, 0x45], 8)
    expect(readImageInfo(wav)).toBeNull()
    // A PDF, which a naive extension check would let through.
    expect(readImageInfo(new TextEncoder().encode('%PDF-1.7 <<>>'))).toBeNull()
  })

  test('rejects a truncated header rather than guessing', () => {
    expect(readImageInfo(png(512, 512).subarray(0, 20))).toBeNull()
    expect(readImageInfo(webpVp8x(10, 10).subarray(0, 26))).toBeNull()
  })
})

describe('stripJpegMetadata', () => {
  test('removes the EXIF segment, which is where GPS coordinates live', () => {
    const bytes = jpegWith(exifSegment([0xde, 0xad, 0xbe, 0xef]), 512, 512)
    expect(bytes).toContain(0x45) // 'E' of 'Exif' before stripping
    const stripped = stripJpegMetadata(bytes)
    const asText = Buffer.from(stripped).toString('latin1')
    expect(asText).not.toContain('Exif')
    // Still a usable JPEG, and the dimensions survive.
    expect(readImageInfo(stripped)).toEqual({ mime: 'image/jpeg', width: 512, height: 512 })
  })

  test('removes a comment segment and a Photoshop APP13 segment', () => {
    const com = [0xff, 0xfe, 0x00, 0x06, 0x68, 0x65, 0x6c, 0x6c]
    const app13 = [0xff, 0xed, 0x00, 0x04, 0x41, 0x42]
    const bytes = jpegWith(com, 32, 32)
    const withBoth = new Uint8Array([...bytes.subarray(0, 2), ...app13, ...bytes.subarray(2)])
    expect(readImageInfo(stripJpegMetadata(withBoth))).not.toBeNull()
    expect(stripJpegMetadata(withBoth).byteLength).toBeLessThan(withBoth.byteLength)
  })

  test('keeps APP0 (JFIF), which some decoders expect', () => {
    const app0 = [0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46]
    const stripped = stripJpegMetadata(jpegWith(app0, 64, 64))
    expect(Buffer.from(stripped).toString('latin1')).toContain('JFIF')
  })

  test('leaves non-JPEG bytes exactly as they were', () => {
    const bytes = png(16, 16)
    expect(stripJpegMetadata(bytes)).toEqual(bytes)
  })
})

describe('validateAvatarUpload', () => {
  test('accepts a resized PNG and reports its real format', () => {
    const result = validateAvatarUpload(png(512, 512))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mime).toBe('image/png')
      expect(result.contentKey).toMatch(/^[a-f0-9]{16}\.png$/)
    }
  })

  test('accepts JPEG and WebP, and keys them by extension', () => {
    const jpeg = validateAvatarUpload(jpegWith(exifSegment(), 512, 512))
    expect(jpeg.ok && jpeg.contentKey.endsWith('.jpg')).toBe(true)
    const webp = validateAvatarUpload(webpVp8x(512, 512))
    expect(webp.ok && webp.contentKey.endsWith('.webp')).toBe(true)
  })

  test('rejects an empty body', () => {
    const result = validateAvatarUpload(new Uint8Array(0))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('empty_file')
  })

  test('rejects anything over 1 MB (Slack\'s cap)', () => {
    const result = validateAvatarUpload(png(512, 512, AVATAR_MAX_BYTES))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('file_too_large')
      expect(result.message).toContain('1 MB')
    }
  })

  test('rejects a format that is not PNG/JPEG/WebP', () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x01])
    const result = validateAvatarUpload(gif)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('unsupported_format')
  })

  test('rejects an oversized image even when the bytes are small', () => {
    // A solid-colour PNG of 4000x4000 compresses far under 1 MB, so the byte
    // cap alone would let it through and every device would decode 16M pixels.
    const result = validateAvatarUpload(png(4000, 4000))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('image_too_large')
      expect(result.message).toContain('4000x4000')
    }
  })

  test('strips EXIF from an accepted JPEG before it is stored', () => {
    const result = validateAvatarUpload(jpegWith(exifSegment([1, 2, 3, 4, 5]), 512, 512))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Buffer.from(result.bytes).toString('latin1')).not.toContain('Exif')
    }
  })
})

describe('content addressing', () => {
  test('a different picture gets a different hash, so the URL changes with it', () => {
    const a = png(512, 512)
    const b = png(512, 511)
    expect(avatarHash(a)).not.toBe(avatarHash(b))
  })

  test('the same bytes always produce the same key', () => {
    expect(avatarContentKey(png(512, 512), 'image/png')).toBe(avatarContentKey(png(512, 512), 'image/png'))
  })
})

describe('storage keys', () => {
  test('namespaces per user and refuses a key that could escape the root', () => {
    expect(avatarStorageKey('user_1', 'abcdef0123456789.jpg'))
      .toBe('artifacts/avatars/user_1/abcdef0123456789.jpg')
    expect(() => avatarStorageKey('../../etc', 'abcdef0123456789.jpg')).toThrow()
    expect(() => avatarStorageKey('user_1', '../../../secrets.jpg')).toThrow()
    expect(() => avatarStorageKey('user_1', 'abcdef0123456789.svg')).toThrow()
  })

  test('only accepts user ids that are safe to put in a path', () => {
    expect(isSafeAvatarUserId('clx1234567890')).toBe(true)
    expect(isSafeAvatarUserId('a-b_c')).toBe(true)
    expect(isSafeAvatarUserId('../evil')).toBe(false)
    expect(isSafeAvatarUserId('')).toBe(false)
  })

  test('maps a content key back to its mime type', () => {
    expect(mimeForAvatarContentKey('abcdef0123456789.jpg')).toBe('image/jpeg')
    expect(mimeForAvatarContentKey('abcdef0123456789.png')).toBe('image/png')
    expect(mimeForAvatarContentKey('abcdef0123456789.webp')).toBe('image/webp')
    expect(mimeForAvatarContentKey('abcdef0123456789.svg')).toBeNull()
  })
})

describe('avatarUrl', () => {
  test('round-trips through parseAvatarUrl, and the token verifies', () => {
    const url = avatarUrl('user_1', 'abcdef0123456789.jpg')
    const parsed = parseAvatarUrl(url)
    expect(parsed).toEqual({ userId: 'user_1', contentKey: 'abcdef0123456789.jpg' })

    const token = new URL(`http://x${url}`).searchParams.get('t')
    expect(verifyConversationFileToken(avatarTokenPayload('user_1', 'abcdef0123456789.jpg'), token)).toBe(true)
  })

  test('a token for one user does not authorise another user\'s picture', () => {
    const url = avatarUrl('user_1', 'abcdef0123456789.jpg')
    const token = new URL(`http://x${url}`).searchParams.get('t')
    expect(verifyConversationFileToken(avatarTokenPayload('user_2', 'abcdef0123456789.jpg'), token)).toBe(false)
    expect(verifyConversationFileToken(avatarTokenPayload('user_1', 'ffffffffffffffff.jpg'), token)).toBe(false)
  })

  test('does not claim an OAuth photo, so clearing never deletes a foreign blob', () => {
    expect(parseAvatarUrl('https://lh3.googleusercontent.com/a/abc123')).toBeNull()
    expect(parseAvatarUrl('https://avatars.githubusercontent.com/u/1?v=4')).toBeNull()
    expect(parseAvatarUrl(null)).toBeNull()
    expect(parseAvatarUrl('')).toBeNull()
  })

  test('rejects a hand-edited key', () => {
    expect(parseAvatarUrl('/api/user-avatar/user_1?k=../../etc/passwd&t=x')).toBeNull()
    expect(parseAvatarUrl('/api/user-avatar/../etc?k=abcdef0123456789.jpg&t=x')).toBeNull()
    expect(parseAvatarUrl('/api/user-avatar/user_1?k=nothex.jpg&t=x')).toBeNull()
  })
})
