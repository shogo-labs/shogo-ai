// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Whisper only decodes ~30 s per call, so long recordings are cut into
 * windows. A 50-minute call once came back as the single word "you" because
 * the whole file was handed over in one piece.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── child_process spawn mock ────────────────────────────────────────────────

class FakeProc extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
}

const spawnCalls: Array<{ cmd: string; args: string[] }> = []
let sherpaStdout: (files: string[]) => string = () => ''

mock.module('child_process', () => ({
  spawn: (cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args })
    const p = new FakeProc()
    queueMicrotask(() => {
      const files = args.filter((a) => a.endsWith('.wav'))
      p.stdout.emit('data', Buffer.from(sherpaStdout(files)))
      p.emit('exit', 0)
    })
    return p
  },
  execSync: () => '',
}))

// ─── fixtures ────────────────────────────────────────────────────────────────

const RATE = 16_000
const BIN_NAME = `sherpa-onnx-offline${process.platform === 'win32' ? '.exe' : ''}`
let tmpRoot: string
let sherpaDir: string
const SAVED_ENV = { ...process.env }

/** 16 kHz mono PCM WAV. `level(i)` gives the sample at index i. */
function writeWav(path: string, seconds: number, level: (i: number) => number, opts: { sampleRate?: number } = {}) {
  const rate = opts.sampleRate ?? RATE
  const n = Math.round(seconds * rate)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(level(i)))), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([h, data]))
}

const tone = (amp: number) => (i: number) => amp * Math.sin((2 * Math.PI * 220 * i) / RATE)

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'windowing-test-'))
})
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

beforeEach(() => {
  spawnCalls.length = 0
  sherpaStdout = () => ''
  sherpaDir = mkdtempSync(join(tmpRoot, 'sherpa-'))
  mkdirSync(join(sherpaDir, 'bin'), { recursive: true })
  writeFileSync(join(sherpaDir, 'bin', BIN_NAME), '')
  const modelDir = join(sherpaDir, 'models', 'whisper-base.en')
  mkdirSync(modelDir, { recursive: true })
  for (const f of ['base.en-encoder.onnx', 'base.en-decoder.onnx', 'base.en-tokens.txt']) writeFileSync(join(modelDir, f), '')
  process.env.SHOGO_SHERPA_DIR = sherpaDir
})

afterEach(() => {
  rmSync(sherpaDir, { recursive: true, force: true })
  for (const k of Object.keys(process.env)) if (!(k in SAVED_ENV)) delete process.env[k]
  for (const k of Object.keys(SAVED_ENV)) process.env[k] = SAVED_ENV[k]
})

const svc = await import('../transcription.service')

// ─── WAV header ──────────────────────────────────────────────────────────────

describe('parseWavHeader', () => {
  it('reads format and duration', () => {
    const path = join(tmpRoot, 'h.wav')
    writeWav(path, 2, tone(1000))
    const buf = Buffer.from(require('node:fs').readFileSync(path))
    const info = svc.parseWavHeader(buf.subarray(0, 4096), buf.length)!
    expect(info).toMatchObject({ sampleRate: RATE, channels: 1, bitsPerSample: 16, audioFormat: 1, dataOffset: 44 })
    expect(info.durationSeconds).toBeCloseTo(2, 5)
  })

  it('uses the file size when a streaming writer left the data size as 0 or 0xFFFFFFFF', () => {
    const path = join(tmpRoot, 'h2.wav')
    writeWav(path, 3, tone(1000))
    for (const size of [0, 0xffffffff]) {
      const buf = Buffer.from(require('node:fs').readFileSync(path))
      buf.writeUInt32LE(size, 40)
      expect(svc.parseWavHeader(buf.subarray(0, 4096), buf.length)!.durationSeconds).toBeCloseTo(3, 5)
    }
  })

  it('reports zero duration for a header-only file', () => {
    const path = join(tmpRoot, 'h3.wav')
    writeWav(path, 0, tone(0))
    const buf = Buffer.from(require('node:fs').readFileSync(path))
    expect(svc.parseWavHeader(buf, buf.length)!.durationSeconds).toBe(0)
  })

  it('returns null for anything that is not a WAV', () => {
    expect(svc.parseWavHeader(Buffer.from('not a wav file at all'), 21)).toBeNull()
  })
})

// ─── planning ────────────────────────────────────────────────────────────────

describe('quietestFrameCenter', () => {
  it('lands in the quiet gap', () => {
    const s = new Int16Array(8000).fill(3000)
    s.fill(0, 5000, 5400)
    const c = svc.quietestFrameCenter(s, 400)
    expect(c).toBeGreaterThanOrEqual(5000)
    expect(c).toBeLessThanOrEqual(5400)
  })
})

describe('planWindows', () => {
  const regionOf = (samples: Int16Array) => async (start: number, count: number) => samples.subarray(start, start + count)

  it('cuts only audio longer than Whisper can take', async () => {
    const short = new Int16Array(20 * RATE)
    expect(await svc.planWindows(short.length, regionOf(short))).toEqual([{ start: 0, end: short.length }])
  })

  it('covers the whole file with contiguous windows, none over the Whisper limit', async () => {
    const samples = new Int16Array(190 * RATE).fill(2000)
    const windows = await svc.planWindows(samples.length, regionOf(samples))
    expect(windows[0].start).toBe(0)
    expect(windows[windows.length - 1].end).toBe(samples.length)
    for (let i = 0; i < windows.length; i++) {
      if (i > 0) expect(windows[i].start).toBe(windows[i - 1].end)
      const secs = (windows[i].end - windows[i].start) / RATE
      expect(secs).toBeGreaterThan(0)
      expect(secs).toBeLessThanOrEqual(svc.WHISPER_MAX_SINGLE_SECONDS)
    }
    expect(windows.length).toBeGreaterThanOrEqual(7)
  })

  it('moves a cut into a pause near the nominal boundary', async () => {
    const samples = new Int16Array(80 * RATE).fill(2000)
    const pause = Math.round(26.2 * RATE) // 1.2 s past the nominal 25 s cut
    samples.fill(0, pause, pause + Math.round(0.3 * RATE))
    const windows = await svc.planWindows(samples.length, regionOf(samples))
    expect(windows[0].end).toBeGreaterThanOrEqual(pause)
    expect(windows[0].end).toBeLessThanOrEqual(pause + Math.round(0.3 * RATE))
  })
})

// ─── output handling ─────────────────────────────────────────────────────────

describe('parseSherpaJsonLines', () => {
  it('returns one result per JSON line, in order, skipping noise', () => {
    const out = [
      '/tmp/w1.wav', '----', 'decoding method: greedy_search',
      JSON.stringify({ lang: 'en', text: ' first ' }),
      'not json {',
      JSON.stringify({ text: 'second' }),
    ].join('\n')
    expect(svc.parseSherpaJsonLines(out)).toEqual([{ text: 'first', lang: 'en' }, { text: 'second', lang: '' }])
  })
})

describe('assembleWindowedResult', () => {
  it('splits windows into sentences and shares each window span by length', () => {
    const windows = [{ start: 0, end: 10 * RATE }, { start: 10 * RATE, end: 20 * RATE }]
    const r = svc.assembleWindowedResult(windows, ['Hi there. How are you?', 'Fine'], 20)
    expect(r.segments.map((s) => s.text)).toEqual(['Hi there.', 'How are you?', 'Fine'])
    expect(r.segments[0].start).toBe(0)
    expect(r.segments[1].start).toBeCloseTo(r.segments[0].end, 9)
    expect(r.segments[1].end).toBeCloseTo(10, 9)
    expect(r.segments[2]).toMatchObject({ start: 10, end: 20 })
    expect(r.text).toBe('Hi there. How are you? Fine')
    expect(r.duration).toBe(20)
  })

  it('drops empty windows', () => {
    const r = svc.assembleWindowedResult([{ start: 0, end: RATE }, { start: RATE, end: 2 * RATE }], ['', 'ok'], 2)
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0].start).toBe(1)
  })
})

describe('isImplausiblyEmpty', () => {
  it('flags long audio with almost no words', () => {
    expect(svc.isImplausiblyEmpty(1, 3018)).toBe(true)
    expect(svc.isImplausiblyEmpty(0, 600)).toBe(true)
  })
  it('accepts real transcripts, short clips and silence', () => {
    expect(svc.isImplausiblyEmpty(5470, 3018)).toBe(false)
    expect(svc.isImplausiblyEmpty(0, 60)).toBe(false)
    expect(svc.isImplausiblyEmpty(0, 0)).toBe(false)
  })
})

// ─── transcribeLocal end to end (sherpa mocked) ──────────────────────────────

describe('transcribeLocal on long audio', () => {
  it('runs sherpa once over every window and stitches the text in order', async () => {
    const wav = join(tmpRoot, 'long.wav')
    writeWav(wav, 100, tone(3000))
    sherpaStdout = (files) =>
      files.map((_, i) => JSON.stringify({ lang: 'en', text: ` Sentence number ${i}. And one more thing ${i}.` })).join('\n')

    const r = await svc.transcribeLocal(wav)

    expect(spawnCalls).toHaveLength(1)
    const windowFiles = spawnCalls[0].args.filter((a) => a.endsWith('.wav'))
    expect(windowFiles.length).toBeGreaterThanOrEqual(4)
    expect(windowFiles).not.toContain(wav)
    expect(r.text.startsWith('Sentence number 0.')).toBe(true)
    expect(r.text).toContain(`Sentence number ${windowFiles.length - 1}.`)
    expect(r.segments.length).toBe(windowFiles.length * 2)
    expect(r.segments[0].start).toBe(0)
    expect(r.segments[r.segments.length - 1].end).toBeCloseTo(100, 3)
    expect(r.duration).toBeCloseTo(100, 3)
    for (let i = 1; i < r.segments.length; i++) expect(r.segments[i].start).toBeGreaterThanOrEqual(r.segments[i - 1].start)
  })

  it('rejects when sherpa returns almost nothing for minutes of speech', async () => {
    const wav = join(tmpRoot, 'long-empty.wav')
    writeWav(wav, 600, tone(3000))
    sherpaStdout = (files) => files.map((_, i) => JSON.stringify({ text: i === 0 ? ' you' : '' })).join('\n')
    await expect(svc.transcribeLocal(wav)).rejects.toThrow('almost no text')
  })

  it('does not call sherpa for silent audio and returns an empty transcript', async () => {
    const wav = join(tmpRoot, 'long-silent.wav')
    writeWav(wav, 100, () => 0)
    const r = await svc.transcribeLocal(wav)
    expect(spawnCalls).toHaveLength(0)
    expect(r.text).toBe('')
    expect(r.segments).toEqual([])
  })

  it('skips silent windows but still transcribes the rest', async () => {
    const wav = join(tmpRoot, 'half-silent.wav')
    writeWav(wav, 100, (i) => (i < 50 * RATE ? 0 : tone(3000)(i)))
    sherpaStdout = (files) => files.map(() => JSON.stringify({ text: ' Spoken words here.' })).join('\n')
    const r = await svc.transcribeLocal(wav)
    expect(spawnCalls).toHaveLength(1)
    expect(r.segments.every((s) => s.start >= 45)).toBe(true)
    expect(r.segments.length).toBeGreaterThan(0)
  })

  it('fails loudly when sherpa returns a different number of results than windows', async () => {
    const wav = join(tmpRoot, 'long-mismatch.wav')
    writeWav(wav, 100, tone(3000))
    sherpaStdout = () => JSON.stringify({ text: 'only one' })
    await expect(svc.transcribeLocal(wav)).rejects.toThrow('audio windows')
  })

  it('leaves short audio as a single pass over the original file', async () => {
    const wav = join(tmpRoot, 'short.wav')
    writeWav(wav, 10, tone(3000))
    sherpaStdout = () => JSON.stringify({ text: ' hello', lang: 'en' })
    const r = await svc.transcribeLocal(wav)
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].args[spawnCalls[0].args.length - 1]).toBe(wav)
    expect(r.text).toBe('hello')
  })

  it('removes its temp windows afterwards', async () => {
    const wav = join(tmpRoot, 'cleanup.wav')
    writeWav(wav, 60, tone(3000))
    sherpaStdout = (files) => files.map(() => JSON.stringify({ text: ' words words words.' })).join('\n')
    await svc.transcribeLocal(wav)
    const dir = require('node:path').dirname(spawnCalls[0].args.find((a) => a.endsWith('.wav'))!)
    expect(require('node:fs').existsSync(dir)).toBe(false)
  })
})
