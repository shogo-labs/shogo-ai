// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The #2268 clip, built without ffmpeg's `drawtext`.
 *
 * The issue's reproduction used `drawtext` to stamp a label on every frame,
 * but Homebrew's `ffmpeg` (and many CI images) are built without libfreetype,
 * so `drawtext` is missing and a test that depends on it skips forever — even
 * with the provider keys present. The labels are drawn here instead: a 5x7
 * digit font rasterised into grayscale PNGs and piped to ffmpeg, which needs
 * no font support at all.
 *
 * 10 s / 10 fps / 100 frames, one label per frame: F000 … F099.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const FONT: Record<string, readonly string[]> = {
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  '0': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
}

const WIDTH = 320
const HEIGHT = 240
const SCALE = 9

function crc32(buffer: Buffer): number {
  let crc = ~0
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function grayscalePng(width: number, height: number, pixels: Buffer): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 0 // colour type: grayscale
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0 // per-row filter: none
    pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** One 320x240 frame with `label` (e.g. `F073`) in white on black. */
export function stampedFramePng(label: string): Buffer {
  const pixels = Buffer.alloc(WIDTH * HEIGHT, 0)
  const glyphWidth = 5 * SCALE
  const gap = 2 * SCALE
  const totalWidth = label.length * glyphWidth + (label.length - 1) * gap
  let x = Math.round((WIDTH - totalWidth) / 2)
  const y = Math.round((HEIGHT - 7 * SCALE) / 2)
  for (const character of label) {
    const glyph = FONT[character]
    if (!glyph) throw new Error(`stamped-clip: no glyph for "${character}"`)
    for (let row = 0; row < 7; row++) {
      for (let column = 0; column < 5; column++) {
        if (glyph[row]![column] !== '1') continue
        for (let dy = 0; dy < SCALE; dy++) {
          for (let dx = 0; dx < SCALE; dx++) {
            pixels[(y + row * SCALE + dy) * WIDTH + (x + column * SCALE + dx)] = 255
          }
        }
      }
    }
    x += glyphWidth + gap
  }
  return grayscalePng(WIDTH, HEIGHT, pixels)
}

export const STAMPED_CLIP_FRAMES = 100
export const STAMPED_CLIP_FPS = 10

/**
 * Write `frames` labelled frames as an H.264 clip at `fps`, and return its
 * bytes. Throws with ffmpeg's own stderr when the encode fails, so a broken
 * fixture is loud rather than a silent skip.
 */
export function buildStampedClip(ffmpeg: string, outputPath: string, workDir: string): Buffer {
  const framesDir = join(workDir, 'stamped-frames')
  rmSync(framesDir, { recursive: true, force: true })
  mkdirSync(framesDir, { recursive: true })
  try {
    for (let index = 0; index < STAMPED_CLIP_FRAMES; index++) {
      const label = `F${String(index).padStart(3, '0')}`
      writeFileSync(join(framesDir, `f${String(index).padStart(3, '0')}.png`), stampedFramePng(label))
    }
    const result = spawnSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-framerate', String(STAMPED_CLIP_FPS),
      '-i', join(framesDir, 'f%03d.png'),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
      '-pix_fmt', 'yuv420p',
      outputPath,
    ], { encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`stamped-clip: ffmpeg exited ${result.status}: ${result.stderr ?? ''}`)
    }
    return readFileSync(outputPath)
  } finally {
    rmSync(framesDir, { recursive: true, force: true })
  }
}
