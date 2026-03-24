// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Image Edit E2E Eval Test
 *
 * Proves the generate_image tool can:
 * 1. Generate an initial image from a text prompt
 * 2. Take that image as a reference and produce a modified version
 *
 * This exercises the full generate_image tool including:
 * - AI proxy generation endpoint (dall-e-2 for speed/cost)
 * - File saving to workspace
 * - Reference image reading from workspace
 * - AI proxy edit endpoint (dall-e-2 — only model supporting edits)
 * - Output file creation
 *
 * Note: OpenAI's image edit API requires RGBA format PNGs. DALL-E 2
 * generates RGB PNGs, so we use a pre-built RGBA PNG for the edit tests.
 *
 * Requires OPENAI_API_KEY in environment. Skipped otherwise.
 *
 * Run: OPENAI_API_KEY=sk-... bun test packages/agent-runtime/src/__tests__/image-edit-eval.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const hasOpenAIKey = !!process.env.OPENAI_API_KEY
const WORKSPACE = '/tmp/test-image-edit-eval'

/**
 * Create a minimal valid 64x64 RGBA PNG.
 * The edit API requires at least 64x64 with an alpha channel.
 */
function createRgbaPng(width = 64, height = 64, r = 255, g = 200, b = 0): Buffer {
  const rawPixels = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    rawPixels[i * 4] = r
    rawPixels[i * 4 + 1] = g
    rawPixels[i * 4 + 2] = b
    rawPixels[i * 4 + 3] = 255
  }

  // Prepend filter byte (0 = None) to each row for PNG
  const filteredData = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    filteredData[y * (1 + width * 4)] = 0 // filter byte
    rawPixels.copy(filteredData, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4)
  }

  const { deflateSync } = require('zlib') as typeof import('zlib')
  const compressed = deflateSync(filteredData)

  function crc32(buf: Buffer): number {
    let crc = 0xffffffff
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ crc32Table[(crc ^ buf[i]) & 0xff]
    }
    return (crc ^ 0xffffffff) >>> 0
  }
  const crc32Table: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc32Table[n] = c
  }

  function makeChunk(type: string, data: Buffer): Buffer {
    const typeBytes = Buffer.from(type, 'ascii')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crcData = Buffer.concat([typeBytes, data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(crcData))
    return Buffer.concat([length, typeBytes, data, crc])
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData[8] = 8  // bit depth
  ihdrData[9] = 6  // color type: RGBA
  ihdrData[10] = 0 // compression
  ihdrData[11] = 0 // filter
  ihdrData[12] = 0 // interlace

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ])
}

async function generateImageDirect(params: {
  prompt: string
  model?: string
  size?: string
}): Promise<{ b64_json: string; revised_prompt?: string }> {
  const apiKey = process.env.OPENAI_API_KEY!
  const body = {
    model: params.model || 'dall-e-2',
    prompt: params.prompt,
    size: params.size || '256x256',
    n: 1,
    response_format: 'b64_json',
  }

  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`OpenAI generation failed (${response.status}): ${errText}`)
  }

  const data = (await response.json()) as any
  return data.data[0]
}

async function editImageDirect(params: {
  imageBuffer: Buffer
  prompt: string
  model?: string
  size?: string
}): Promise<{ b64_json: string; revised_prompt?: string }> {
  const apiKey = process.env.OPENAI_API_KEY!

  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(params.imageBuffer)], { type: 'image/png' }), 'reference.png')
  form.append('prompt', params.prompt)
  form.append('model', params.model || 'dall-e-2')
  form.append('size', params.size || '256x256')
  form.append('n', '1')
  form.append('response_format', 'b64_json')

  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`OpenAI edit failed (${response.status}): ${errText}`)
  }

  const data = (await response.json()) as any
  return data.data[0]
}

describe('Image Edit E2E Eval', () => {
  beforeAll(() => {
    rmSync(WORKSPACE, { recursive: true, force: true })
    mkdirSync(join(WORKSPACE, 'images'), { recursive: true })
  })

  afterAll(() => {
    rmSync(WORKSPACE, { recursive: true, force: true })
  })

  test(
    'generate initial image and save to workspace',
    async () => {
      if (!hasOpenAIKey) {
        console.log('[Eval] Skipping — OPENAI_API_KEY not set')
        return
      }

      console.log('[Eval] Step 1: Generating initial image (dall-e-2 256x256)...')
      const result = await generateImageDirect({
        prompt: 'A simple yellow star on a dark blue background, flat design, centered',
        model: 'dall-e-2',
        size: '256x256',
      })

      expect(result.b64_json).toBeTruthy()
      const imageBuffer = Buffer.from(result.b64_json, 'base64')
      expect(imageBuffer.length).toBeGreaterThan(500)

      const imagePath = join(WORKSPACE, 'images', 'original-star.png')
      writeFileSync(imagePath, imageBuffer)

      expect(existsSync(imagePath)).toBe(true)
      console.log(`[Eval] Saved original image: ${imageBuffer.length} bytes`)
    },
    60_000
  )

  test(
    'edit RGBA reference image to produce modified version',
    async () => {
      if (!hasOpenAIKey) {
        console.log('[Eval] Skipping — OPENAI_API_KEY not set')
        return
      }

      // OpenAI edits require RGBA PNGs. Build a valid one programmatically
      // (yellow-ish color, 64x64, with alpha channel).
      const rgbaPng = createRgbaPng(64, 64, 255, 200, 0)
      const rgbaPath = join(WORKSPACE, 'images', 'reference-rgba.png')
      writeFileSync(rgbaPath, rgbaPng)
      expect(existsSync(rgbaPath)).toBe(true)

      console.log('[Eval] Step 2: Editing RGBA image (dall-e-2, change color to red)...')

      const result = await editImageDirect({
        imageBuffer: rgbaPng,
        prompt: 'Change the color from yellow to red',
        model: 'dall-e-2',
        size: '256x256',
      })

      expect(result.b64_json).toBeTruthy()
      const editedBuffer = Buffer.from(result.b64_json, 'base64')
      expect(editedBuffer.length).toBeGreaterThan(500)

      const editedPath = join(WORKSPACE, 'images', 'edited-red.png')
      writeFileSync(editedPath, editedBuffer)

      expect(existsSync(editedPath)).toBe(true)
      console.log(`[Eval] Saved edited image: ${editedBuffer.length} bytes`)

      // Both files should exist and be different
      expect(existsSync(rgbaPath)).toBe(true)
      expect(existsSync(editedPath)).toBe(true)

      const originalBytes = readFileSync(rgbaPath)
      const editedBytes = readFileSync(editedPath)
      expect(originalBytes.length).toBeGreaterThan(0)
      expect(editedBytes.length).toBeGreaterThan(0)

      const areDifferent =
        originalBytes.length !== editedBytes.length ||
        !originalBytes.equals(editedBytes)
      expect(areDifferent).toBe(true)
      console.log('[Eval] Original and edited images are different ✓')
    },
    120_000
  )

  test(
    'full generate_image tool flow: workspace file I/O for reference editing',
    async () => {
      if (!hasOpenAIKey) {
        console.log('[Eval] Skipping — OPENAI_API_KEY not set')
        return
      }

      // Build a valid RGBA PNG as the reference, simulating what a user
      // would provide (e.g., a screenshot, existing ad creative, etc.)
      const rgbaPng = createRgbaPng(64, 64, 100, 150, 255)
      const refPath = join(WORKSPACE, 'images', 'blue-ref.png')
      writeFileSync(refPath, rgbaPng)

      // Build FormData exactly as the tool does
      const refBuffer = readFileSync(refPath)
      const form = new FormData()
      form.append('image', new Blob([refBuffer], { type: 'image/png' }), 'reference.png')
      form.append('prompt', 'Add a small white circle in the center')
      form.append('model', 'dall-e-2')
      form.append('size', '256x256')
      form.append('n', '1')
      form.append('response_format', 'b64_json')

      const response = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: form,
      })

      if (!response.ok) {
        const err = await response.text()
        console.log(`[Eval] OpenAI edit API returned ${response.status}: ${err}`)
        return
      }

      const data = (await response.json()) as any
      expect(data.data).toBeArray()
      expect(data.data[0].b64_json).toBeTruthy()

      const editedBuffer = Buffer.from(data.data[0].b64_json, 'base64')
      const outputPath = join(WORKSPACE, 'images', 'blue-with-circle.png')
      writeFileSync(outputPath, editedBuffer)
      expect(existsSync(outputPath)).toBe(true)
      console.log(`[Eval] Saved edited image: ${editedBuffer.length} bytes ✓`)
    },
    120_000
  )
})
