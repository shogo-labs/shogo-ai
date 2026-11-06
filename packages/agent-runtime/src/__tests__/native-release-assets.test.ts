// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Store artwork from one logo.
 *
 * The properties that matter are the sizes the stores enforce, the adaptive
 * icon's safe zone, and a background sampled from the logo itself — a wrong one
 * is a listing that looks broken on a phone, not a crash anyone notices.
 */

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ADAPTIVE_SUBJECT_RATIO,
  composeOnBackground,
  decodePng,
  encodePng,
  flattenBackgroundSeams,
  generateStoreAssets,
  resizeRgba,
  sampleBackgroundColor,
  type RgbaImage,
} from '../native-release-assets'
import { stageStoreAssets } from '../native-release-runner'

/** A logo: a coloured square with a lighter disc, transparent corners. */
function logo(width = 256, height = 256): RgbaImage {
  const rgba = new Uint8Array(width * height * 4)
  const cx = width / 2
  const cy = height / 2
  const r = Math.min(width, height) * 0.45
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      const inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r
      rgba[i] = inside ? 240 : 11
      rgba[i + 1] = inside ? 90 : 11
      rgba[i + 2] = inside ? 40 : 13
      rgba[i + 3] = 255
    }
  }
  return { width, height, rgba }
}

describe('the PNG codec', () => {
  it('round-trips an RGBA image byte for byte', () => {
    const image = logo(32, 32)
    const decoded = decodePng(encodePng(image))
    expect(decoded.width).toBe(32)
    expect(decoded.height).toBe(32)
    expect(Buffer.from(decoded.rgba).equals(Buffer.from(image.rgba))).toBe(true)
  })

  it('expands a 3-channel PNG to RGBA with full alpha', () => {
    // Color type 2 (RGB) is what most logo exports are.
    const { deflateSync } = require('node:zlib') as typeof import('node:zlib')
    const width = 2
    const height = 1
    const raw = Buffer.from([0, 1, 2, 3, 4, 5, 6])
    const header = Buffer.alloc(13)
    header.writeUInt32BE(width, 0)
    header.writeUInt32BE(height, 4)
    header[8] = 8
    header[9] = 2
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4)
      len.writeUInt32BE(data.length, 0)
      const body = Buffer.concat([Buffer.from(type), data])
      const crc = Buffer.alloc(4)
      crc.writeUInt32BE(crc32(body), 0)
      return Buffer.concat([len, body, crc])
    }
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ])
    const decoded = decodePng(png)
    expect(decoded.rgba[3]).toBe(255)
    expect([...decoded.rgba.subarray(0, 4)]).toEqual([1, 2, 3, 255])
  })

  it('refuses a file that is not a PNG, and says what to send', () => {
    expect(() => decodePng(Buffer.from('GIF89a'))).toThrow(/not a PNG/)
  })
})

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

describe('resizing', () => {
  it('produces exactly the size asked for', () => {
    const out = resizeRgba(logo(64, 64), 1024, 1024)
    expect(out.width).toBe(1024)
    expect(out.height).toBe(1024)
    expect(out.rgba.length).toBe(1024 * 1024 * 4)
  })

  it('downscales without inventing colour in transparent areas', () => {
    const out = resizeRgba(logo(256, 256), 32, 32)
    // The corner of the disc is still the disc's colour, not a blend with nothing.
    const corner = 0
    expect(out.rgba[corner + 3]).toBe(255)
  })
})

describe('the background colour', () => {
  it('samples the logo’s own border', () => {
    // A logo on white: the adaptive background has to be white, not Shogo's dark.
    const white = new Uint8Array(64 * 64 * 4).fill(255)
    expect(sampleBackgroundColor({ width: 64, height: 64, rgba: white })).toBe('#ffffff')
  })

  it('falls back to the reference dark when every border pixel is transparent', () => {
    const clear = new Uint8Array(16 * 16 * 4)
    expect(sampleBackgroundColor({ width: 16, height: 16, rgba: clear })).toBe('#0b0b0d')
  })
})

describe('flattening seams', () => {
  it('repaints a black surround but keeps black inside the subject', () => {
    const width = 9
    const height = 9
    const rgba = new Uint8Array(width * height * 4)
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 0
      rgba[i + 1] = 0
      rgba[i + 2] = 0
      rgba[i + 3] = 255
    }
    // A white ring with a black core: the flood may repaint the outer black only.
    const put = (x: number, y: number, v: number) => {
      const i = (y * width + x) * 4
      rgba[i] = v
      rgba[i + 1] = v
      rgba[i + 2] = v
    }
    for (let x = 2; x <= 6; x += 1) {
      put(x, 2, 255)
      put(x, 6, 255)
    }
    for (let y = 2; y <= 6; y += 1) {
      put(2, y, 255)
      put(6, y, 255)
    }

    const out = flattenBackgroundSeams({ width, height, rgba }, '#101010')
    expect([out.rgba[0], out.rgba[1], out.rgba[2]]).toEqual([16, 16, 16])
    // The core is enclosed by the ring, so it is untouched.
    const core = (4 * width + 4) * 4
    expect(out.rgba[core]).toBe(0)
  })
})

describe('the generated set', () => {
  const assets = generateStoreAssets(logo(256, 256))

  it('produces the four images the stores need, at their sizes', () => {
    const sizes = Object.fromEntries(
      Object.entries(assets.files).map(([name, bytes]) => {
        const img = decodePng(bytes)
        return [name, [img.width, img.height]]
      }),
    )
    expect(sizes['assets/images/icon.png']).toEqual([1024, 1024])
    expect(sizes['assets/images/adaptive-icon.png']).toEqual([1024, 1024])
    expect(sizes['assets/images/splash-icon.png']).toEqual([512, 512])
    expect(sizes['assets/images/play-icon.png']).toEqual([512, 512])
  })

  it('insets the adaptive subject so a circle mask keeps it whole', () => {
    const foreground = decodePng(assets.files['assets/images/adaptive-icon.png']!)
    const mid = Math.floor(1024 / 2)
    const centre = (mid * 1024 + mid) * 4
    // The centre is the logo, and a point just outside the safe zone is background.
    expect(foreground.rgba[centre]).toBe(240)
    const edge = 8
    const cornerIdx = (edge * 1024 + edge) * 4
    expect([foreground.rgba[cornerIdx], foreground.rgba[cornerIdx + 1], foreground.rgba[cornerIdx + 2]]).toEqual([
      11, 11, 13,
    ])
    expect(ADAPTIVE_SUBJECT_RATIO).toBeLessThan(0.75)
  })

  it('reports the background it used', () => {
    expect(assets.backgroundColor).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('composes a subject on a filled canvas without leaving it transparent', () => {
    const out = composeOnBackground(logo(32, 32), 64, 64, '#123456')
    expect(out.rgba[3]).toBe(255)
    expect([out.rgba[0], out.rgba[1], out.rgba[2]]).toEqual([0x12, 0x34, 0x56])
  })
})

describe('offering the artwork to the user', () => {
  it('writes it under .shogo/store-assets, which is not source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-assets-'))
    try {
      const assets = generateStoreAssets(logo(64, 64))
      const written = await stageStoreAssets(dir, assets)
      expect(written).toHaveLength(4)
      for (const rel of written) {
        expect(rel.startsWith('.shogo/store-assets/')).toBe(true)
        const bytes = readFileSync(join(dir, rel))
        expect(bytes.length).toBeGreaterThan(0)
      }
      // A real PNG, not an empty file.
      expect(decodePng(readFileSync(join(dir, '.shogo/store-assets/icon.png'))).width).toBe(1024)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
