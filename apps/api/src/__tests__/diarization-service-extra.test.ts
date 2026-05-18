// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Coverage extras for src/services/diarization.service.ts:
//   - getDiarizationBinaryPath / getSegmentationModelPath / getEmbeddingModelPath
//     null paths (each helper independently)
//   - isDiarizationAvailable composes all three checks (true only when
//     binary + both models exist)
//   - diarize rejects with the right message when (a) binary is missing,
//     (b) binary exists but segmentation model is missing, (c) binary +
//     segmentation exist but embedding model is missing
//   - mergeTranscriptWithSpeakers: no overlap → speaker:undefined,
//     tiebreak picks first-seen-best speaker, partial overlap math
//   - splitTextBySpeakers: totalDuration=0 fallback, remaining-words
//     appended to last segment, single-speaker partition, empty-text +
//     non-empty speakers, multi-speaker proportional split

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const {
  getDiarizationBinaryPath,
  getSegmentationModelPath,
  getEmbeddingModelPath,
  isDiarizationAvailable,
  diarize,
  mergeTranscriptWithSpeakers,
  splitTextBySpeakers,
} = await import('../services/diarization.service')

let sherpaDir: string
const originalEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  originalEnv.SHOGO_SHERPA_DIR = process.env.SHOGO_SHERPA_DIR
  originalEnv.SHOGO_DATA_DIR = process.env.SHOGO_DATA_DIR
  sherpaDir = mkdtempSync(join(tmpdir(), 'sherpa-fake-'))
  process.env.SHOGO_SHERPA_DIR = sherpaDir
})

afterEach(() => {
  rmSync(sherpaDir, { recursive: true, force: true })
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function makeBinary() {
  mkdirSync(join(sherpaDir, 'bin'), { recursive: true })
  writeFileSync(
    join(sherpaDir, 'bin', `sherpa-onnx-offline-speaker-diarization${process.platform === 'win32' ? '.exe' : ''}`),
    Buffer.from(''),
  )
}
function makeSegModel() {
  mkdirSync(join(sherpaDir, 'models', 'segmentation'), { recursive: true })
  writeFileSync(join(sherpaDir, 'models', 'segmentation', 'model.onnx'), Buffer.from(''))
}
function makeEmbModel() {
  mkdirSync(join(sherpaDir, 'models', 'embedding'), { recursive: true })
  writeFileSync(join(sherpaDir, 'models', 'embedding', 'nemo_en_titanet_small.onnx'), Buffer.from(''))
}

// ─── Path helpers ──────────────────────────────────────────────────────

describe('path helpers', () => {
  test('all three helpers return null when nothing is installed', () => {
    expect(getDiarizationBinaryPath()).toBeNull()
    expect(getSegmentationModelPath()).toBeNull()
    expect(getEmbeddingModelPath()).toBeNull()
    expect(isDiarizationAvailable()).toBe(false)
  })

  test('getDiarizationBinaryPath returns the binary path once present', () => {
    makeBinary()
    const p = getDiarizationBinaryPath()
    expect(p).not.toBeNull()
    expect(p!.endsWith(`sherpa-onnx-offline-speaker-diarization${process.platform === 'win32' ? '.exe' : ''}`)).toBe(true)
  })

  test('getSegmentationModelPath returns the segmentation model path once present', () => {
    makeSegModel()
    expect(getSegmentationModelPath()).not.toBeNull()
    expect(getSegmentationModelPath()!.endsWith(join('segmentation', 'model.onnx'))).toBe(true)
  })

  test('getEmbeddingModelPath returns the embedding model path once present', () => {
    makeEmbModel()
    expect(getEmbeddingModelPath()).not.toBeNull()
    expect(getEmbeddingModelPath()!.endsWith('nemo_en_titanet_small.onnx')).toBe(true)
  })

  test('isDiarizationAvailable requires binary + segmentation + embedding all present', () => {
    expect(isDiarizationAvailable()).toBe(false)
    makeBinary()
    expect(isDiarizationAvailable()).toBe(false)
    makeSegModel()
    expect(isDiarizationAvailable()).toBe(false)
    makeEmbModel()
    expect(isDiarizationAvailable()).toBe(true)
  })
})

// ─── diarize() pre-flight error returns ────────────────────────────────

describe('diarize() pre-flight rejections', () => {
  test('rejects with "binary not found" when binary is missing', async () => {
    await expect(diarize('/tmp/missing.wav')).rejects.toThrow(/binary not found/)
  })

  test('rejects with "Diarization models not found" when binary exists but segmentation model is missing', async () => {
    makeBinary()
    makeEmbModel() // explicitly leave segmentation OUT
    await expect(diarize('/tmp/missing.wav')).rejects.toThrow(/models not found/)
  })

  test('rejects with "Diarization models not found" when binary + segmentation exist but embedding is missing', async () => {
    makeBinary()
    makeSegModel() // explicitly leave embedding OUT
    await expect(diarize('/tmp/missing.wav')).rejects.toThrow(/models not found/)
  })
})

// ─── mergeTranscriptWithSpeakers edges ─────────────────────────────────

describe('mergeTranscriptWithSpeakers — edge cases', () => {
  test('no time overlap → speaker is undefined on the result segment', () => {
    const out = mergeTranscriptWithSpeakers(
      [{ start: 10, end: 12, text: 'lonely' }],
      [{ start: 0, end: 5, speaker: 'speaker_00' }],
    )
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('lonely')
    expect(out[0].speaker).toBeUndefined()
  })

  test('first speaker wins on strict-greater overlap (later ties don\'t displace)', () => {
    const out = mergeTranscriptWithSpeakers(
      [{ start: 0, end: 10, text: 'shared' }],
      [
        { start: 0, end: 5, speaker: 'A' },   // overlap = 5 (wins)
        { start: 5, end: 10, speaker: 'B' },  // overlap = 5 (tie — strict >)
      ],
    )
    expect(out[0].speaker).toBe('A')
  })

  test('multi-segment input each get the speaker with greatest overlap', () => {
    const out = mergeTranscriptWithSpeakers(
      [
        { start: 0, end: 5, text: 'first' },
        { start: 6, end: 12, text: 'second' },
      ],
      [
        { start: 0, end: 6, speaker: 'A' },
        { start: 6, end: 14, speaker: 'B' },
      ],
    )
    expect(out[0].speaker).toBe('A')
    expect(out[1].speaker).toBe('B')
  })

  test('empty speakerSegments returns the original textSegments untouched (no speaker key)', () => {
    const input = [{ start: 0, end: 1, text: 'hi' }]
    const out = mergeTranscriptWithSpeakers(input, [])
    expect(out).toBe(input) // exact reference returned
  })
})

// ─── splitTextBySpeakers edges ─────────────────────────────────────────

describe('splitTextBySpeakers — edge cases', () => {
  test('totalDuration === 0 (all-zero windows) → single segment with full text', () => {
    const out = splitTextBySpeakers('hello world', [
      { start: 0, end: 0, speaker: 'A' },
      { start: 0, end: 0, speaker: 'B' },
    ])
    expect(out).toEqual([{ start: 0, end: 0, text: 'hello world' }])
  })

  test('words distributed proportionally + remaining appended to last segment', () => {
    // 6 words, speaker A occupies 1/3 of duration, speaker B occupies 2/3.
    // Expected: A gets ~2 words, B gets ~4 words.
    const out = splitTextBySpeakers('one two three four five six', [
      { start: 0, end: 1, speaker: 'A' },
      { start: 1, end: 3, speaker: 'B' },
    ])
    expect(out).toHaveLength(2)
    expect(out[0].speaker).toBe('A')
    expect(out[1].speaker).toBe('B')
    expect((out[0].text.split(' ').length + out[1].text.split(' ').length)).toBe(6)
  })

  test('text shorter than total wordCount estimate still produces non-empty segments', () => {
    // Just 1 word — rounding sends 1 to each speaker, but slicing past the end
    // yields empty arrays which are skipped (no result.push).
    const out = splitTextBySpeakers('hi', [
      { start: 0, end: 1, speaker: 'A' },
      { start: 1, end: 2, speaker: 'B' },
    ])
    // Either one or both speakers get a segment; the function must not crash
    // and all returned text must be non-empty.
    expect(out.length).toBeGreaterThanOrEqual(1)
    for (const s of out) expect(s.text.length).toBeGreaterThan(0)
  })

  test('empty fullText + non-empty speakers → first speaker absorbs the empty-string token', () => {
    // "".split(/\s+/) === [''] (length 1), so the first speaker's wordCount
    // slice is [''] (non-empty array) and gets pushed as text=''. The
    // second speaker's slice is empty (out of bounds) and is skipped.
    const out = splitTextBySpeakers('', [
      { start: 0, end: 1, speaker: 'A' },
      { start: 1, end: 2, speaker: 'B' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].speaker).toBe('A')
  })

  test('empty speakerSegments + non-empty text → single zero-duration segment', () => {
    const out = splitTextBySpeakers('full text', [])
    expect(out).toEqual([{ start: 0, end: 0, text: 'full text' }])
  })

  test('empty speakerSegments AND empty text → empty array', () => {
    expect(splitTextBySpeakers('', [])).toEqual([])
  })

  test('single speaker covers the entire duration — gets every word', () => {
    const out = splitTextBySpeakers('alpha beta gamma delta', [
      { start: 0, end: 4, speaker: 'A' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].speaker).toBe('A')
    expect(out[0].text).toBe('alpha beta gamma delta')
  })
})
