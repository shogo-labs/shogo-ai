// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { encodeWav16, pickCutIndex, resampleTo16k, rms } from '../live-audio'

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

  test('a forced cut flushes a short tail whole', () => {
    expect(pickCutIndex(tone(2), RATE, true)).toBe(2 * RATE)
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
