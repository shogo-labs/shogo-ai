// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A long, three-person Zoom call that opens with silence. It used to come back
 * from local Whisper as the single word "you", with 189 "speakers", and was
 * titled "Meeting (no notes recorded)". This drives the same shape of recording
 * through the real transcription, windowing, diarization-merge and
 * enhancement code, with only sherpa, the speaker model and the LLM faked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── fakes ───────────────────────────────────────────────────────────────────

let meetings = new Map<string, any>()
let prompts: string[] = []
let generated = ''
let sherpaCalls: string[][] = []

const prismaMock = {
  meeting: {
    findUnique: async ({ where }: any) => meetings.get(where.id) ?? null,
    update: async ({ where, data }: any) => {
      const row = meetings.get(where.id)
      if (!row) throw new Error('not found')
      Object.assign(row, data, { updatedAt: new Date() })
      return row
    },
  },
  meetingTemplate: { findFirst: async () => null },
}

mock.module('../lib/prisma', () => ({ prisma: prismaMock }))
mock.module('../lib/resolve-language-model', () => ({
  DEFAULT_ASSISTANT_MODEL: 'test-model',
  resolveLanguageModel: () => ({ model: { id: 'fake' } }),
}))
mock.module('../lib/ai-proxy-token', () => ({ generateProxyToken: async () => 'proxy-token' }))
mock.module('ai', () => ({
  generateText: async ({ prompt }: any) => {
    prompts.push(prompt)
    return { text: generated }
  },
}))

// sherpa-onnx: one JSON line per window file, in order.
let windowTexts: (index: number, total: number) => string = () => ''
mock.module('child_process', () => ({
  spawn: (_cmd: string, args: string[]) => {
    const files = args.filter((a) => a.endsWith('.wav'))
    sherpaCalls.push(files)
    const proc: any = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    queueMicrotask(() => {
      const out = files.map((_, i) => JSON.stringify({ lang: 'en', text: windowTexts(i, files.length) })).join('\n')
      proc.stdout.emit('data', Buffer.from(out))
      proc.emit('exit', 0)
    })
    return proc
  },
  execSync: () => '',
}))

// Speaker model: three people, as in the real call. Real merge functions are kept.
const diarization = await import('../services/diarization.service')
const DURATION = 120
mock.module('../services/diarization.service', () => ({
  ...diarization,
  isDiarizationAvailable: () => true,
  diarize: async () => ({
    numSpeakers: 3,
    segments: [
      { start: 40, end: 70, speaker: 'speaker_00' },
      { start: 70, end: 80, speaker: 'speaker_01' },
      { start: 80, end: 100, speaker: 'speaker_02' },
      { start: 100, end: DURATION, speaker: 'speaker_00' },
    ],
  }),
}))

// ─── fixtures ────────────────────────────────────────────────────────────────

const RATE = 16_000
const BIN = `sherpa-onnx-offline${process.platform === 'win32' ? '.exe' : ''}`
let tmpRoot: string
let wavPath: string
const SAVED_ENV = { ...process.env }

/** 16 kHz mono WAV: `silentSeconds` of nothing, then a tone. */
function writeCall(path: string, seconds: number, silentSeconds: number) {
  const n = seconds * RATE
  const data = Buffer.alloc(n * 2)
  for (let i = silentSeconds * RATE; i < n; i++) {
    data.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 220 * i) / RATE)), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(RATE, 24)
  h.writeUInt32LE(RATE * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([h, data]))
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'long-recording-'))
  const sherpa = join(tmpRoot, 'sherpa')
  mkdirSync(join(sherpa, 'bin'), { recursive: true })
  writeFileSync(join(sherpa, 'bin', BIN), '')
  const model = join(sherpa, 'models', 'whisper-base.en')
  mkdirSync(model, { recursive: true })
  for (const f of ['base.en-encoder.onnx', 'base.en-decoder.onnx', 'base.en-tokens.txt']) writeFileSync(join(model, f), '')
  process.env.SHOGO_SHERPA_DIR = sherpa
  process.env.SHOGO_LOCAL_MODE = 'true'
  wavPath = join(tmpRoot, 'system.wav')
  writeCall(wavPath, DURATION, 40)
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
  for (const k of Object.keys(process.env)) if (!(k in SAVED_ENV)) delete process.env[k]
  for (const k of Object.keys(SAVED_ENV)) process.env[k] = SAVED_ENV[k]
})

beforeEach(() => {
  meetings = new Map()
  prompts = []
  sherpaCalls = []
  generated = ''
  // Silent windows are skipped, so the first spoken window gets the opening line.
  windowTexts = (i, total) =>
    i === 0
      ? 'Good morning everyone. Thanks for joining.'
      : i === total - 1
        ? 'So we ship pricing v2 on Friday. Priya will send the deck.'
        : `Discussion point number ${i}. We keep going over the plan.`
  meetings.set('m1', {
    id: 'm1',
    workspaceId: 'ws1',
    userId: 'u1',
    // The title the desktop app gives a call it has just recorded.
    title: 'Meeting - Mon, Oct 5 at 7:02 AM',
    app: null,
    audioPath: wavPath,
    status: 'transcribing',
    notes: '',
    transcript: null,
    createdAt: new Date('2026-10-05T14:02:04Z'),
  })
})

const service = await import('../services/meeting.service')

// ─── tests ───────────────────────────────────────────────────────────────────

describe('long three-person recording that starts with silence', () => {
  test('transcribes the whole call, not just its first 30 seconds', async () => {
    await service.transcribeMeeting('m1', wavPath, { enhance: false })

    const row = meetings.get('m1')
    expect(row.status).toBe('ready')
    const transcript = service.readTranscript(row.transcript)!
    expect(transcript.error).toBeUndefined()
    expect(transcript.text).not.toBe('you')
    expect(transcript.text.startsWith('Good morning everyone.')).toBe(true)
    expect(transcript.text).toContain('Priya will send the deck.')
    // sherpa ran once, over several windows, none of them the original file
    expect(sherpaCalls).toHaveLength(1)
    expect(sherpaCalls[0].length).toBeGreaterThanOrEqual(3)
    expect(sherpaCalls[0]).not.toContain(wavPath)
    // text from the last window sits at the end of the call
    const last = transcript.segments[transcript.segments.length - 1]
    expect(last.end).toBeCloseTo(DURATION, 0)
    expect(row.duration).toBe(DURATION)
  })

  test('labels all three speakers instead of dropping or exploding them', async () => {
    await service.transcribeMeeting('m1', wavPath, { enhance: false })

    const transcript = service.readTranscript(meetings.get('m1').transcript)!
    expect(transcript.numSpeakers).toBe(3)
    const speakers = new Set(transcript.segments.map((s) => s.speaker).filter(Boolean))
    expect(speakers).toEqual(new Set(['speaker_00', 'speaker_01', 'speaker_02']))
    // segments are short enough that a window with a hand-off doesn't get one label
    expect(transcript.segments.length).toBeGreaterThan(sherpaCalls[0].length)
  })

  test('notes are written from the real transcript and replace the default title', async () => {
    generated = '# Pricing v2 launch plan\n\n## Summary\nShip pricing v2 on Friday.\n\n## Action items\n- [ ] Send the deck — Priya'
    await service.transcribeMeeting('m1', wavPath, { enhance: false })
    await service.enhanceMeeting('m1')

    const row = meetings.get('m1')
    expect(row.enhanceStatus).toBe('ready')
    expect(row.title).toBe('Pricing v2 launch plan')
    expect(row.title).not.toContain('no notes recorded')
    expect(JSON.parse(row.actionItems)).toEqual([{ text: 'Send the deck', owner: 'Priya', done: false }])

    expect(prompts).toHaveLength(1)
    const prompt = prompts[0]
    expect(prompt).not.toContain('(empty)')
    expect(prompt).toContain('Good morning everyone.')
    expect(prompt).toContain('Priya will send the deck.')
    expect(prompt).toMatch(/speaker_0[012]:/)
    expect(prompt).toContain('speaker_01')
  })

  test('a 50-minute transcript (about 5,500 words, 557 segments) fits the notes prompt untruncated', () => {
    const segments = Array.from({ length: 557 }, (_, i) => ({
      start: i * 5.4,
      end: i * 5.4 + 5.4,
      text: `Sentence ${i} ${'word '.repeat(8)}`.trim(),
      speaker: `speaker_0${i % 3}`,
    }))
    const text = service.transcriptToText({ text: '', segments }, 120_000)
    expect(text.length).toBeLessThan(120_000)
    expect(text).not.toContain('[... transcript truncated ...]')
    expect(text).toContain('Sentence 556')
  })
})
