// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Profile picture bytes: validation and the content-addressed key that
 * `User.image` points at.
 *
 * Images live in the artifact store (S3 in cloud, `$SHOGO_DATA_DIR` on
 * desktop) and are served by `GET /api/user-avatar/:userId?k=&t=`. They are
 * deliberately NOT stored inline: an avatar rides along in every conversation
 * message payload (`author.image`), so a ~1MB `data:` URL would be echoed back
 * on every message and can blow a chat past the model's context limit — which
 * is exactly what happened to the desktop agent avatar (see the 2026-09-21
 * note in workspace-agent-cloud-storage.ts).
 */

import { createHash } from 'node:crypto'
import { signConversationFileToken } from './conversation-files'

/** Slack's own cap for a profile photo. */
export const AVATAR_MAX_BYTES = 1024 * 1024

/** What the client resizes to before uploading, and the ceiling we enforce. */
export const AVATAR_SIZE = 512
export const AVATAR_MAX_DIMENSION = 1024

const AVATAR_FILE_PREFIX = 'artifacts/avatars/'

/** The formats we accept, and the extension each key ends in. */
export const AVATAR_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

const EXTENSION_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
}

/** User ids are cuids; the serve route puts this straight into a storage key. */
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** `<16 hex>.jpg` — the content key, which the serve route validates. */
export const AVATAR_CONTENT_KEY_PATTERN = /^[a-f0-9]{16}\.(png|jpg|webp)$/

export type ImageInfo = { mime: string; width: number; height: number }

function startsWith(bytes: Uint8Array, offset: number, signature: number[]): boolean {
  if (bytes.length < offset + signature.length) return false
  return signature.every((byte, i) => bytes[offset + i] === byte)
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) >>> 0) +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  )
}

function pngInfo(bytes: Uint8Array): ImageInfo | null {
  // 8-byte signature, then an IHDR chunk whose payload starts at offset 16.
  if (!startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null
  if (!startsWith(bytes, 12, [0x49, 0x48, 0x44, 0x52])) return null
  if (bytes.length < 24) return null
  const width = readUint32BE(bytes, 16)
  const height = readUint32BE(bytes, 20)
  if (width <= 0 || height <= 0) return null
  return { mime: 'image/png', width, height }
}

/**
 * JPEG dimensions, found by walking the marker segments to the first SOFn.
 *
 * The `0xc0`–`0xcf` range holds the frame headers, but three entries in it are
 * not frames: `c4` (huffman tables), `c8` (reserved) and `cc` (arithmetic
 * coding tables). Skipping those matters — walking straight into a DHT payload
 * gets a garbage width/height.
 */
function jpegInfo(bytes: Uint8Array): ImageInfo | null {
  if (!startsWith(bytes, 0, [0xff, 0xd8])) return null
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    // Padding fills and standalone markers carry no length.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2
      continue
    }
    // Start of scan: entropy-coded data follows, no more headers to read.
    if (marker === 0xda) return null
    const length = readUint16BE(bytes, offset + 2)
    if (length < 2) return null
    const isFrame = marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) {
      if (offset + 9 >= bytes.length) return null
      const height = readUint16BE(bytes, offset + 5)
      const width = readUint16BE(bytes, offset + 7)
      if (width <= 0 || height <= 0) return null
      return { mime: 'image/jpeg', width, height }
    }
    offset += 2 + length
  }
  return null
}

/**
 * WebP dimensions. Three container variants, all reachable from a real
 * encoder, so all three are handled: `VP8 ` (lossy), `VP8L` (lossless) and
 * `VP8X` (extended, which stores the canvas size explicitly).
 */
function webpInfo(bytes: Uint8Array): ImageInfo | null {
  if (!startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46])) return null
  if (!startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50])) return null
  if (bytes.length < 30) return null

  if (startsWith(bytes, 12, [0x56, 0x50, 0x38, 0x58])) {
    // Extended: canvas width-1 and height-1 as 24-bit little-endian.
    const width = readUint24LE(bytes, 24) + 1
    const height = readUint24LE(bytes, 27) + 1
    if (width <= 0 || height <= 0) return null
    return { mime: 'image/webp', width, height }
  }

  if (startsWith(bytes, 12, [0x56, 0x50, 0x38, 0x4c])) {
    // Lossless: 0x2f signature, then 14 bits of width-1 and 14 of height-1.
    if (bytes[20] !== 0x2f) return null
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >>> 14) & 0x3fff) + 1
    if (width <= 0 || height <= 0) return null
    return { mime: 'image/webp', width, height }
  }

  if (startsWith(bytes, 12, [0x56, 0x50, 0x38, 0x20])) {
    // Lossy: 3-byte frame tag, then the 9d 01 2a sync code, then 14-bit each.
    if (!startsWith(bytes, 23, [0x9d, 0x01, 0x2a])) return null
    const width = readUint16BE(bytes, 26) & 0x3fff
    const height = readUint16BE(bytes, 28) & 0x3fff
    if (width <= 0 || height <= 0) return null
    return { mime: 'image/webp', width, height }
  }

  return null
}

/**
 * The image's real format and size, read from its own bytes.
 *
 * Format comes from the header rather than the upload's `Content-Type`, so a
 * caller cannot get arbitrary content stored and then served under an image
 * mime type. Returns null for anything not a decodable PNG/JPEG/WebP.
 */
export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  return pngInfo(bytes) ?? jpegInfo(bytes) ?? webpInfo(bytes)
}

/**
 * Drops JPEG metadata segments (APP1/APP13/COM) that can carry EXIF — including
 * GPS coordinates — out of an uploaded photo.
 *
 * A splice rather than a re-encode: the segments are optional and self
 * describing, so removing them leaves a valid JPEG. APP0 (JFIF) is kept
 * because some decoders expect it.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (!startsWith(bytes, 0, [0xff, 0xd8])) return bytes
  const kept: Uint8Array[] = [bytes.subarray(0, 2)]
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      // Not a marker boundary; keep the remainder verbatim.
      kept.push(bytes.subarray(offset))
      return concatBytes(kept)
    }
    const marker = bytes[offset + 1]
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      kept.push(bytes.subarray(offset, offset + 2))
      offset += 2
      continue
    }
    const length = readUint16BE(bytes, offset + 2)
    if (length < 2) {
      kept.push(bytes.subarray(offset))
      return concatBytes(kept)
    }
    const segmentEnd = offset + 2 + length
    const isMetadata = marker === 0xe1 || marker === 0xed || marker === 0xfe
    if (!isMetadata) kept.push(bytes.subarray(offset, segmentEnd))
    offset = segmentEnd
    if (marker === 0xda) {
      // Start of scan: the rest is entropy-coded image data.
      kept.push(bytes.subarray(offset))
      return concatBytes(kept)
    }
  }
  kept.push(bytes.subarray(offset))
  return concatBytes(kept)
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

/** Content hash, so a new picture is a new URL (and never a stale cache hit). */
export function avatarHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

/** `<hash>.<ext>` — identifies the bytes and their format in one token. */
export function avatarContentKey(bytes: Uint8Array, mime: string): string {
  const ext = AVATAR_MIME_EXTENSIONS[mime]
  if (!ext) throw new Error(`Unsupported avatar mime type: ${mime}`)
  return `${avatarHash(bytes)}.${ext}`
}

export function avatarStorageKey(userId: string, contentKey: string): string {
  if (!USER_ID_PATTERN.test(userId)) throw new Error('Invalid user id')
  if (!AVATAR_CONTENT_KEY_PATTERN.test(contentKey)) throw new Error('Invalid avatar key')
  return `${AVATAR_FILE_PREFIX}${userId}/${contentKey}`
}

export function isSafeAvatarUserId(userId: string): boolean {
  return USER_ID_PATTERN.test(userId)
}

export function mimeForAvatarContentKey(contentKey: string): string | null {
  const ext = contentKey.split('.').pop() ?? ''
  return EXTENSION_MIME[ext] ?? null
}

/** Namespaces the shared file token so an avatar token can't authorise anything else. */
export function avatarTokenPayload(userId: string, contentKey: string): string {
  return `avatar:${userId}:${contentKey}`
}

/**
 * The stable URL written into `User.image`.
 *
 * Relative on purpose: the same row is read by the web app, the desktop app and
 * the phone, and only the client knows which origin it is talking to. Callers
 * resolve it with `resolveChatAttachmentUrl`, which passes absolute values
 * (OAuth profile photos) through untouched.
 */
export function avatarUrl(userId: string, contentKey: string): string {
  const token = signConversationFileToken(avatarTokenPayload(userId, contentKey))
  return `/api/user-avatar/${encodeURIComponent(userId)}?k=${encodeURIComponent(contentKey)}&t=${token}`
}

/**
 * Reads back a URL this module produced.
 *
 * Only our own URLs are recognised, so clearing or replacing a picture never
 * touches an OAuth photo (a Google/Apple `picture` stays a plain URL in the
 * column and has no blob of ours behind it to delete).
 */
export function parseAvatarUrl(url: string | null | undefined): { userId: string; contentKey: string } | null {
  if (!url) return null
  const match = /^\/api\/user-avatar\/([^?]+)\?k=([^&]+)/.exec(url)
  if (!match) return null
  const userId = decodeURIComponent(match[1])
  const contentKey = decodeURIComponent(match[2])
  if (!isSafeAvatarUserId(userId) || !AVATAR_CONTENT_KEY_PATTERN.test(contentKey)) return null
  return { userId, contentKey }
}

export type AvatarUploadResult =
  | { ok: true; bytes: Uint8Array; mime: string; contentKey: string }
  | { ok: false; code: string; message: string }

/**
 * Everything we can check before storing an uploaded picture.
 *
 * Bytes are capped at `AVATAR_MAX_BYTES` and dimensions at
 * `AVATAR_MAX_DIMENSION`, so a client that skips the resize cannot leave a
 * 40-megapixel image being decoded on every phone that renders a message.
 */
export function validateAvatarUpload(bytes: Uint8Array): AvatarUploadResult {
  if (!bytes.byteLength) {
    return { ok: false, code: 'empty_file', message: 'The image is empty' }
  }
  if (bytes.byteLength > AVATAR_MAX_BYTES) {
    const mb = (bytes.byteLength / (1024 * 1024)).toFixed(1)
    return {
      ok: false,
      code: 'file_too_large',
      message: `Images must be 1 MB or smaller (this one is ${mb} MB)`,
    }
  }

  const info = readImageInfo(bytes)
  if (!info) {
    return {
      ok: false,
      code: 'unsupported_format',
      message: 'Images must be a PNG, JPEG or WebP',
    }
  }
  if (info.width > AVATAR_MAX_DIMENSION || info.height > AVATAR_MAX_DIMENSION) {
    return {
      ok: false,
      code: 'image_too_large',
      message: `Images must be ${AVATAR_MAX_DIMENSION}x${AVATAR_MAX_DIMENSION} or smaller (this one is ${info.width}x${info.height})`,
    }
  }

  const cleaned = info.mime === 'image/jpeg' ? stripJpegMetadata(bytes) : bytes
  return { ok: true, bytes: cleaned, mime: info.mime, contentKey: avatarContentKey(cleaned, info.mime) }
}
