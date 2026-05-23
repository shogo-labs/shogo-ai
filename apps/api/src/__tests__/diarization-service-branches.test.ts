// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

let existingPaths = new Set<string>()
let wavSampleRate = 16000
let ffmpegAvailable = true
let execCalls: string[] = []
let spawnPlan: {
  code?: number
  stdout?: string
  stderr?: string
  error?: Error
} = {}
const spawnCalls: any[] = []

mock.module('fs', () => ({
  existsSync: (path: string) => existingPaths.has(path),
  openSync: mock(() => 1),
  closeSync: mock(() => undefined),
  readSync: mock((_fd: number, buffer: Buffer) => {
    buffer.writeUInt32LE(wavSampleRate, 24)
    return 44
  }),
}))

mock.module('child_process', () => ({
  execSync: mock((cmd: string) => {
    execCalls.push(cmd)
    if (cmd.startsWith('which ') || cmd.startsWith('where ')) {
      if (!ffmpegAvailable) throw new Error('not found')
      return '/usr/local/bin/ffmpeg\n'
    }
    return ''
  }),
  spawn: mock((binaryPath: string, args: string[], options: any) => {
    spawnCalls.push({ binaryPath, args, options })
    const proc: any = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    setTimeout(() => {
      if (spawnPlan.error) {
        proc.emit('error', spawnPlan.error)
        return
      }
      if (spawnPlan.stdout) proc.stdout.emit('data', Buffer.from(spawnPlan.stdout))
      if (spawnPlan.stderr) proc.stderr.emit('data', Buffer.from(spawnPlan.stderr))
      proc.emit('exit', spawnPlan.code ?? 0)
    }, 0)
    return proc
  }),
}))

const {
  diarize,
  getDiarizationBinaryPath,
  getEmbeddingModelPath,
  getSegmentationModelPath,
  isDiarizationAvailable,
  mergeTranscriptWithSpeakers,
  splitTextBySpeakers,
} = await import('../services/diarization.service')

let savedSherpaDir: string | undefined

beforeEach(() => {
  savedSherpaDir = process.env.SHOGO_SHERPA_DIR
  process.env.SHOGO_SHERPA_DIR = '/tmp/sherpa'
  existingPaths = new Set<string>()
  wavSampleRate = 16000
  ffmpegAvailable = true
  execCalls = []
  spawnCalls.length = 0
  spawnPlan = {}
})

afterEach(() => {
  if (savedSherpaDir === undefined) delete process.env.SHOGO_SHERPA_DIR
  else process.env.SHOGO_SHERPA_DIR = savedSherpaDir
})

function installDiarization() {
  existingPaths.add('/tmp/sherpa/bin/sherpa-onnx-offline-speaker-diarization')
  existingPaths.add('/tmp/sherpa/models/segmentation/model.onnx')
  existingPaths.add('/tmp/sherpa/models/embedding/nemo_en_titanet_small.onnx')
}

describe('diarization path helpers', () => {
  test('detects installed binary and models from SHOGO_SHERPA_DIR', () => {
    installDiarization()

    expect(getDiarizationBinaryPath()).toBe('/tmp/sherpa/bin/sherpa-onnx-offline-speaker-diarization')
    expect(getSegmentationModelPath()).toBe('/tmp/sherpa/models/segmentation/model.onnx')
    expect(getEmbeddingModelPath()).toBe('/tmp/sherpa/models/embedding/nemo_en_titanet_small.onnx')
    expect(isDiarizationAvailable()).toBe(true)
  })

  test('reports unavailable when required files are missing', () => {
    expect(getDiarizationBinaryPath()).toBeNull()
    expect(getSegmentationModelPath()).toBeNull()
    expect(getEmbeddingModelPath()).toBeNull()
    expect(isDiarizationAvailable()).toBe(false)
  })
})

describe('diarize', () => {
  test('fails fast when binary or models are missing', async () => {
    await expect(diarize('/audio/input.wav')).rejects.toThrow('speaker-diarization binary not found')

    existingPaths.add('/tmp/sherpa/bin/sherpa-onnx-offline-speaker-diarization')
    await expect(diarize('/audio/input.wav')).rejects.toThrow('Diarization models not found')
  })

  test('runs diarization without resampling for 16 kHz WAV input', async () => {
    installDiarization()
    spawnPlan.stdout = [
      '0.000 -- 1.500 speaker_00',
      '1.500 -- 3.000 speaker_01',
    ].join('\n')

    const result = await diarize('/audio/input.wav', { numSpeakers: 2 })

    expect(result).toEqual({
      segments: [
        { start: 0, end: 1.5, speaker: 'speaker_00' },
        { start: 1.5, end: 3, speaker: 'speaker_01' },
      ],
      numSpeakers: 2,
    })
    expect(spawnCalls[0].args).toContain('--clustering.num-clusters=2')
    expect(spawnCalls[0].args).toContain('/audio/input.wav')
    expect(execCalls.some((cmd) => cmd.startsWith('ffmpeg '))).toBe(false)
  })

  test('resamples non-16k audio through ffmpeg and uses cluster threshold', async () => {
    installDiarization()
    wavSampleRate = 48000
    spawnPlan.stderr = '0.000 -- 2.000 speaker_00\n'

    const result = await diarize('/audio/input.wav', { clusterThreshold: 0.72 })

    expect(result.numSpeakers).toBe(1)
    expect(execCalls).toContain('which ffmpeg')
    expect(execCalls.some((cmd) => cmd.includes('ffmpeg -y -i "/audio/input.wav" -ar 16000 -ac 1 "/audio/input-16k.wav"'))).toBe(true)
    expect(spawnCalls[0].args).toContain('--clustering.cluster-threshold=0.72')
    expect(spawnCalls[0].args).toContain('/audio/input-16k.wav')
  })

  test('uses default cluster threshold when numSpeakers is absent or invalid', async () => {
    installDiarization()
    spawnPlan.stdout = '0.000 -- 2.000 speaker_00\n'

    await diarize('/audio/input.wav', { numSpeakers: 0 })

    expect(spawnCalls[0].args).toContain('--clustering.cluster-threshold=0.5')
  })

  test('surfaces missing ffmpeg, spawn errors, non-zero exits, and parse failures', async () => {
    installDiarization()
    wavSampleRate = 48000
    ffmpegAvailable = false
    await expect(diarize('/audio/input.wav')).rejects.toThrow('ffmpeg is required for diarization')

    wavSampleRate = 16000
    ffmpegAvailable = true
    spawnPlan = { error: new Error('spawn failed') }
    await expect(diarize('/audio/input.wav')).rejects.toThrow('Diarization failed: spawn failed')

    spawnPlan = { code: 9, stderr: 'bad stderr' }
    await expect(diarize('/audio/input.wav')).rejects.toThrow('Diarization exited with code 9: bad stderr')
  })
})

describe('speaker merge helpers', () => {
  test('splitTextBySpeakers appends remaining words to the final speaker segment', () => {
    const segments = splitTextBySpeakers('one two three four five six', [
      { start: 0, end: 1, speaker: 'speaker_00' },
      { start: 1, end: 2, speaker: 'speaker_01' },
      { start: 2, end: 3, speaker: 'speaker_02' },
    ])

    expect(segments.at(-1)?.text).toContain('six')
  })

  test('mergeTranscriptWithSpeakers leaves speaker undefined when no overlap wins', () => {
    expect(mergeTranscriptWithSpeakers([
      { start: 10, end: 11, text: 'alone' },
    ], [
      { start: 0, end: 1, speaker: 'speaker_00' },
    ])).toEqual([{ start: 10, end: 11, text: 'alone', speaker: undefined }])
  })
})

// Regression pin for queue task #42 — these scenarios were the original
// 10-line gap. The platform-specific env wiring + parse-failure catch +
// segment merge + remaining-words branches are covered by the larger
// suites, but isolating them here gives an at-a-glance audit signal if
// any future refactor regresses them.
describe('diarization.service regression pin (queue #42)', () => {
  test('mergeTranscriptWithSpeakers picks the speaker with maximum overlap (DA:231-232)', () => {
    const segments: TranscriptSegment[] = [{ start: 0, end: 10, text: 'hello world' }]
    const speakers: SpeakerSegment[] = [
      { start: 0, end: 3, speaker: 'spk_A' },
      { start: 3, end: 10, speaker: 'spk_B' },
    ]
    const merged = mergeTranscriptWithSpeakers(segments, speakers)
    expect(merged[0].speaker).toBe('spk_B')
  })

  test('splitTextBySpeakers returns one zero-window segment when all windows are zero (DA:250)', () => {
    const out = splitTextBySpeakers('full text body', [
      { start: 0, end: 0, speaker: 'A' },
      { start: 0, end: 0, speaker: 'B' },
    ])
    expect(out).toEqual([{ start: 0, end: 0, text: 'full text body' }])
  })
})
