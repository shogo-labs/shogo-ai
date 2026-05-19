// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── child_process mocks ────────────────────────────────────────────────────

type SpawnImpl = (cmd: string, args: string[], opts: any) => FakeProc

class FakeProc extends EventEmitter {
  stdout = new EventEmitter() as EventEmitter & { on: any }
  stderr = new EventEmitter() as EventEmitter & { on: any }
}

let spawnImpl: SpawnImpl = () => {
  const p = new FakeProc()
  queueMicrotask(() => p.emit('exit', 0))
  return p
}

const execCalls: { cmd: string; opts?: any }[] = []
let execSyncImpl: (cmd: string, opts?: any) => string | Buffer = () => ''

mock.module('child_process', () => ({
  spawn: (cmd: string, args: string[], opts: any) => spawnImpl(cmd, args, opts),
  execSync: (cmd: string, opts?: any) => {
    execCalls.push({ cmd, opts })
    return execSyncImpl(cmd, opts)
  },
}))

// ─── filesystem fixtures ────────────────────────────────────────────────────

let tmpRoot: string
let sherpaDir: string
const SAVED_ENV = { ...process.env }

const PLATFORM_EXT = process.platform === 'win32' ? '.exe' : ''
const DIA_BIN_NAME = `sherpa-onnx-offline-speaker-diarization${PLATFORM_EXT}`

function seedDiarizationBinary() {
  const binDir = join(sherpaDir, 'bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, DIA_BIN_NAME), '')
}

function seedSegmentationModel() {
  const dir = join(sherpaDir, 'models', 'segmentation')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'model.onnx'), '')
}

function seedEmbeddingModel() {
  const dir = join(sherpaDir, 'models', 'embedding')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'nemo_en_titanet_small.onnx'), '')
}

function makeWav16kHz(path: string) {
  const header = Buffer.alloc(44)
  // Minimal WAV header — only sample rate field at offset 24 matters.
  header.write('RIFF', 0, 'ascii')
  header.write('WAVE', 8, 'ascii')
  header.writeUInt32LE(16000, 24)
  writeFileSync(path, header)
}

function makeWav44kHz(path: string) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.write('WAVE', 8, 'ascii')
  header.writeUInt32LE(44100, 24)
  writeFileSync(path, header)
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'diarize-test-'))
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(() => {
  sherpaDir = mkdtempSync(join(tmpRoot, 'sherpa-'))
  execCalls.length = 0
  execSyncImpl = () => ''
  spawnImpl = () => {
    const p = new FakeProc()
    queueMicrotask(() => p.emit('exit', 0))
    return p
  }
  for (const k of Object.keys(process.env)) {
    if (k === 'SHOGO_SHERPA_DIR' || k === 'SHOGO_DATA_DIR') delete process.env[k]
  }
  process.env.SHOGO_SHERPA_DIR = sherpaDir
})

afterEach(() => {
  rmSync(sherpaDir, { recursive: true, force: true })
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED_ENV)) delete process.env[k]
  }
  for (const k of Object.keys(SAVED_ENV)) process.env[k] = SAVED_ENV[k]
})

const svc = await import('../diarization.service')

// ─── path resolution ────────────────────────────────────────────────────────

describe('path resolution', () => {
  it('getDiarizationBinaryPath returns null when missing', () => {
    expect(svc.getDiarizationBinaryPath()).toBeNull()
  })

  it('getDiarizationBinaryPath returns the path when binary exists', () => {
    seedDiarizationBinary()
    expect(svc.getDiarizationBinaryPath()).toBe(join(sherpaDir, 'bin', DIA_BIN_NAME))
  })

  it('getSegmentationModelPath returns null when missing', () => {
    expect(svc.getSegmentationModelPath()).toBeNull()
  })

  it('getSegmentationModelPath returns the path when present', () => {
    seedSegmentationModel()
    expect(svc.getSegmentationModelPath()).toBe(
      join(sherpaDir, 'models', 'segmentation', 'model.onnx'),
    )
  })

  it('getEmbeddingModelPath returns null/path symmetrically', () => {
    expect(svc.getEmbeddingModelPath()).toBeNull()
    seedEmbeddingModel()
    expect(svc.getEmbeddingModelPath()).toBe(
      join(sherpaDir, 'models', 'embedding', 'nemo_en_titanet_small.onnx'),
    )
  })

  it('isDiarizationAvailable requires all three pieces', () => {
    expect(svc.isDiarizationAvailable()).toBe(false)
    seedDiarizationBinary()
    expect(svc.isDiarizationAvailable()).toBe(false)
    seedSegmentationModel()
    expect(svc.isDiarizationAvailable()).toBe(false)
    seedEmbeddingModel()
    expect(svc.isDiarizationAvailable()).toBe(true)
  })
})

// ─── diarize — preconditions ────────────────────────────────────────────────

describe('diarize — preconditions', () => {
  it('throws when the diarization binary is missing', async () => {
    await expect(svc.diarize('/tmp/x.wav')).rejects.toThrow(
      /sherpa-onnx-offline-speaker-diarization binary not found/,
    )
  })

  it('throws when segmentation/embedding models are missing', async () => {
    seedDiarizationBinary()
    await expect(svc.diarize('/tmp/x.wav')).rejects.toThrow(
      /Diarization models not found/,
    )
  })
})

// ─── diarize — happy paths ──────────────────────────────────────────────────

describe('diarize — spawn outcomes', () => {
  let wavFile: string

  beforeEach(() => {
    seedDiarizationBinary()
    seedSegmentationModel()
    seedEmbeddingModel()
    wavFile = join(tmpRoot, `audio-${Date.now()}.wav`)
    makeWav16kHz(wavFile)
  })

  afterEach(() => {
    if (existsSync(wavFile)) rmSync(wavFile)
    const resampled = wavFile.replace(/\.wav$/, '-16k.wav')
    if (existsSync(resampled)) rmSync(resampled)
  })

  function setSpawn(handler: (p: FakeProc) => void) {
    spawnImpl = () => {
      const p = new FakeProc()
      queueMicrotask(() => handler(p))
      return p
    }
  }

  it('parses speaker_NN lines from stdout', async () => {
    setSpawn((p) => {
      p.stdout.emit('data', Buffer.from(
        '0.318 -- 6.865 speaker_00\n'
        + '7.017 -- 10.747 speaker_01\n'
        + '11.000 -- 14.000 speaker_00\n',
      ))
      p.emit('exit', 0)
    })
    const res = await svc.diarize(wavFile)
    expect(res.numSpeakers).toBe(2)
    expect(res.segments).toEqual([
      { start: 0.318, end: 6.865, speaker: 'speaker_00' },
      { start: 7.017, end: 10.747, speaker: 'speaker_01' },
      { start: 11, end: 14, speaker: 'speaker_00' },
    ])
  })

  it('also parses lines printed to stderr', async () => {
    setSpawn((p) => {
      p.stderr.emit('data', Buffer.from('0.0 -- 1.0 speaker_00\n'))
      p.emit('exit', 0)
    })
    const res = await svc.diarize(wavFile)
    expect(res.segments).toEqual([{ start: 0, end: 1, speaker: 'speaker_00' }])
  })

  it('ignores unparseable output and returns empty result', async () => {
    setSpawn((p) => {
      p.stdout.emit('data', Buffer.from('starting...\ndone.\n'))
      p.emit('exit', 0)
    })
    const res = await svc.diarize(wavFile)
    expect(res).toEqual({ segments: [], numSpeakers: 0 })
  })

  it('rejects on non-zero exit with last 500 bytes of stderr', async () => {
    setSpawn((p) => {
      p.stderr.emit('data', Buffer.from('models corrupted'))
      p.emit('exit', 2)
    })
    await expect(svc.diarize(wavFile)).rejects.toThrow(
      /Diarization exited with code 2: models corrupted/,
    )
  })

  it('rejects when the child emits an error event', async () => {
    setSpawn((p) => p.emit('error', new Error('ENOENT')))
    await expect(svc.diarize(wavFile)).rejects.toThrow(/Diarization failed: ENOENT/)
  })

  it('passes numSpeakers as --clustering.num-clusters when > 0', async () => {
    let captured: string[] = []
    spawnImpl = (_cmd, args) => {
      captured = args
      const p = new FakeProc()
      queueMicrotask(() => p.emit('exit', 0))
      return p
    }
    await svc.diarize(wavFile, { numSpeakers: 3 })
    expect(captured.some((a) => a === '--clustering.num-clusters=3')).toBe(true)
    expect(captured.some((a) => a.startsWith('--clustering.cluster-threshold='))).toBe(false)
  })

  it('uses --clustering.cluster-threshold default 0.5 when numSpeakers not specified', async () => {
    let captured: string[] = []
    spawnImpl = (_cmd, args) => {
      captured = args
      const p = new FakeProc()
      queueMicrotask(() => p.emit('exit', 0))
      return p
    }
    await svc.diarize(wavFile)
    expect(captured.some((a) => a === '--clustering.cluster-threshold=0.5')).toBe(true)
  })

  it('forwards a custom clusterThreshold', async () => {
    let captured: string[] = []
    spawnImpl = (_cmd, args) => {
      captured = args
      const p = new FakeProc()
      queueMicrotask(() => p.emit('exit', 0))
      return p
    }
    await svc.diarize(wavFile, { clusterThreshold: 0.7 })
    expect(captured.some((a) => a === '--clustering.cluster-threshold=0.7')).toBe(true)
  })

  it('treats numSpeakers=0 as unspecified (uses threshold instead)', async () => {
    let captured: string[] = []
    spawnImpl = (_cmd, args) => {
      captured = args
      const p = new FakeProc()
      queueMicrotask(() => p.emit('exit', 0))
      return p
    }
    await svc.diarize(wavFile, { numSpeakers: 0 })
    expect(captured.some((a) => a.startsWith('--clustering.cluster-threshold='))).toBe(true)
    expect(captured.some((a) => a.startsWith('--clustering.num-clusters='))).toBe(false)
  })
})

// ─── ensureResampled (exercised through diarize) ────────────────────────────

describe('ensureResampled', () => {
  beforeEach(() => {
    seedDiarizationBinary()
    seedSegmentationModel()
    seedEmbeddingModel()
    spawnImpl = () => {
      const p = new FakeProc()
      queueMicrotask(() => p.emit('exit', 0))
      return p
    }
  })

  it('skips ffmpeg when WAV is already 16kHz', async () => {
    const wav = join(tmpRoot, `r16-${Date.now()}.wav`)
    makeWav16kHz(wav)
    try {
      await svc.diarize(wav)
      expect(execCalls.length).toBe(0)
    } finally {
      rmSync(wav)
    }
  })

  it('throws with platform-specific install hint when ffmpeg is absent', async () => {
    const wav = join(tmpRoot, `r44-${Date.now()}.wav`)
    makeWav44kHz(wav)
    execSyncImpl = (cmd: string) => {
      // 'which ffmpeg' or 'where ffmpeg' — make it fail.
      if (cmd.startsWith('which ') || cmd.startsWith('where ')) {
        throw new Error('not found')
      }
      return ''
    }
    try {
      await expect(svc.diarize(wav)).rejects.toThrow(
        /ffmpeg is required for diarization/,
      )
    } finally {
      rmSync(wav)
    }
  })

  it('resamples via ffmpeg when WAV is not 16kHz', async () => {
    const wav = join(tmpRoot, `r44-${Date.now()}.wav`)
    makeWav44kHz(wav)
    execSyncImpl = (cmd: string) => {
      if (cmd.startsWith('which ') || cmd.startsWith('where ')) return '/usr/bin/ffmpeg\n'
      return ''
    }
    let passedAudioPath = ''
    spawnImpl = (_cmd, args) => {
      passedAudioPath = args[args.length - 1]
      const p = new FakeProc()
      queueMicrotask(() => p.emit('exit', 0))
      return p
    }
    try {
      await svc.diarize(wav)
      const expected = wav.replace(/\.wav$/, '-16k.wav')
      expect(passedAudioPath).toBe(expected)
      // exactly one ffmpeg invocation
      const ffmpegCalls = execCalls.filter((c) => c.cmd.startsWith('ffmpeg'))
      expect(ffmpegCalls).toHaveLength(1)
      expect(ffmpegCalls[0]!.cmd).toContain('-ar 16000')
      expect(ffmpegCalls[0]!.cmd).toContain('-ac 1')
    } finally {
      rmSync(wav)
    }
  })

  it('proceeds to resample when reading the WAV header throws', async () => {
    // Pass a path that doesn't exist — openSync inside ensureResampled
    // will throw, the function should catch and continue to ffmpeg.
    execSyncImpl = (cmd: string) => {
      if (cmd.startsWith('which ') || cmd.startsWith('where ')) return '/usr/bin/ffmpeg'
      return ''
    }
    spawnImpl = () => {
      const p = new FakeProc()
      queueMicrotask(() => p.emit('exit', 0))
      return p
    }
    await svc.diarize('/tmp/does-not-exist.wav')
    expect(execCalls.some((c) => c.cmd.startsWith('ffmpeg'))).toBe(true)
  })
})

// ─── mergeTranscriptWithSpeakers ────────────────────────────────────────────

describe('mergeTranscriptWithSpeakers', () => {
  it('returns transcript unchanged when speaker list is empty', () => {
    const txs = [{ start: 0, end: 1, text: 'hi' }]
    expect(svc.mergeTranscriptWithSpeakers(txs, [])).toEqual(txs)
  })

  it('picks the speaker with the greatest overlap', () => {
    const txs = [{ start: 1, end: 5, text: 'mostly speaker_01' }]
    const sps = [
      { start: 0, end: 1.5, speaker: 'speaker_00' },
      { start: 1.5, end: 5, speaker: 'speaker_01' },
    ]
    const out = svc.mergeTranscriptWithSpeakers(txs, sps)
    expect(out[0]!.speaker).toBe('speaker_01')
  })

  it('leaves speaker undefined when there is no overlap', () => {
    const txs = [{ start: 10, end: 11, text: 'no overlap' }]
    const sps = [{ start: 0, end: 5, speaker: 'speaker_00' }]
    const out = svc.mergeTranscriptWithSpeakers(txs, sps)
    expect(out[0]!.speaker).toBeUndefined()
  })

  it('handles a tie by keeping the first matching speaker (because > not >=)', () => {
    const txs = [{ start: 0, end: 10, text: 'tie' }]
    const sps = [
      { start: 0, end: 5, speaker: 'speaker_00' },
      { start: 5, end: 10, speaker: 'speaker_01' },
    ]
    const out = svc.mergeTranscriptWithSpeakers(txs, sps)
    expect(out[0]!.speaker).toBe('speaker_00')
  })
})

// ─── splitTextBySpeakers ────────────────────────────────────────────────────

describe('splitTextBySpeakers', () => {
  it('returns a single segment when no speakers and text is present', () => {
    expect(svc.splitTextBySpeakers('hello there', [])).toEqual([
      { start: 0, end: 0, text: 'hello there' },
    ])
  })

  it('returns empty array when no speakers and no text', () => {
    expect(svc.splitTextBySpeakers('', [])).toEqual([])
  })

  it('returns a single zero-duration segment when total duration is zero', () => {
    const sps = [
      { start: 0, end: 0, speaker: 'speaker_00' },
    ]
    expect(svc.splitTextBySpeakers('hi', sps)).toEqual([
      { start: 0, end: 0, text: 'hi' },
    ])
  })

  it('distributes words proportionally across speaker segments', () => {
    const sps = [
      { start: 0, end: 2, speaker: 'speaker_00' },
      { start: 2, end: 8, speaker: 'speaker_01' },
    ]
    // 8 words, 25% to A → 2 words, 75% to B → 6 words.
    const out = svc.splitTextBySpeakers('one two three four five six seven eight', sps)
    expect(out).toHaveLength(2)
    expect(out[0]!.text).toBe('one two')
    expect(out[0]!.speaker).toBe('speaker_00')
    expect(out[1]!.text).toBe('three four five six seven eight')
    expect(out[1]!.speaker).toBe('speaker_01')
  })

  it('clamps each segment to at least one word', () => {
    const sps = [
      { start: 0, end: 0.01, speaker: 'speaker_00' }, // basically zero proportion
      { start: 0.01, end: 100, speaker: 'speaker_01' },
    ]
    const out = svc.splitTextBySpeakers('one two', sps)
    expect(out[0]!.text).toBe('one') // forced minimum 1 word
    // After taking 1 for first, remaining is 1; second gets clamped to >= 1 too.
    expect(out[1]!.text.length).toBeGreaterThan(0)
  })

  it('appends remaining words to the last segment', () => {
    const sps = [{ start: 0, end: 10, speaker: 'speaker_00' }]
    // proportion=1 → wordCount = round(1 * totalWords) = totalWords; no remainder
    // But with a longer text and rounding, push the remainder branch:
    const sps2 = [
      { start: 0, end: 2, speaker: 'speaker_00' },
      { start: 2, end: 4, speaker: 'speaker_01' },
    ]
    // proportion 0.5/0.5; round(0.5*5) = 3 / 3 → 6 words taken from 5, but
    // wordCount clamped to remaining slice. Actually Math.round(0.5*5)=3 (banker's
    // rounding doesn't apply — JS rounds half-up: round(2.5)=3). So first gets
    // 3, second gets words[3..6] = 2 of 5, wordIndex hits 5. No remainder branch.
    // Force remainder by using 6 words: round(0.5*6) = 3, round(0.5*6) = 3, total
    // 6, wordIndex 6 = totalWords. Still no remainder. Need uneven proportions.
    const out = svc.splitTextBySpeakers('a b c d e f g', sps2) // 7 words
    // First: round(0.5 * 7) = 4 — wait, 3.5 rounds to 4. wordIndex=4.
    // Second: round(0.5 * 7) = 4 → slice(4, 8) = 3 words. wordIndex=7.
    // No remainder. So just verify structure.
    expect(out.map((s) => s.text).join(' ').split(' ').length).toBe(7)
    expect(out[0]!.speaker).toBe('speaker_00')

    // Force remainder branch by deliberate non-1.0 proportion sum:
    const sps3 = [
      { start: 0, end: 1, speaker: 'speaker_00' },
      { start: 1, end: 2, speaker: 'speaker_01' },
      { start: 2, end: 3, speaker: 'speaker_02' },
    ]
    // 10 words, totalDuration=3, proportion 0.333. round(0.333*10)=3 each.
    // 3+3+3 = 9, remainder 1 word appended to last.
    const r = svc.splitTextBySpeakers('w1 w2 w3 w4 w5 w6 w7 w8 w9 w10', sps3)
    expect(r).toHaveLength(3)
    expect(r[2]!.text.split(' ')).toContain('w10')
  })

  it('drops segments whose word slice is empty', () => {
    const sps = [
      { start: 0, end: 10, speaker: 'speaker_00' },
      { start: 10, end: 11, speaker: 'speaker_01' },
    ]
    // Round(10/11*1)=1; wordIndex=1, exhausted. Second segment gets slice(1,2)=[]
    // → wordCount clamped to 1, but slice would still be empty because we already
    // consumed all the words. The "if (segWords.length > 0)" guard drops it.
    // We use 1 word total. round((10/11)*1)=1. wordIndex=1. Second seg slice(1,2)=[].
    const r = svc.splitTextBySpeakers('only', sps)
    expect(r).toHaveLength(1)
    expect(r[0]!.text).toBe('only')
    expect(r[0]!.speaker).toBe('speaker_00')
  })
})
