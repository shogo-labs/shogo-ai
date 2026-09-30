// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { encodeWav16, pickCutIndex, resampleTo16k, rms, startLiveCapture } from '../live-audio'

const RATE = 48000

function tone(seconds: number, amplitude = 0.3): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE)
  return out
}

describe('live-audio', () => {
  test('waits for the target length, then cuts in the quietest gap', () => {
    expect(pickCutIndex(tone(5), RATE)).toBe(0)
    const samples = new Float32Array(10 * RATE)
    samples.set(tone(7), 0)
    samples.set(tone(2), Math.round(7.6 * RATE))
    const cut = pickCutIndex(samples, RATE)
    expect(cut / RATE).toBeGreaterThan(7)
    expect(cut / RATE).toBeLessThan(7.6)
  })

  test('a forced cut flushes a tail whole up to one chunk', () => {
    expect(pickCutIndex(tone(2), RATE, true)).toBe(2 * RATE)
    expect(pickCutIndex(tone(7), RATE, true)).toBe(7 * RATE)
    expect(pickCutIndex(tone(12), RATE, true)).toBe(12 * RATE)
    expect(pickCutIndex(tone(15), RATE, true)).toBeLessThanOrEqual(12 * RATE)
  })

  test('resamples to 16 kHz and encodes a playable WAV', () => {
    const resampled = resampleTo16k(tone(1), RATE)
    expect(resampled.length).toBe(16000)
    expect(rms(resampled)).toBeGreaterThan(0.15)
    const view = new DataView(encodeWav16(resampled))
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe('RIFF')
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(40, true)).toBe(32000)
  })

  test('silence has near-zero RMS', () => {
    expect(rms(new Float32Array(RATE))).toBe(0)
  })
})

/** Just enough Web Audio to push samples through `startLiveCapture`. */
function fakeAudio() {
  let processor: any
  class FakeContext {
    sampleRate = RATE
    state = 'running'
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} }
    }
    createScriptProcessor() {
      processor = { connect() {}, disconnect() {}, onaudioprocess: null }
      return processor
    }
    close() {
      return Promise.resolve()
    }
  }
  ;(globalThis as any).AudioContext = FakeContext
  return {
    feed(samples: Float32Array) {
      processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } })
    },
  }
}

describe('startLiveCapture', () => {
  test('stop sends the tail and reports full coverage once it lands', async () => {
    const audio = fakeAudio()
    const seqs: number[] = []
    const capture = startLiveCapture({} as MediaStream, async (chunk) => {
      await new Promise((r) => setTimeout(r, 5))
      seqs.push(chunk.seq)
    })!
    audio.feed(tone(9))
    audio.feed(tone(0.5))
    const summary = await capture.stop()
    expect(seqs).toEqual([0, 1])
    expect(summary).toEqual({ complete: true, chunks: 2, seconds: 9.5 })
  })

  test.each([
    [7, 1],
    [15, 2],
  ])('stop sends every buffered sample (%d s fed)', async (tailSeconds, tailChunks) => {
    const audio = fakeAudio()
    const chunks: { start: number; seq: number }[] = []
    const capture = startLiveCapture({} as MediaStream, async (chunk) => {
      chunks.push({ start: chunk.start, seq: chunk.seq })
    })!
    audio.feed(tone(tailSeconds))
    const summary = await capture.stop()
    expect(summary).toEqual({ complete: true, chunks: tailChunks, seconds: tailSeconds })
    expect(chunks.map((c) => c.seq)).toEqual(Array.from({ length: tailChunks }, (_, i) => i))
  })

  test('a rejected chunk, a discard or a timeout is incomplete', async () => {
    let audio = fakeAudio()
    const failing = startLiveCapture({} as MediaStream, async () => {
      throw new Error('503')
    })!
    audio.feed(tone(9))
    expect((await failing.stop()).complete).toBe(false)

    audio = fakeAudio()
    const discarded = startLiveCapture({} as MediaStream, async () => {})!
    audio.feed(tone(3))
    expect(await discarded.stop({ discard: true })).toMatchObject({ complete: false, chunks: 0 })

    audio = fakeAudio()
    const stalled = startLiveCapture({} as MediaStream, () => new Promise(() => {}))!
    audio.feed(tone(9))
    expect((await stalled.stop({ timeoutMs: 20 })).complete).toBe(false)
  })
})
