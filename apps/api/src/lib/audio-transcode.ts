// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { spawn } from '@shogo/shared-runtime/child-process'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MAX_CONVERSATION_FILE_BYTES } from './conversation-files'

const MAX_CACHED_AUDIO_BYTES = 100 * 1024 * 1024
const CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CONCURRENT_CONVERSIONS = 2
const MAX_QUEUED_CONVERSIONS = 4

const cache = new Map<string, { bytes: Uint8Array; expiresAt: number }>()
const inFlight = new Map<string, Promise<Uint8Array>>()
let cachedBytes = 0
let activeConversions = 0
const conversionQueue: Array<() => void> = []

interface Mp4Box {
  type: string
  payloadStart: number
  end: number
}

function mp4Boxes(bytes: Uint8Array, start: number, end: number): Mp4Box[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const boxes: Mp4Box[] = []
  for (let offset = start; offset < end;) {
    if (offset + 8 > end) return null
    let size = view.getUint32(offset)
    let headerSize = 8
    if (size === 1) {
      if (offset + 16 > end) return null
      size = Number(view.getBigUint64(offset + 8))
      headerSize = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > end) return null
    boxes.push({
      type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)),
      payloadStart: offset + headerSize,
      end: offset + size,
    })
    offset += size
  }
  return boxes
}

function hasAacSampleEntry(bytes: Uint8Array, box: Mp4Box): boolean {
  // `stsd` is a FullBox followed by an entry count and fixed-size sample
  // entries. Only an `mp4a` sample entry proves that an MP4 is AAC audio;
  // searching arbitrary `moov` bytes can misidentify video metadata as AAC.
  if (box.payloadStart + 8 > box.end) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entryCount = view.getUint32(box.payloadStart + 4)
  let offset = box.payloadStart + 8
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 8 > box.end) return false
    const size = view.getUint32(offset)
    if (size < 8 || offset + size > box.end) return false
    if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === 'mp4a') return true
    offset += size
  }
  return false
}

function hasAacSampleEntryInContainer(bytes: Uint8Array, start: number, end: number): boolean {
  const boxes = mp4Boxes(bytes, start, end)
  if (!boxes) return false
  for (const box of boxes) {
    if (box.type === 'stsd' && hasAacSampleEntry(bytes, box)) return true
    if (box.type === 'trak' || box.type === 'mdia' || box.type === 'minf' || box.type === 'stbl') {
      if (hasAacSampleEntryInContainer(bytes, box.payloadStart, box.end)) return true
    }
  }
  return false
}

function isAacMp4(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16 || String.fromCharCode(...bytes.subarray(4, 8)) !== 'ftyp') return false

  // An MP4 container alone does not guarantee an iOS-compatible audio codec.
  // Read the `stsd` sample-description box under each track instead of looking
  // for an `mp4a` byte sequence anywhere in movie metadata.
  const boxes = mp4Boxes(bytes, 0, bytes.byteLength)
  const movie = boxes?.find((box) => box.type === 'moov')
  return !!movie && hasAacSampleEntryInContainer(bytes, movie.payloadStart, movie.end)
}

export class AudioTranscodeError extends Error {
  constructor(message: string, readonly code: 'unavailable' | 'failed' | 'too_large' | 'busy') {
    super(message)
    this.name = 'AudioTranscodeError'
  }
}

async function withConversionSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeConversions < MAX_CONCURRENT_CONVERSIONS) {
    activeConversions += 1
  } else {
    if (conversionQueue.length >= MAX_QUEUED_CONVERSIONS) {
      throw new AudioTranscodeError('Audio conversion is busy', 'busy')
    }
    await new Promise<void>((resolve) => conversionQueue.push(resolve))
  }

  try {
    return await work()
  } finally {
    const next = conversionQueue.shift()
    if (next) next()
    else activeConversions -= 1
  }
}

/** Cache converted voice notes so AVPlayer's range requests don't repeat the work. */
export async function getTranscodedAudio(
  cacheKey: string,
  loadSource: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const now = Date.now()
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key)
      cachedBytes -= entry.bytes.byteLength
    }
  }
  const cached = cache.get(cacheKey)
  if (cached) {
    cache.delete(cacheKey)
    cache.set(cacheKey, cached)
    return cached.bytes
  }

  const pending = inFlight.get(cacheKey)
  if (pending) return pending

  const conversion = withConversionSlot(async () => {
    const source = await loadSource()
    if (source.byteLength > MAX_CONVERSATION_FILE_BYTES) {
      throw new AudioTranscodeError('Audio file exceeds the conversion limit', 'too_large')
    }
    // Some browser recorders label MP4/AAC bytes as WebM. AVPlayer already
    // supports these bytes, so avoid a needless ffmpeg pass on iOS. Other
    // codecs inside MP4 still need conversion.
    return isAacMp4(source) ? source : transcodeAudioToM4a(source)
  })
  inFlight.set(cacheKey, conversion)
  try {
    const bytes = await conversion
    if (bytes.byteLength <= MAX_CACHED_AUDIO_BYTES) {
      while (cachedBytes + bytes.byteLength > MAX_CACHED_AUDIO_BYTES && cache.size > 0) {
        const oldestKey = cache.keys().next().value
        if (oldestKey === undefined) break
        const oldest = cache.get(oldestKey)
        cache.delete(oldestKey)
        if (oldest) cachedBytes -= oldest.bytes.byteLength
      }
      cache.set(cacheKey, { bytes, expiresAt: Date.now() + CACHE_TTL_MS })
      cachedBytes += bytes.byteLength
    }
    return bytes
  } finally {
    if (inFlight.get(cacheKey) === conversion) inFlight.delete(cacheKey)
  }
}

/** Convert an uploaded voice note to the AAC-in-MP4 format supported by AVPlayer. */
export async function transcodeAudioToM4a(source: Uint8Array): Promise<Uint8Array> {
  if (source.byteLength > MAX_CONVERSATION_FILE_BYTES) {
    throw new AudioTranscodeError('Audio file exceeds the conversion limit', 'too_large')
  }

  const dir = await mkdtemp(join(tmpdir(), 'shogo-audio-'))
  const outputPath = join(dir, 'playback.m4a')

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('ffmpeg', [
        '-v', 'error', '-y', '-protocol_whitelist', 'pipe,crypto,data', '-i', 'pipe:0',
        '-t', '3600', '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '96k', '-threads', '2',
        '-movflags', '+faststart', outputPath,
      ], { stdio: ['pipe', 'ignore', 'pipe'], timeout: 180_000 })
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-2000)
      })
      child.once('error', (error) => {
        reject(new AudioTranscodeError(
          error.message.includes('ENOENT') ? 'Audio conversion is unavailable' : 'Could not start audio conversion',
          error.message.includes('ENOENT') ? 'unavailable' : 'failed',
        ))
      })
      child.once('close', (code) => {
        if (code === 0) resolve()
        else reject(new AudioTranscodeError(`Audio conversion failed${stderr ? `: ${stderr.trim()}` : ''}`, 'failed'))
      })
      child.stdin?.on('error', () => {})
      child.stdin?.end(Buffer.from(source.buffer, source.byteOffset, source.byteLength))
    })

    return new Uint8Array(await readFile(outputPath))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
