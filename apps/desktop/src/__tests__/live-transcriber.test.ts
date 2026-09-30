// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { LiveTranscriber, LIVE_SOURCE_RATE, encodeWav16k, pickCutIndex } from '../recording/live-transcriber'

function tone(seconds: number, amplitude = 8000): Int16Array {
  const out = new Int16Array(Math.round(seconds * LIVE_SOURCE_RATE))
  for (let i = 0; i < out.length; i++) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / LIVE_SOURCE_RATE))
  return out
}

function bytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('LiveTranscriber', () => {
  test('cuts at the quiet gap and keeps a continuous timeline', async () => {
    const posted: { start: number; seq: number; seconds: number }[] = []
    const live = new LiveTranscriber(async (chunk) => {
      posted.push({ start: chunk.start, seq: chunk.seq, seconds: (chunk.wav.length - 44) / 2 / 16000 })
      return { ok: true, status: 200 }
    })
    const speech = new Int16Array(Math.round(9 * LIVE_SOURCE_RATE))
    speech.set(tone(7), 0)
    speech.set(tone(1.5), Math.round(7.5 * LIVE_SOURCE_RATE))
    live.feedMic(bytes(speech))
    await flush()
    expect(posted).toHaveLength(1)
    expect(posted[0].start).toBe(0)
    expect(posted[0].seconds).toBeGreaterThan(7)
    expect(posted[0].seconds).toBeLessThan(7.5)

    live.feedMic(bytes(tone(3)))
    live.stop()
    await flush()
    expect(posted).toHaveLength(2)
    expect(posted[1].start).toBeCloseTo(posted[0].seconds, 2)
    expect(posted[1].seq).toBe(1)
  })

  test('skips silence without breaking the timeline', async () => {
    const posted: number[] = []
    const live = new LiveTranscriber(async (chunk) => {
      posted.push(chunk.seq)
      return { ok: true, status: 200 }
    })
    live.feedMic(bytes(new Int16Array(9 * LIVE_SOURCE_RATE)))
    live.feedMic(bytes(tone(9)))
    await flush()
    expect(posted).toEqual([1])
  })

  test('stops sending once transcription is unavailable', async () => {
    let calls = 0
    const live = new LiveTranscriber(async () => {
      calls++
      return { ok: false, status: 503 }
    })
    live.feedMic(bytes(tone(9)))
    await flush()
    live.feedMic(bytes(tone(9)))
    await flush()
    expect(calls).toBe(1)
  })

  test('finish waits for the tail and reports full coverage', async () => {
    let release: () => void = () => {}
    const posted: number[] = []
    const live = new LiveTranscriber(async (chunk) => {
      posted.push(chunk.seq)
      if (chunk.seq === 0) await new Promise<void>((r) => (release = r))
      return { ok: true, status: 200 }
    })
    live.feedMic(bytes(tone(9)))
    live.feedMic(bytes(tone(0.5)))
    const done = live.finish()
    await flush()
    release()
    const summary = await done
    expect(posted).toEqual([0, 1])
    expect(summary.complete).toBe(true)
    expect(summary.chunks).toBe(2)
    expect(summary.seconds).toBeCloseTo(9.5, 1)
  })

  test('a failed chunk or a stalled server means incomplete', async () => {
    let n = 0
    const flaky = new LiveTranscriber(async () => ({ ok: n++ > 0, status: n === 1 ? 500 : 200 }))
    flaky.feedMic(bytes(tone(9)))
    flaky.feedMic(bytes(tone(9)))
    expect((await flaky.finish()).complete).toBe(false)

    const stalled = new LiveTranscriber(() => new Promise(() => {}))
    stalled.feedMic(bytes(tone(9)))
    const summary = await stalled.finish(20)
    expect(summary.complete).toBe(false)
    expect(summary.chunks).toBe(0)
  })

  test('downsamples to a 16 kHz WAV and flushes short tails whole', () => {
    const wav = encodeWav16k(tone(1))
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect((wav.length - 44) / 2).toBe(16000)
    expect(pickCutIndex(tone(3), false)).toBe(0)
    expect(pickCutIndex(tone(3), true)).toBe(3 * LIVE_SOURCE_RATE)
  })
})
