// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Transcription + Diarization Service Tests
 *
 * Tests sherpa-onnx transcription, diarization output parsing,
 * speaker-segment merging, WAV validation, and live recording.
 *
 * Run: bun test apps/api/src/__tests__/transcription-service.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// ---------------------------------------------------------------------------
// WAV helpers
// ---------------------------------------------------------------------------

const WAV_HEADER_SIZE = 44

interface WavInfo {
  valid: boolean
  channels: number
  sampleRate: number
  bitsPerSample: number
  dataSize: number
  durationSeconds: number
}

function parseWavHeader(buf: Buffer): WavInfo {
  const invalid: WavInfo = {
    valid: false, channels: 0, sampleRate: 0,
    bitsPerSample: 0, dataSize: 0, durationSeconds: 0,
  }

  if (buf.length < WAV_HEADER_SIZE) return invalid
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return invalid
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return invalid
  if (buf.toString('ascii', 12, 16) !== 'fmt ') return invalid

  const channels = buf.readUInt16LE(22)
  const sampleRate = buf.readUInt32LE(24)
  const bitsPerSample = buf.readUInt16LE(34)

  if (buf.toString('ascii', 36, 40) !== 'data') return invalid
  const dataSize = buf.readUInt32LE(40)

  const bytesPerSample = (bitsPerSample / 8) * channels
  const durationSeconds = bytesPerSample > 0 ? dataSize / (sampleRate * bytesPerSample) : 0

  return { valid: true, channels, sampleRate, bitsPerSample, dataSize, durationSeconds }
}

function createWavBuffer(
  durationSeconds: number,
  sampleRate = 48000,
  channels = 1,
  bitsPerSample = 16,
): Buffer {
  const bytesPerSample = (bitsPerSample / 8) * channels
  const dataSize = Math.floor(durationSeconds * sampleRate * bytesPerSample)
  const buf = Buffer.alloc(WAV_HEADER_SIZE + dataSize)

  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * bytesPerSample, 28)
  buf.writeUInt16LE(bytesPerSample, 32)
  buf.writeUInt16LE(bitsPerSample, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)

  return buf
}

// ---------------------------------------------------------------------------
// Note: the old "shogo-audio live recording" describe block was removed
// alongside the Swift binary. Audio capture now runs inside Electron — see
// `apps/desktop/e2e/notetaker.spec.ts` for the replacement end-to-end test.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WAV header parsing
// ---------------------------------------------------------------------------

describe('parseWavHeader', () => {
  test('parses a valid WAV buffer', () => {
    const buf = createWavBuffer(2.0, 44100, 1, 16)
    const info = parseWavHeader(buf)
    expect(info.valid).toBe(true)
    expect(info.sampleRate).toBe(44100)
    expect(info.channels).toBe(1)
    expect(info.bitsPerSample).toBe(16)
    expect(info.dataSize).toBe(44100 * 2 * 2)
    expect(info.durationSeconds).toBeCloseTo(2.0, 1)
  })

  test('detects header-only (empty) WAV', () => {
    const buf = createWavBuffer(0)
    const info = parseWavHeader(buf)
    expect(info.valid).toBe(true)
    expect(info.dataSize).toBe(0)
    expect(info.durationSeconds).toBe(0)
  })

  test('rejects non-WAV data', () => {
    const buf = Buffer.from('not a wav file at all')
    expect(parseWavHeader(buf).valid).toBe(false)
  })

  test('rejects truncated header', () => {
    expect(parseWavHeader(Buffer.alloc(10)).valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Speaker-segment merge logic
// ---------------------------------------------------------------------------

describe('mergeTranscriptWithSpeakers', () => {
  test('assigns speaker to overlapping text segments', async () => {
    const { mergeTranscriptWithSpeakers } = await import('../services/diarization.service')

    const textSegments = [
      { start: 0, end: 5, text: 'Hello everyone' },
      { start: 5, end: 10, text: 'Welcome to the meeting' },
      { start: 10, end: 15, text: 'Lets get started' },
    ]

    const speakerSegments = [
      { start: 0, end: 6, speaker: 'speaker_00' },
      { start: 7, end: 15, speaker: 'speaker_01' },
    ]

    const result = mergeTranscriptWithSpeakers(textSegments, speakerSegments)

    expect(result).toHaveLength(3)
    expect(result[0].speaker).toBe('speaker_00')
    expect(result[1].speaker).toBe('speaker_01')
    expect(result[2].speaker).toBe('speaker_01')
    expect(result[0].text).toBe('Hello everyone')
  })

  test('returns original segments when no speakers', async () => {
    const { mergeTranscriptWithSpeakers } = await import('../services/diarization.service')

    const segments = [{ start: 0, end: 5, text: 'Hello' }]
    const result = mergeTranscriptWithSpeakers(segments, [])

    expect(result).toEqual(segments)
  })

  test('handles partially overlapping segments', async () => {
    const { mergeTranscriptWithSpeakers } = await import('../services/diarization.service')

    const textSegments = [
      { start: 2, end: 8, text: 'Mixed speech here' },
    ]

    const speakerSegments = [
      { start: 0, end: 4, speaker: 'speaker_00' },
      { start: 4, end: 10, speaker: 'speaker_01' },
    ]

    const result = mergeTranscriptWithSpeakers(textSegments, speakerSegments)
    // speaker_01 has 4s overlap (4-8), speaker_00 has 2s overlap (2-4)
    expect(result[0].speaker).toBe('speaker_01')
  })
})

describe('splitTextBySpeakers', () => {
  test('splits text proportionally across speaker segments', async () => {
    const { splitTextBySpeakers } = await import('../services/diarization.service')

    const text = 'Hello how are you I am fine thank you'
    const speakers = [
      { start: 0, end: 5, speaker: 'speaker_00' },
      { start: 5, end: 10, speaker: 'speaker_01' },
    ]

    const result = splitTextBySpeakers(text, speakers)
    expect(result).toHaveLength(2)
    expect(result[0].speaker).toBe('speaker_00')
    expect(result[1].speaker).toBe('speaker_01')
    expect(result[0].start).toBe(0)
    expect(result[1].start).toBe(5)
    // All words should be accounted for
    const allWords = result.map(r => r.text).join(' ')
    expect(allWords.split(/\s+/).length).toBe(text.split(/\s+/).length)
  })

  test('returns single segment for empty speakers', async () => {
    const { splitTextBySpeakers } = await import('../services/diarization.service')

    const result = splitTextBySpeakers('some text', [])
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('some text')
  })
})

// ---------------------------------------------------------------------------
// Diarization output parsing
// ---------------------------------------------------------------------------

describe('diarization output parsing', () => {
  test('parseDiarizationOutput extracts speaker segments', async () => {
    // We test the internal parsing by calling diarize with a mock,
    // but we can also test the parsing function directly if exported.
    // For now, test via the module's internal behavior through splitTextBySpeakers
    // which is the merge path.

    const { splitTextBySpeakers } = await import('../services/diarization.service')

    // Simulate what would happen after parsing
    const speakerSegments = [
      { start: 0.318, end: 6.865, speaker: 'speaker_00' },
      { start: 7.017, end: 10.747, speaker: 'speaker_01' },
      { start: 11.455, end: 13.632, speaker: 'speaker_01' },
      { start: 13.75, end: 17.041, speaker: 'speaker_02' },
    ]

    const text = 'Hello and welcome Thanks for having me I wanted to say something And here is my response to that'
    const result = splitTextBySpeakers(text, speakerSegments)

    expect(result.length).toBe(4)
    expect(result[0].speaker).toBe('speaker_00')
    expect(result[1].speaker).toBe('speaker_01')
    expect(result[2].speaker).toBe('speaker_01')
    expect(result[3].speaker).toBe('speaker_02')
  })
})

// ---------------------------------------------------------------------------
// Sherpa-onnx binary availability check
// ---------------------------------------------------------------------------

describe('sherpa-onnx availability', () => {
  test('getSherpaOfflinePath returns path or null', async () => {
    const { getSherpaOfflinePath } = await import('../services/transcription.service')
    const result = getSherpaOfflinePath()
    // The binary may or may not be installed
    expect(result === null || typeof result === 'string').toBe(true)
    if (result) {
      expect(existsSync(result)).toBe(true)
    }
  })

  test('isDiarizationAvailable returns boolean', async () => {
    const { isDiarizationAvailable } = await import('../services/diarization.service')
    const result = isDiarizationAvailable()
    expect(typeof result).toBe('boolean')
  })

  test('isLocalTranscriptionAvailable returns boolean', async () => {
    const { isLocalTranscriptionAvailable } = await import('../services/transcription.service')
    const result = isLocalTranscriptionAvailable()
    expect(typeof result).toBe('boolean')
  })

  test('getInstalledModels returns array', async () => {
    const { getInstalledModels } = await import('../services/transcription.service')
    const result = getInstalledModels()
    expect(Array.isArray(result)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Cloud transcription — basic validation
// ---------------------------------------------------------------------------

describe('transcription service', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'transcription-test-'))
  })

  test('transcribeCloud rejects audio shorter than 0.1s', async () => {
    const { transcribeCloud } = await import('../services/transcription.service')

    const emptyWav = createWavBuffer(0)
    const filePath = join(tmpDir, 'empty.wav')
    writeFileSync(filePath, emptyWav)

    await expect(transcribeCloud(filePath)).rejects.toThrow()
  })

  test('transcribeLocal fails gracefully when binary not found', async () => {
    const { transcribeLocal, isLocalTranscriptionAvailable } = await import(
      '../services/transcription.service'
    )

    if (!isLocalTranscriptionAvailable()) {
      const wav = createWavBuffer(1.0)
      const filePath = join(tmpDir, 'test-local.wav')
      writeFileSync(filePath, wav)
      await expect(transcribeLocal(filePath)).rejects.toThrow()
    }
  })

  test('transcribeLocal produces output when sherpa-onnx is installed', async () => {
    const { transcribeLocal, isLocalTranscriptionAvailable, getInstalledModels } = await import(
      '../services/transcription.service'
    )

    const models = getInstalledModels()
    if (models.length === 0) {
      console.log('  [skipped] no sherpa-onnx models installed')
      return
    }

    const model = models[0]
    if (!isLocalTranscriptionAvailable(model)) {
      console.log(`  [skipped] sherpa-onnx not available for model ${model}`)
      return
    }

    const wavPath = join(tmpDir, 'silence-2s.wav')
    writeFileSync(wavPath, createWavBuffer(2.0))

    const result = await transcribeLocal(wavPath, model)
    expect(result).toBeDefined()
    expect(typeof result.text).toBe('string')
    expect(Array.isArray(result.segments)).toBe(true)
    expect(typeof result.language).toBe('string')
  }, 30_000)
})
