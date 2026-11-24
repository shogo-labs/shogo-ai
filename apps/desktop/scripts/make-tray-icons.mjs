// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Generates the menu-bar tray artwork in resources/tray/ from the same mark
// geometry as resources/icon-source.svg: an orange rounded square with a white
// spark. Nothing here needs a rasteriser dependency, so the PNGs can be
// regenerated on any machine:
//
//   node apps/desktop/scripts/make-tray-icons.mjs
//
// What it writes:
//   trayTemplate.png / trayTemplate@2x.png  black spark, transparent — macOS
//       tints it for light and dark menu bars, so it must stay a template.
//   trayRecording.png / trayRecording@2x.png  a red dot: not a template, so it
//       keeps its colour in both menu-bar appearances.
//   tray.png  the brand mark for Windows and Linux, which have no template
//       images and no tinting.
//   trayDot{New,Running,NeedsYou}.png  the row dots (blue/orange/red), drawn at
//       2x because a menu icon has no @2x suffix of its own.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'tray')

const BRAND_ORANGE = [0xfb, 0x8c, 0x00]
const WHITE = [0xff, 0xff, 0xff]
const BLACK = [0x00, 0x00, 0x00]
const DOT_BLUE = [0x0a, 0x84, 0xff]
const DOT_ORANGE = [0xff, 0x8c, 0x00]
const DOT_RED = [0xff, 0x3b, 0x30]
const RECORDING_RED = [0xff, 0x3b, 0x30]

/** Super-sampling factor: 8x8 samples per pixel is plenty for a 16px icon. */
const SS = 8

// ─── PNG encoding ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** Encodes RGBA pixels (row-major, top-left origin) as a PNG buffer. */
function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ─── shapes ──────────────────────────────────────────────────────────────────

/** A 4-point spark, the shape the mark's rays make. Unit box, centre 0.5. */
const SPARK = [
  [0.5, 0.0],
  [0.565, 0.435],
  [1.0, 0.5],
  [0.565, 0.565],
  [0.5, 1.0],
  [0.435, 0.565],
  [0.0, 0.5],
  [0.435, 0.435],
]

function insidePolygon(points, x, y) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function insideCircle(cx, cy, r, x, y) {
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

function insideRoundedSquare(x, y, radius) {
  const inset = 0.02
  if (x < inset || x > 1 - inset || y < inset || y > 1 - inset) return false
  const r = radius
  const cx = Math.min(Math.max(x, inset + r), 1 - inset - r)
  const cy = Math.min(Math.max(y, inset + r), 1 - inset - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

/**
 * Draws one icon. `layers` are painted in order; the first opaque one wins at
 * each sub-sample, which is all these flat shapes need.
 */
function render(size, layers) {
  const rgba = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size
          const y = (py + (sy + 0.5) / SS) / size
          const colour = layers.reduce((found, layer) => found ?? (layer.test(x, y) ? layer.colour : null), null)
          if (!colour) continue
          r += colour[0]
          g += colour[1]
          b += colour[2]
          a += 255
        }
      }
      const samples = SS * SS
      const covered = a / 255
      const offset = (py * size + px) * 4
      if (covered === 0) continue
      // Average only over covered samples, so edges don't darken toward black.
      rgba[offset] = Math.round(r / covered)
      rgba[offset + 1] = Math.round(g / covered)
      rgba[offset + 2] = Math.round(b / covered)
      rgba[offset + 3] = Math.round(a / samples)
    }
  }
  return rgba
}

const sparkLayer = (colour, scale = 0.92) => ({
  colour,
  test: (x, y) => insidePolygon(SPARK, (x - (1 - scale) / 2) / scale, (y - (1 - scale) / 2) / scale),
})
const dotLayer = (colour, cx, cy, r) => ({ colour, test: (x, y) => insideCircle(cx, cy, r, x, y) })
const roundedSquareLayer = (colour, radius) => ({ colour, test: (x, y) => insideRoundedSquare(x, y, radius) })

const icons = {
  // macOS menu bar: monochrome spark, tinted by the system.
  'trayTemplate.png': () => render(16, [sparkLayer(BLACK)]),
  'trayTemplate@2x.png': () => render(32, [sparkLayer(BLACK)]),
  // Recording keeps its colour, so it is not a template image.
  'trayRecording.png': () => render(16, [dotLayer(RECORDING_RED, 0.5, 0.5, 0.36)]),
  'trayRecording@2x.png': () => render(32, [dotLayer(RECORDING_RED, 0.5, 0.5, 0.36)]),
  // Windows / Linux: the brand mark, no tinting.
  'tray.png': () => render(32, [roundedSquareLayer(BRAND_ORANGE, 0.18), sparkLayer(WHITE, 0.62)]),
  // Menu-row dots, drawn at 2x for Retina.
  'trayDotNew.png': () => render(32, [dotLayer(DOT_BLUE, 0.5, 0.5, 0.44)]),
  'trayDotRunning.png': () => render(32, [dotLayer(DOT_ORANGE, 0.5, 0.5, 0.44)]),
  'trayDotNeedsYou.png': () => render(32, [dotLayer(DOT_RED, 0.5, 0.5, 0.44)]),
}

fs.mkdirSync(OUT_DIR, { recursive: true })
for (const [name, draw] of Object.entries(icons)) {
  const size = Number(name.includes('@2x') || name.startsWith('trayDot') || name === 'tray.png' ? 32 : 16)
  fs.writeFileSync(path.join(OUT_DIR, name), encodePng(size, size, draw()))
  console.log(`wrote ${name} (${size}x${size})`)
}
