// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Image content guard — enforces (1) Anthropic's 5 MB per-image size limit
 * and (2) the image *format* every configured provider actually accepts, on
 * tool_result and user-vision payloads.
 *
 * Size: Anthropic rejects any `tool_result.content[].image.source.base64`
 * whose encoded payload exceeds 5,242,880 bytes. Base64 inflates raw bytes by
 * ~33%, so a ~4.4 MB PNG can produce a ~5.86 MB string that trips the cap.
 *
 * Format: every provider we route to (Anthropic, OpenAI-compatible
 * providers, DeepSeek) only documents support for PNG/JPEG/GIF/WebP. Tools
 * that read arbitrary files from disk (`read_file`) recognize a broader set
 * of image extensions — including `.bmp`/`.avif`/`.heic`/`.ico`, all common
 * in seeded web-app templates (e.g. `public/favicon.ico`) — so an agent
 * reading one of those embeds a `type: 'image'` block the model call will
 * reject outright (DeepSeek: `400 invalid_request_error`). Because the bad
 * block lives in session history, every subsequent turn that replays it
 * fails the same way until something evicts it, which can burn a large
 * fraction of a turn's wall-clock budget on repeated failed calls before the
 * agent ever recovers. See eval bug reports referencing
 * `messages[N].image[0]: unsupported image format`.
 *
 * We guard at two layers:
 *
 *   1. At emission time inside tools that can produce images (read_file,
 *      browser screenshot, MCP passthrough), so bad images never enter
 *      session history.
 *   2. In the per-API-call transformContext, scrub any bad images that may
 *      already be sitting in history from before this guard shipped (or from
 *      a provider switch after the image was embedded).
 *
 * Both layers use the same pure helpers below. The functions are deterministic
 * so they don't disturb stable-compaction's "byte-identical prompt prefix"
 * invariant.
 *
 * "Bad" covers three shapes: too big, a format no provider accepts, and — the
 * one magic bytes cannot catch — bytes that simply do not decode. A PNG with a
 * valid 8-byte signature and a corrupt IDAT sails past a signature check,
 * enters the session, and then 400s *every* later model call
 * (`messages[N].image[0]: You have uploaded an unsupported image`). So images
 * are decode-validated (`decodeImageInfo`) before they are allowed into a
 * request or into history.
 */

import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import type { ImageContent, Message, TextContent } from '@mariozechner/pi-ai'

/**
 * Maximum base64 string length permitted in a single image block.
 *
 * Anthropic's documented limit is exactly 5 * 1024 * 1024 bytes; we leave a
 * 4 KB safety margin to avoid tripping the cap on borderline images.
 */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024 - 4096

/**
 * Image MIME types every provider we route to (Anthropic, DeepSeek, and
 * OpenAI-compatible custom providers) documents support for. Deliberately
 * conservative — anything outside this set has been observed to produce a
 * hard 400 from at least one configured provider.
 */
export const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

/**
 * Identify an image's real format from its leading bytes. The declared
 * `mimeType` comes from a file extension or a tool's say-so, and is wrong
 * often enough (an SVG or HEIC saved as `.png`) that providers 400 on images
 * the MIME check alone lets through. Returns undefined when the bytes don't
 * match a known signature, so callers fall back to the declared type.
 */
export function sniffImageMimeType(base64: string): string | undefined {
  let head: Buffer
  try {
    head = Buffer.from(base64.slice(0, 32), 'base64')
  } catch {
    return undefined
  }
  const ascii = (start: number, end: number) => head.subarray(start, end).toString('latin1')
  if (head.length >= 8 && head[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (ascii(0, 4) === 'GIF8') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12)
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heic'
  }
  if (ascii(0, 2) === 'BM') return 'image/bmp'
  if (head.length >= 4 && head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0) return 'image/x-icon'
  if (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*') return 'image/tiff'
  if (/^(\uFEFF|\xEF\xBB\xBF)?\s*<(\?xml|svg)/i.test(ascii(0, head.length))) return 'image/svg+xml'
  return undefined
}

/** Dimensions and real format of an image whose bytes we successfully decoded. */
export interface DecodedImageInfo {
  mimeType: string
  width: number
  height: number
}

/**
 * Cap on inflated PNG data. A ~5 MB PNG cannot legitimately expand past this,
 * and it bounds what a hostile/corrupt `IDAT` can cost us in memory.
 */
const MAX_DECODED_RAW_BYTES = 256 * 1024 * 1024
/** Reject nonsense dimensions before doing pixel arithmetic on them. */
const MAX_IMAGE_DIMENSION = 100_000

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const PNG_CHANNELS_BY_COLOR_TYPE: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

function saneDims(width: number, height: number): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width <= 0 || height <= 0) return null
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) return null
  return { width, height }
}

/**
 * Walk every PNG chunk, verifying each CRC32 and requiring IHDR first,
 * at least one IDAT, and an IEND. Then inflate the pixel stream: a file that
 * sniffs as PNG from its 8-byte signature but carries a corrupt IDAT CRC (or a
 * truncated/garbled stream) is rejected here, before it can reach a provider
 * that would 400 the whole conversation on it.
 */
function decodePng(buf: Buffer): { width: number; height: number } | null {
  let off = 8
  let dims: { width: number; height: number } | null = null
  let interlace = 0
  let bitDepth = 0
  let colorType = -1
  let sawIdat = false
  let sawIend = false
  const idat: Buffer[] = []

  while (off + 12 <= buf.length) {
    const length = buf.readUInt32BE(off)
    if (off + 12 + length > buf.length) return null
    const type = buf.toString('latin1', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + length)
    const storedCrc = buf.readUInt32BE(off + 8 + length)
    if (crc32(buf.subarray(off + 4, off + 8 + length)) !== storedCrc) return null

    if (dims === null) {
      if (type !== 'IHDR' || length !== 13) return null
      const parsed = saneDims(data.readUInt32BE(0), data.readUInt32BE(4))
      if (!parsed) return null
      dims = parsed
      bitDepth = data[8]
      colorType = data[9]
      if (data[10] !== 0 || data[11] !== 0) return null // compression / filter method
      if (data[12] !== 0 && data[12] !== 1) return null // interlace method
      interlace = data[12]
    } else if (type === 'IDAT') {
      sawIdat = true
      idat.push(data)
    } else if (type === 'IEND') {
      sawIend = true
      break
    }
    off += 12 + length
  }

  if (!dims || !sawIdat || !sawIend) return null
  const channels = PNG_CHANNELS_BY_COLOR_TYPE[colorType]
  if (!channels) return null
  if (![1, 2, 4, 8, 16].includes(bitDepth)) return null

  const rowBytes = Math.ceil((dims.width * channels * bitDepth) / 8)
  const expectedRaw = dims.height * (1 + rowBytes)
  if (!interlace && expectedRaw > MAX_DECODED_RAW_BYTES) return null

  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: MAX_DECODED_RAW_BYTES })
  } catch {
    return null
  }
  if (raw.length === 0) return null
  // Adam7 interlacing packs the rows differently, so the exact-length check
  // only applies to the (overwhelmingly common) non-interlaced case. A
  // successful, non-empty inflate of a CRC-clean stream is the honest bar there.
  if (!interlace && raw.length !== expectedRaw) return null
  return dims
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function decodeJpeg(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let off = 2
  let dims: { width: number; height: number } | null = null
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return null
    const marker = buf[off + 1]
    if (marker === 0xff) {
      off += 1
      continue
    }
    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      off += 2
      continue
    }
    if (marker === 0xd9) break
    const length = buf.readUInt16BE(off + 2)
    if (length < 2 || off + 2 + length > buf.length) return null
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7) return null
      const parsed = saneDims(buf.readUInt16BE(off + 7), buf.readUInt16BE(off + 5))
      if (!parsed) return null
      dims = parsed
    }
    if (marker === 0xda) break // SOS — entropy-coded data follows
    off += 2 + length
  }
  if (!dims) return null
  const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), off)
  return eoi === -1 ? null : dims
}

function decodeGif(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 14) return null
  const header = buf.toString('latin1', 0, 6)
  if (header !== 'GIF87a' && header !== 'GIF89a') return null
  const dims = saneDims(buf.readUInt16LE(6), buf.readUInt16LE(8))
  if (!dims) return null
  if (buf[buf.length - 1] !== 0x3b) return null // block terminator
  return dims
}

function decodeWebp(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 20) return null
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null
  const riffSize = buf.readUInt32LE(4)
  if (8 + riffSize > buf.length) return null
  const fourcc = buf.toString('latin1', 12, 16)
  const chunk = buf.subarray(20)
  if (fourcc === 'VP8 ') {
    // Lossy: 3-byte frame tag, then the 0x9d 0x01 0x2a start code.
    if (chunk.length < 10) return null
    if (chunk[3] !== 0x9d || chunk[4] !== 0x01 || chunk[5] !== 0x2a) return null
    return saneDims(chunk.readUInt16LE(6) & 0x3fff, chunk.readUInt16LE(8) & 0x3fff)
  }
  if (fourcc === 'VP8L') {
    if (chunk.length < 5) return null
    if (chunk[0] !== 0x2f) return null
    const bits = chunk.readUInt32LE(1)
    return saneDims((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (fourcc === 'VP8X') {
    if (chunk.length < 10) return null
    const width = chunk[4] | (chunk[5] << 8) | (chunk[6] << 16)
    const height = chunk[7] | (chunk[8] << 8) | (chunk[9] << 16)
    return saneDims(width + 1, height + 1)
  }
  return null
}

/**
 * Decode-validate an image and report its real format and dimensions.
 *
 * `sniffImageMimeType()` only reads magic bytes, which is why a PNG with a
 * valid signature and a corrupt `IDAT` used to sail through the guard, get
 * persisted into a session, and then 400 *every* later model call
 * (`messages[N].image[0]: You have uploaded an unsupported image`). This walks
 * the actual container: chunk CRCs and the pixel stream for PNG, marker walk to
 * SOF + EOI for JPEG, header + trailer for GIF, RIFF/VP8 headers for WebP.
 *
 * Returns null for anything we cannot prove is a real, decodable image — the
 * caller must then keep it out of a provider request.
 */
export function decodeImageInfo(base64: string, declaredMime?: string): DecodedImageInfo | null {
  const declared = declaredMime?.toLowerCase().trim()
  const cacheKey = `${declared ?? ''}:${base64.length}:${createHash('sha1').update(base64).digest('hex')}`
  const cached = decodeCache.get(cacheKey)
  if (cached !== undefined) return cached

  const info = decodeImageInfoUncached(base64, declared)
  if (decodeCache.size >= DECODE_CACHE_LIMIT) {
    const oldest = decodeCache.keys().next().value
    if (oldest !== undefined) decodeCache.delete(oldest)
  }
  decodeCache.set(cacheKey, info)
  return info
}

/**
 * Decoding is O(pixels), and the history scrub runs on every API call, so
 * results (including rejections) are memoized by content digest. Replays of
 * the same session history cost a hash instead of a re-inflate.
 */
const decodeCache = new Map<string, DecodedImageInfo | null>()
const DECODE_CACHE_LIMIT = 64

function decodeImageInfoUncached(base64: string, declared: string | undefined): DecodedImageInfo | null {
  let buf: Buffer
  try {
    buf = Buffer.from(base64, 'base64')
  } catch {
    return null
  }
  if (buf.length < 8) return null

  const mimeType = sniffImageMimeType(base64) ?? declared
  if (!mimeType) return null

  let dims: { width: number; height: number } | null = null
  if (mimeType === 'image/png') dims = decodePng(buf)
  else if (mimeType === 'image/jpeg') dims = decodeJpeg(buf)
  else if (mimeType === 'image/gif') dims = decodeGif(buf)
  else if (mimeType === 'image/webp') dims = decodeWebp(buf)
  if (!dims) return null
  return { mimeType, width: dims.width, height: dims.height }
}

export interface OversizedPlaceholderOptions {
  /** Short human-readable source label, e.g. `read_file` or `mcp:foo`. */
  label: string
  /** Original byte length of the base64 string that exceeded the cap. */
  base64Length: number
  /** MIME type of the dropped image, if known. */
  mimeType?: string
  /**
   * Optional workspace-relative path the model can pass to a shell tool to
   * downscale and re-read. When provided, the placeholder embeds a copy-pasta
   * `sips` / `convert` command keyed to this path.
   */
  pathHint?: string
}

/**
 * Build a TextContent block that replaces an oversized image. The text is
 * model-actionable: it names the cap, reports the exact byte count, and (when
 * a path is available) suggests concrete downscale commands.
 */
export function buildOversizedPlaceholder(opts: OversizedPlaceholderOptions): TextContent {
  const { label, base64Length, mimeType, pathHint } = opts
  const sizeMb = (base64Length / (1024 * 1024)).toFixed(2)
  const capMb = (MAX_IMAGE_BASE64_BYTES / (1024 * 1024)).toFixed(2)
  const lines: string[] = [
    `[Image omitted — ${label}]`,
    `Reason: the image's base64 payload is ${base64Length} bytes (${sizeMb} MB), ` +
      `which exceeds Anthropic's per-image cap of ${MAX_IMAGE_BASE64_BYTES} bytes (~${capMb} MB).`,
  ]
  if (mimeType) lines.push(`MIME type: ${mimeType}.`)
  if (pathHint) {
    lines.push(
      `The full image is still on disk at "${pathHint}". ` +
        'Downscale it before reading, e.g. on macOS: ' +
        `\`sips -Z 1024 "${pathHint}" --out "${pathHint}.small.png"\`, ` +
        `or with ImageMagick: \`convert "${pathHint}" -resize 1024x1024 "${pathHint}.small.png"\`, ` +
        'then read the resized file.'
    )
  } else {
    lines.push(
      'Ask for a smaller image, downscale at the source, or use a shell tool to resize ' +
        '(e.g. `sips -Z 1024 <input> --out <output>` or `convert <input> -resize 1024x1024 <output>`).'
    )
  }
  return { type: 'text', text: lines.join(' ') }
}

export interface OversizedDimensionPlaceholderOptions {
  /** Short human-readable source label, e.g. `read_file` or `mcp:foo`. */
  label: string
  /** Decoded pixel size of the image that was dropped. */
  width: number
  height: number
  /** Per-image pixel cap the provider reported for this request. */
  maxDimension: number
  /** Workspace-relative path the model can shell out to and downscale. */
  pathHint?: string
}

/**
 * Build a TextContent block that replaces an image over the provider's *pixel*
 * cap — the "At least one of the image dimensions exceed max allowed size for
 * many-image requests: 3000 pixels" 400. Distinct from
 * `buildOversizedPlaceholder`, which is about base64 byte size: a long turn
 * full of screenshots can cross the dimension cap while every image is well
 * under the byte cap, and dropping the whole history over it would throw away
 * images the provider was happy with.
 */
export function buildOversizedDimensionPlaceholder(opts: OversizedDimensionPlaceholderOptions): TextContent {
  const { label, width, height, maxDimension, pathHint } = opts
  const lines: string[] = [
    `[Image omitted — ${label}]`,
    `Reason: this image is ${width}×${height} pixels, which exceeds the provider's ` +
      `per-image limit of ${maxDimension} pixels on either side once a request carries many images.`,
  ]
  if (pathHint) {
    lines.push(
      `The full image is still on disk at "${pathHint}". ` +
        'Downscale it before reading, e.g. on macOS: ' +
        `\`sips -Z ${maxDimension} "${pathHint}" --out "${pathHint}.small.png"\`, ` +
        `or with ImageMagick: \`convert "${pathHint}" -resize ${maxDimension}x${maxDimension} "${pathHint}.small.png"\`, ` +
        'then read the resized file.'
    )
  } else {
    lines.push(
      'Downscale it at the source or with a shell tool before sending it ' +
        `(e.g. \`sips -Z ${maxDimension} <input> --out <output>\` or ` +
        `\`convert <input> -resize ${maxDimension}x${maxDimension} <output>\`).`
    )
  }
  return { type: 'text', text: lines.join(' ') }
}

/**
 * Build a TextContent block that replaces an image whose format no
 * configured provider accepts. Unlike the oversized-image placeholder this
 * can't suggest a one-line fix (there's no universal "convert this in place"
 * command we can promise works), so it just names the problem and the
 * accepted formats so the agent can re-export/convert deliberately.
 */
export function buildUnsupportedFormatPlaceholder(opts: {
  label: string
  mimeType?: string
  pathHint?: string
}): TextContent {
  const { label, mimeType, pathHint } = opts
  const accepted = [...SUPPORTED_IMAGE_MIME_TYPES].map(m => m.replace('image/', '')).join(', ')
  const lines: string[] = [
    `[Image omitted — ${label}]`,
    `Reason: ${mimeType ? `the "${mimeType}"` : 'this'} image format isn't supported by the model provider ` +
      `(accepted formats: ${accepted}).`,
  ]
  if (pathHint) {
    lines.push(
      `The original file is still on disk at "${pathHint}". ` +
        `Convert it to PNG before reading, e.g. on macOS: \`sips -s format png "${pathHint}" --out "${pathHint}.png"\`, ` +
        `or with ImageMagick: \`convert "${pathHint}" "${pathHint}.png"\`, then read the converted file.`
    )
  } else {
    lines.push(`Convert the image to one of the accepted formats before sending it.`)
  }
  return { type: 'text', text: lines.join(' ') }
}

/** A base64 image we could not decode, and why. */
export interface InvalidImagePlaceholderOptions {
  /** Short human-readable source label, e.g. `read_file` or `mcp:foo`. */
  label: string
  /** MIME type the block claimed (or that its magic bytes suggested). */
  mimeType?: string
  /** Workspace-relative path when the bytes came from a file. */
  pathHint?: string
  /** Why validation failed. Defaults to "not a decodable <mime>". */
  reason?: string
}

/**
 * Build a TextContent block that replaces an image whose bytes do not decode.
 *
 * This is the placeholder that keeps a corrupt PNG out of session history: a
 * provider rejects such a block with `400 ... You have uploaded an unsupported
 * image`, and because the block is persisted, every later call in that session
 * fails the same way.
 */
export function buildInvalidImagePlaceholder(opts: InvalidImagePlaceholderOptions): TextContent {
  const { label, mimeType, pathHint, reason } = opts
  const what = mimeType ?? 'image'
  const lines: string[] = [
    `[Image omitted — ${label}]`,
    `Reason: ${reason ?? `not a decodable ${what}`} — the bytes are corrupt or truncated, ` +
      'and a model provider would reject the whole request if it were sent.',
  ]
  if (pathHint) {
    lines.push(
      `The file is still on disk at "${pathHint}". ` +
        `Re-export it (on macOS: \`sips -s format png "${pathHint}" --out "${pathHint}.png"\`, ` +
        `or \`convert "${pathHint}" "${pathHint}.png"\`), then read the new file.`
    )
  } else {
    lines.push('Capture or encode the image again, then send the fresh one.')
  }
  return { type: 'text', text: lines.join(' ') }
}

/** Per-image pixel cap a provider enforces (see `ImageGuardOptions`). */
export interface ImageGuardOptions {
  /**
   * Maximum width **or** height, in pixels, the provider accepts for one image
   * in a request that carries many images. Only ever set after a provider has
   * told us the cap for this session — with it unset the guard's behaviour is
   * byte-for-byte what it was before, which keeps the prompt-cache prefix
   * stable for every session that never hit the cap.
   */
  maxDimension?: number
}

/**
 * Return a new content array where any ImageContent that cannot be sent to a
 * provider is replaced with an actionable placeholder TextContent:
 *
 *   1. a format no configured provider accepts (bmp/ico/heic/avif/svg/…),
 *   2. bytes that do not decode (corrupt CRC, truncated, not an image at all),
 *   3. a base64 payload over the per-image cap,
 *   4. a decoded width or height over `opts.maxDimension` (only when given).
 *
 * Content blocks that are already valid (or already text) pass through by
 * reference so the caller can rely on cheap equality checks.
 */
export function enforceImageSizeLimit(
  content: ReadonlyArray<TextContent | ImageContent>,
  opts: { label: string; pathHint?: string } & ImageGuardOptions
): (TextContent | ImageContent)[] {
  let mutated = false
  const next: (TextContent | ImageContent)[] = []
  for (const block of content) {
    if (block.type !== 'image' || typeof block.data !== 'string') {
      next.push(block)
      continue
    }
    const normalizedMime = block.mimeType?.toLowerCase().trim()
    const sniffedMime = sniffImageMimeType(block.data)
    const effectiveMime = sniffedMime ?? normalizedMime
    if (effectiveMime && !SUPPORTED_IMAGE_MIME_TYPES.has(effectiveMime)) {
      next.push(buildUnsupportedFormatPlaceholder({
        label: opts.label,
        mimeType: sniffedMime ?? block.mimeType,
        pathHint: opts.pathHint,
      }))
      mutated = true
      continue
    }
    // Cheap length check before decode: inflating a 6 MB base64 payload to
    // prove it is oversized is wasted work.
    if (block.data.length > MAX_IMAGE_BASE64_BYTES) {
      next.push(buildOversizedPlaceholder({
        label: opts.label,
        base64Length: block.data.length,
        mimeType: block.mimeType,
        pathHint: opts.pathHint,
      }))
      mutated = true
      continue
    }
    // Magic bytes are not enough: a PNG with a corrupt IDAT CRC sniffs fine and
    // still poisons the session. Decode before the block is allowed through.
    const decoded = decodeImageInfo(block.data, effectiveMime)
    if (!decoded) {
      next.push(buildInvalidImagePlaceholder({
        label: opts.label,
        mimeType: effectiveMime ?? block.mimeType,
        pathHint: opts.pathHint,
      }))
      mutated = true
      continue
    }
    // Pixel dimensions come from the same decode, so a dimension cap costs no
    // extra work. Only images over the reported cap are replaced — everything
    // else the provider already accepted stays on the wire.
    if (
      opts.maxDimension &&
      (decoded.width > opts.maxDimension || decoded.height > opts.maxDimension)
    ) {
      next.push(buildOversizedDimensionPlaceholder({
        label: opts.label,
        width: decoded.width,
        height: decoded.height,
        maxDimension: opts.maxDimension,
        pathHint: opts.pathHint,
      }))
      mutated = true
      continue
    }
    if (decoded.mimeType !== normalizedMime) {
      // Providers also reject a media type that doesn't match the bytes.
      next.push({ ...block, mimeType: decoded.mimeType })
      mutated = true
      continue
    }
    next.push(block)
  }
  return mutated ? next : (content as (TextContent | ImageContent)[])
}

/**
 * Walk a message history and rewrite any UserMessage / ToolResultMessage that
 * carries an image no provider will accept (unsupported format, undecodable
 * bytes, oversized payload, or — once a provider has told us its cap —
 * dimensions over that cap). AssistantMessages cannot contain images in
 * pi-ai's type model so they're passed through untouched.
 *
 * Returns the same array reference when no message needed scrubbing; this
 * keeps prompt-cache hashes stable across calls when nothing needed fixing.
 * With no `maxDimension` the output is identical to what it has always been.
 */
export function scrubInvalidImages(
  messages: ReadonlyArray<Message>,
  opts: ImageGuardOptions = {},
): Message[] {
  let mutated = false
  const next: Message[] = []
  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const cleaned = enforceImageSizeLimit(msg.content, { label: 'user_input', maxDimension: opts.maxDimension })
      if (cleaned !== msg.content) {
        next.push({ ...msg, content: cleaned })
        mutated = true
        continue
      }
    } else if (msg.role === 'toolResult') {
      const cleaned = enforceImageSizeLimit(msg.content, {
        label: `tool:${msg.toolName}`,
        maxDimension: opts.maxDimension,
      })
      if (cleaned !== msg.content) {
        next.push({ ...msg, content: cleaned })
        mutated = true
        continue
      }
    }
    next.push(msg)
  }
  return mutated ? next : (messages as Message[])
}

/** @deprecated Old name for `scrubInvalidImages`; kept so existing imports work. */
export const scrubOversizedImages = scrubInvalidImages
