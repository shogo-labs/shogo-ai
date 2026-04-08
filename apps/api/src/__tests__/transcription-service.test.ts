// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Transcription Service Tests
 *
 * Tests audio file validation and transcription handling, including edge cases
 * like empty recordings (WAV header only, no audio samples).
 *
 * Run: bun test apps/api/src/__tests__/transcription-service.test.ts
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

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
  buf.writeUInt32LE(16, 16)           // fmt chunk size
  buf.writeUInt16LE(1, 20)            // PCM
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * bytesPerSample, 28)
  buf.writeUInt16LE(bytesPerSample, 32)
  buf.writeUInt16LE(bitsPerSample, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)

  // Fill with silence (zeros — already zero-initialized)
  return buf
}

// ---------------------------------------------------------------------------
// Live recording test — spawns shogo-audio and records for a few seconds
// ---------------------------------------------------------------------------

import { spawn } from 'child_process'
import { resolve } from 'path'

function getHelperPath(): string | null {
  const root = resolve(__dirname, '..', '..', '..', '..')
  const release = join(root, 'apps', 'desktop', 'native', 'shogo-audio', '.build', 'release', 'shogo-audio')
  if (existsSync(release)) return release
  const debug = join(root, 'apps', 'desktop', 'native', 'shogo-audio', '.build', 'debug', 'shogo-audio')
  if (existsSync(debug)) return debug
  return null
}

function recordForSeconds(helperPath: string, outputPath: string, seconds: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    const events: string[] = []

    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().trim().split('\n')) {
        events.push(line)
        try {
          const evt = JSON.parse(line)
          if (evt.type === 'ready') {
            proc.stdin?.write(`record ${outputPath}\n`)
          }
          if (evt.type === 'recording_started') {
            setTimeout(() => {
              proc.stdin?.write('stop\n')
              setTimeout(() => proc.stdin?.write('quit\n'), 500)
            }, seconds * 1000)
          }
        } catch {}
      }
    })

    proc.stderr?.on('data', (data: Buffer) => events.push(`stderr: ${data.toString().trim()}`))
    proc.on('error', reject)
    proc.on('exit', () => resolve(events))

    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGTERM')
      reject(new Error('Recording timed out'))
    }, (seconds + 10) * 1000)
  })
}

describe('shogo-audio live recording', () => {
  const helperPath = getHelperPath()
  let testWav: string
  let events: string[]
  let wavInfo: WavInfo

  beforeAll(async () => {
    if (!helperPath) return

    const tmpDir = mkdtempSync(join(tmpdir(), 'shogo-audio-test-'))
    testWav = join(tmpDir, 'test-recording.wav')

    events = await recordForSeconds(helperPath, testWav, 3)
    const buf = readFileSync(testWav)
    wavInfo = parseWavHeader(buf)
  }, 30_000)

  test('shogo-audio binary exists', () => {
    expect(helperPath).not.toBeNull()
  })

  test('helper emits ready, recording_started, wav_finalized, recording_stopped', () => {
    if (!helperPath) return
    const types = events.flatMap(e => { try { return [JSON.parse(e).type] } catch { return [] } })
    expect(types).toContain('ready')
    expect(types).toContain('recording_started')
    expect(types).toContain('wav_finalized')
    expect(types).toContain('recording_stopped')
  })

  test('output is a valid WAV with audio data', () => {
    if (!helperPath) return
    expect(existsSync(testWav)).toBe(true)
    expect(wavInfo.valid).toBe(true)
    expect(wavInfo.sampleRate).toBe(48000)
    expect(wavInfo.channels).toBe(1)
    expect(wavInfo.bitsPerSample).toBe(16)
    expect(wavInfo.dataSize).toBeGreaterThan(0)
  })

  test('WAV duration is at least 2 seconds', () => {
    if (!helperPath) return
    expect(wavInfo.durationSeconds).toBeGreaterThanOrEqual(2)
  })

  test('wav_finalized event reports matching stats', () => {
    if (!helperPath) return
    const finalizeEvt = events
      .map(e => { try { return JSON.parse(e) } catch { return null } })
      .find(e => e?.type === 'wav_finalized')

    expect(finalizeEvt).toBeDefined()
    expect(finalizeEvt.data.dataBytes).toBeGreaterThan(0)
    expect(finalizeEvt.data.writeCount).toBeGreaterThan(0)
    expect(finalizeEvt.data.durationSeconds).toBeGreaterThanOrEqual(2)
  })
})

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
    expect(info.dataSize).toBe(44100 * 2 * 2) // 2 bytes per sample × 2 seconds
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
// Transcription service — minimum audio guard
// ---------------------------------------------------------------------------

describe('transcription service', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'transcription-test-'))
  })

  test('transcribeCloud rejects audio shorter than 0.1s', async () => {
    // OpenAI returns 400 for audio < 0.1s.  The service should propagate
    // or (ideally) pre-validate.  For now we assert the error message.
    const { transcribeCloud } = await import('../services/transcription.service')

    const emptyWav = createWavBuffer(0)
    const filePath = join(tmpDir, 'empty.wav')
    writeFileSync(filePath, emptyWav)

    // Should throw — either our pre-check or OpenAI's 400
    await expect(transcribeCloud(filePath)).rejects.toThrow()
  })

  test('transcribeLocal fails gracefully for empty audio', async () => {
    const { transcribeLocal, isLocalTranscriptionAvailable } = await import(
      '../services/transcription.service'
    )

    if (!isLocalTranscriptionAvailable()) {
      console.log('  [skipped] whisper-cli not installed')
      return
    }

    const emptyWav = createWavBuffer(0)
    const filePath = join(tmpDir, 'empty-local.wav')
    writeFileSync(filePath, emptyWav)

    await expect(transcribeLocal(filePath)).rejects.toThrow()
  })

  test('transcribe returns empty text for very short audio when local is available', async () => {
    const { transcribe, isLocalTranscriptionAvailable } = await import(
      '../services/transcription.service'
    )

    if (!isLocalTranscriptionAvailable()) {
      console.log('  [skipped] whisper-cli not installed')
      return
    }

    // 50ms of silence — whisper-cli handles this gracefully (returns empty/silence)
    const shortWav = createWavBuffer(0.05)
    const filePath = join(tmpDir, 'short.wav')
    writeFileSync(filePath, shortWav)

    const result = await transcribe(filePath)
    expect(result).toBeDefined()
    expect(typeof result.text).toBe('string')
  })
})
