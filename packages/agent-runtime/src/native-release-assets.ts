// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Store artwork from one logo.
 *
 * A store build needs four images, and a Shogo project arrives with none of them:
 * a 1024 icon, an Android adaptive foreground (the subject has to sit inside the
 * safe zone or a circle mask crops its corners off), a splash icon, and Play's
 * 512 listing icon — plus a background colour sampled from the logo itself, so
 * the adaptive icon does not sit on a colour that clashes with its own artwork.
 *
 * Samsara's assets (`icon`, `adaptive-icon`, `splash-icon`, background `#0b0b0d`)
 * are the reference implementation, and they were made by hand.
 *
 * **Why a PNG codec and not a dependency.** This runs inside the agent runtime on
 * every desktop and every pod; a native image library is a per-platform binary in
 * the build matrix for four fixed transforms. `node:zlib` already ships, so the
 * only work is un-filtering scanlines and writing them back. The subset is
 * deliberate and enforced: 8-bit RGB or RGBA, non-interlaced. Anything else is
 * refused with the reason, because silently producing a cropped icon is worse
 * than asking for the file again.
 */

import { deflateSync, inflateSync } from 'node:zlib'

export interface RgbaImage {
  width: number
  height: number
  rgba: Uint8Array
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** Encode 8-bit RGBA to a PNG. */
export function encodePng(image: RgbaImage): Buffer {
  const { width, height, rgba } = image
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  header[10] = 0
  header[11] = 0
  header[12] = 0

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ])
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * Decode a PNG we can trust ourselves to transform.
 *
 * Refuses anything outside the supported subset with the reason rather than
 * guessing: a 16-bit or interlaced logo scaled by the wrong stride is a corrupt
 * icon that only shows up on a device.
 */
export function decodePng(input: Uint8Array | Buffer): RgbaImage {
  const buf = Buffer.from(input)
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('That file is not a PNG. Send a PNG (JPG support is not implemented).')
  }

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat: Buffer[] = []

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii')
    const data = buf.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]!
      colorType = data[9]!
      interlace = data[12]!
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
  }

  if (bitDepth !== 8) throw new Error(`That PNG is ${bitDepth}-bit. Send an 8-bit PNG.`)
  if (colorType !== 2 && colorType !== 6) {
    throw new Error('That PNG uses a palette or greyscale mode. Send an RGB or RGBA PNG.')
  }
  if (interlace !== 0) throw new Error('That PNG is interlaced. Re-save it without interlacing.')
  if (!width || !height) throw new Error('That PNG has no size.')

  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const out = new Uint8Array(width * height * 4)
  let prev = new Uint8Array(stride)

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!
    const line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels]! : 0
      const b = prev[x]!
      const c = x >= channels ? prev[x - channels]! : 0
      switch (filter) {
        case 0:
          break
        case 1:
          line[x] = (line[x]! + a) & 0xff
          break
        case 2:
          line[x] = (line[x]! + b) & 0xff
          break
        case 3:
          line[x] = (line[x]! + ((a + b) >> 1)) & 0xff
          break
        case 4:
          line[x] = (line[x]! + paeth(a, b, c)) & 0xff
          break
        default:
          throw new Error(`That PNG uses filter ${filter}, which is not valid.`)
      }
    }
    for (let x = 0; x < width; x += 1) {
      const src = x * channels
      const dst = (y * width + x) * 4
      out[dst] = line[src]!
      out[dst + 1] = line[src + 1]!
      out[dst + 2] = line[src + 2]!
      out[dst + 3] = channels === 4 ? line[src + 3]! : 255
    }
    prev = line
  }

  return { width, height, rgba: out }
}

/**
 * Bilinear resize, in premultiplied alpha.
 *
 * Straight-alpha interpolation pulls the colour of fully transparent pixels into
 * every edge, which is what gives a scaled logo a grey halo on a dark store
 * background.
 */
export function resizeRgba(src: RgbaImage, width: number, height: number): RgbaImage {
  const out = new Uint8Array(width * height * 4)
  const sx = src.width / width
  const sy = src.height / height

  const sample = (x: number, y: number): [number, number, number, number] => {
    const px = Math.min(src.width - 1, Math.max(0, x))
    const py = Math.min(src.height - 1, Math.max(0, y))
    const i = (py * src.width + px) * 4
    const a = src.rgba[i + 3]! / 255
    return [src.rgba[i]! * a, src.rgba[i + 1]! * a, src.rgba[i + 2]! * a, a]
  }

  for (let y = 0; y < height; y += 1) {
    const fy = (y + 0.5) * sy - 0.5
    const y0 = Math.floor(fy)
    const wy = fy - y0
    for (let x = 0; x < width; x += 1) {
      const fx = (x + 0.5) * sx - 0.5
      const x0 = Math.floor(fx)
      const wx = fx - x0

      const p00 = sample(x0, y0)
      const p10 = sample(x0 + 1, y0)
      const p01 = sample(x0, y0 + 1)
      const p11 = sample(x0 + 1, y0 + 1)

      const mix = (k: number) =>
        (p00[k]! * (1 - wx) + p10[k]! * wx) * (1 - wy) + (p01[k]! * (1 - wx) + p11[k]! * wx) * wy

      const a = mix(3)
      const dst = (y * width + x) * 4
      if (a <= 0.0001) {
        out[dst] = 0
        out[dst + 1] = 0
        out[dst + 2] = 0
        out[dst + 3] = 0
        continue
      }
      out[dst] = Math.round(Math.min(255, mix(0) / a))
      out[dst + 1] = Math.round(Math.min(255, mix(1) / a))
      out[dst + 2] = Math.round(Math.min(255, mix(2) / a))
      out[dst + 3] = Math.round(Math.min(1, a) * 255)
    }
  }

  return { width, height, rgba: out }
}

/**
 * The colour an adaptive icon's background should be: what the logo's own border
 * is made of.
 *
 * Sampled from the outermost ring, ignoring transparent pixels, so a logo on a
 * flat background produces that exact background and a cut-out logo produces
 * whatever its silhouette sits on.
 */
export function sampleBackgroundColor(src: RgbaImage): string {
  const { width, height, rgba } = src
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  const add = (x: number, y: number) => {
    const i = (y * width + x) * 4
    if (rgba[i + 3]! < 8) return
    r += rgba[i]!
    g += rgba[i + 1]!
    b += rgba[i + 2]!
    n += 1
  }
  for (let x = 0; x < width; x += 1) {
    add(x, 0)
    add(x, height - 1)
  }
  for (let y = 0; y < height; y += 1) {
    add(0, y)
    add(width - 1, y)
  }
  if (!n) return '#0b0b0d'
  const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

/**
 * Fill the background and repaint near-black pixels that touch it.
 *
 * A logo exported on black leaves a black border that reads as a seam against a
 * lighter adaptive background. Only pixels connected to the border are touched, so
 * black *inside* the subject (type, outlines) stays black.
 */
export function flattenBackgroundSeams(src: RgbaImage, backgroundColor: string): RgbaImage {
  const { width, height } = src
  const out = { width, height, rgba: Uint8Array.from(src.rgba) }
  const bg = [
    parseInt(backgroundColor.slice(1, 3), 16),
    parseInt(backgroundColor.slice(3, 5), 16),
    parseInt(backgroundColor.slice(5, 7), 16),
  ]

  const nearBlack = (i: number) => {
    const a = out.rgba[i + 3]!
    if (a < 8) return true
    return out.rgba[i]! + out.rgba[i + 1]! + out.rgba[i + 2]! < 24
  }

  const seen = new Uint8Array(width * height)
  const queue: number[] = []
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const p = y * width + x
    if (seen[p]) return
    seen[p] = 1
    if (!nearBlack(p * 4)) return
    queue.push(p)
  }

  for (let x = 0; x < width; x += 1) {
    push(x, 0)
    push(x, height - 1)
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y)
    push(width - 1, y)
  }

  while (queue.length) {
    const p = queue.pop()!
    const x = p % width
    const y = Math.floor(p / width)
    const i = p * 4
    out.rgba[i] = bg[0]!
    out.rgba[i + 1] = bg[1]!
    out.rgba[i + 2] = bg[2]!
    out.rgba[i + 3] = 255
    // 4-connected flood, so a black subject touching the border is not eaten past
    // its own outline.
    push(x + 1, y)
    push(x - 1, y)
    push(x, y + 1)
    push(x, y - 1)
  }

  return out
}

/** Paint `subject` centred on a `width`×`height` canvas of `backgroundColor`. */
export function composeOnBackground(
  subject: RgbaImage,
  width: number,
  height: number,
  backgroundColor: string,
): RgbaImage {
  const out = new Uint8Array(width * height * 4)
  const [r, g, b] = [
    parseInt(backgroundColor.slice(1, 3), 16),
    parseInt(backgroundColor.slice(3, 5), 16),
    parseInt(backgroundColor.slice(5, 7), 16),
  ]
  for (let i = 0; i < out.length; i += 4) {
    out[i] = r
    out[i + 1] = g
    out[i + 2] = b
    out[i + 3] = 255
  }

  const x0 = Math.floor((width - subject.width) / 2)
  const y0 = Math.floor((height - subject.height) / 2)
  for (let y = 0; y < subject.height; y += 1) {
    for (let x = 0; x < subject.width; x += 1) {
      const si = (y * subject.width + x) * 4
      const alpha = subject.rgba[si + 3]! / 255
      if (alpha <= 0) continue
      const di = ((y + y0) * width + (x + x0)) * 4
      out[di] = Math.round(subject.rgba[si]! * alpha + out[di]! * (1 - alpha))
      out[di + 1] = Math.round(subject.rgba[si + 1]! * alpha + out[di + 1]! * (1 - alpha))
      out[di + 2] = Math.round(subject.rgba[si + 2]! * alpha + out[di + 2]! * (1 - alpha))
      out[di + 3] = 255
    }
  }
  return { width, height, rgba: out }
}

export interface StoreAssets {
  backgroundColor: string
  /** Project-relative path → PNG bytes. Written into the archive overlay only. */
  files: Record<string, Buffer>
}

/** The adaptive icon's subject is inset so circle and squircle masks keep it whole. */
export const ADAPTIVE_SUBJECT_RATIO = 0.62

/**
 * Generate the four images a store listing needs from one logo.
 *
 * Sizes are the stores': 1024 for iOS and the adaptive layer, 512 for the Play
 * listing icon, and 512 for the splash mark (which Expo scales up at runtime).
 */
export function generateStoreAssets(logo: RgbaImage): StoreAssets {
  const backgroundColor = sampleBackgroundColor(logo)

  const icon = resizeRgba(logo, 1024, 1024)
  const playIcon = resizeRgba(logo, 512, 512)

  const subject = Math.round(1024 * ADAPTIVE_SUBJECT_RATIO)
  const foreground = composeOnBackground(
    resizeRgba(flattenBackgroundSeams(logo, backgroundColor), subject, subject),
    1024,
    1024,
    backgroundColor,
  )

  const splash = resizeRgba(flattenBackgroundSeams(logo, backgroundColor), 512, 512)

  return {
    backgroundColor,
    files: {
      'assets/images/icon.png': encodePng(icon),
      'assets/images/adaptive-icon.png': encodePng(foreground),
      'assets/images/splash-icon.png': encodePng(splash),
      'assets/images/play-icon.png': encodePng(playIcon),
    },
  }
}
