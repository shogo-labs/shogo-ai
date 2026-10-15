// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  MAX_WAVEFORM_PEAKS,
  WAVEFORM_BARS,
  downsamplePeaks,
  formatClipDuration,
  isVoiceNote,
  meterToLevel,
  peaksToString,
  playbackProgress,
  rmsToLevel,
  seekRatioForTap,
  voiceNoteLabel,
  voiceNotePreview,
  waveformBars,
} from '../voice-note'
import { pickRecordingMimeType } from '../use-voice-note.web'

describe('meterToLevel', () => {
  test('maps the dB window a voice sits in onto 0-100', () => {
    expect(meterToLevel(-60)).toBe(0)
    expect(meterToLevel(-30)).toBe(50)
    expect(meterToLevel(0)).toBe(100)
  })

  test('clamps silence and clipping', () => {
    expect(meterToLevel(-160)).toBe(0)
    expect(meterToLevel(-Infinity)).toBe(0)
    expect(meterToLevel(12)).toBe(100)
    expect(meterToLevel(NaN)).toBe(0)
  })
})

describe('rmsToLevel', () => {
  test('turns an RMS amplitude into a bar level', () => {
    expect(rmsToLevel(0)).toBe(0)
    expect(rmsToLevel(0.125)).toBe(100)
    expect(rmsToLevel(1)).toBe(100)
    expect(rmsToLevel(0.05)).toBe(40)
  })

  test('survives nonsense', () => {
    expect(rmsToLevel(NaN)).toBe(0)
    expect(rmsToLevel(-1)).toBe(0)
  })
})

describe('downsamplePeaks', () => {
  test('takes the loudest sample of each bucket', () => {
    expect(downsamplePeaks([0, 10, 20, 30, 40, 50, 60, 70], 4)).toEqual([10, 30, 50, 70])
  })

  test('never upsamples a short clip into fake bars', () => {
    expect(downsamplePeaks([5, 60, 90], 32)).toEqual([5, 60, 90])
  })

  test('can compress a long clip when asked for fewer bars than samples', () => {
    const samples = Array.from({ length: 500 }, (_, i) => (i === 250 ? 100 : 10))
    const bars = downsamplePeaks(samples, 10)
    expect(bars).toHaveLength(10)
    expect(Math.max(...bars)).toBe(100)
  })

  test('is empty for no samples', () => {
    expect(downsamplePeaks([])).toEqual([])
  })
})

describe('peaksToString', () => {
  test('joins levels and rounds them', () => {
    expect(peaksToString([0, 40.4, 100])).toBe('0 40 100')
  })

  test('clamps and caps', () => {
    expect(peaksToString([-5, 150])).toBe('0 100')
    expect(peaksToString(Array.from({ length: 400 }, () => 7))?.split(' ')).toHaveLength(
      MAX_WAVEFORM_PEAKS,
    )
  })

  test('is null for nothing to store', () => {
    expect(peaksToString([])).toBeNull()
  })
})

describe('waveformBars', () => {
  test('resamples stored peaks to the number of bars drawn', () => {
    const stored = Array.from({ length: 256 }, () => 80).join(' ')
    const bars = waveformBars(stored)
    expect(bars).toHaveLength(WAVEFORM_BARS)
    expect(new Set(bars)).toEqual(new Set([80]))
  })

  test('accepts commas as well as spaces', () => {
    expect(waveformBars('10,20,30')).toEqual([10, 20, 30])
  })

  test('draws a deterministic wave when a clip has no peaks', () => {
    const bars = waveformBars(null)
    expect(bars).toHaveLength(WAVEFORM_BARS)
    expect(bars.every((bar) => bar > 0 && bar <= 52)).toBe(true)
    expect(waveformBars(undefined)).toEqual(bars)
    expect(waveformBars('')).toEqual(bars)
  })
})

describe('formatClipDuration', () => {
  test('shows minutes and seconds, and hours only when needed', () => {
    expect(formatClipDuration(0)).toBe('0:00')
    expect(formatClipDuration(7_400)).toBe('0:07')
    expect(formatClipDuration(62_000)).toBe('1:02')
    expect(formatClipDuration(3_723_000)).toBe('1:02:03')
  })

  test('never shows a negative clock', () => {
    expect(formatClipDuration(-500)).toBe('0:00')
  })
})

describe('playbackProgress', () => {
  test('is a fraction of the clip, clamped', () => {
    expect(playbackProgress(0, 10_000)).toBe(0)
    expect(playbackProgress(2_500, 10_000)).toBe(0.25)
    expect(playbackProgress(20_000, 10_000)).toBe(1)
  })

  test('is zero when the length is unknown', () => {
    expect(playbackProgress(500, 0)).toBe(0)
    expect(playbackProgress(500, NaN)).toBe(0)
  })
})

describe('seekRatioForTap', () => {
  test('maps a tap to a fraction of the track', () => {
    expect(seekRatioForTap(50, 200)).toBe(0.25)
    expect(seekRatioForTap(0, 200)).toBe(0)
    expect(seekRatioForTap(200, 200)).toBe(1)
  })

  test('clamps a tap outside the track', () => {
    expect(seekRatioForTap(-20, 200)).toBe(0)
    expect(seekRatioForTap(500, 200)).toBe(1)
  })

  test('ignores a gesture it cannot place, rather than guessing', () => {
    expect(seekRatioForTap(undefined, 200)).toBeNull()
    expect(seekRatioForTap(NaN, 200)).toBeNull()
    expect(seekRatioForTap('50', 200)).toBeNull()
    expect(seekRatioForTap(50, 0)).toBeNull()
    expect(seekRatioForTap(50, NaN)).toBeNull()
  })
})

describe('isVoiceNote', () => {
  test('recognises audio by type', () => {
    expect(isVoiceNote({ mimeType: 'audio/mp4' })).toBe(true)
    expect(isVoiceNote({ mimeType: 'audio/webm;codecs=opus' })).toBe(true)
  })

  test('recognises audio by extension when a type is missing or wrong', () => {
    expect(isVoiceNote({ mimeType: 'application/octet-stream', name: 'Voice note.m4a' })).toBe(true)
    expect(isVoiceNote({ name: 'clip.ogg' })).toBe(true)
  })

  test('leaves images, documents and video alone', () => {
    expect(isVoiceNote({ mimeType: 'image/png', name: 'shot.png' })).toBe(false)
    expect(isVoiceNote({ mimeType: 'application/pdf', name: 'spec.pdf' })).toBe(false)
    expect(isVoiceNote({ mimeType: 'video/mp4', name: 'clip.mp4' })).toBe(false)
    expect(isVoiceNote({})).toBe(false)
  })
})

describe('voiceNoteLabel and voiceNotePreview', () => {
  test('labels a clip with its length', () => {
    expect(voiceNoteLabel(12_000)).toBe('🎤 Voice note · 0:12')
    expect(voiceNoteLabel(null)).toBe('🎤 Voice note')
    expect(voiceNoteLabel(0)).toBe('🎤 Voice note')
  })

  test('previews the voice note in a message that has no text', () => {
    expect(voiceNotePreview([{ mimeType: 'audio/mp4', durationMs: 7_000 }])).toBe('🎤 Voice note · 0:07')
  })

  test('is blank when there is no voice note', () => {
    expect(voiceNotePreview([{ mimeType: 'image/png' }])).toBe('')
    expect(voiceNotePreview([])).toBe('')
    expect(voiceNotePreview(null)).toBe('')
  })
})

describe('pickRecordingMimeType', () => {
  test('prefers AAC in MP4, which is the one format every client can play', () => {
    const asked: string[] = []
    const chosen = pickRecordingMimeType((type) => {
      asked.push(type)
      return type.startsWith('audio/mp4')
    })
    expect(chosen).toStartWith('audio/mp4')
    expect(asked[0]).toStartWith('audio/mp4')
    expect(asked.some((type) => type.includes('webm'))).toBe(false)
  })

  test('falls back to webm where MP4 cannot be recorded', () => {
    expect(pickRecordingMimeType((type) => type.includes('webm'))).toBe('audio/webm;codecs=opus')
    expect(pickRecordingMimeType((type) => type === 'audio/webm')).toBe('audio/webm')
  })

  test('returns null when nothing is supported, so the browser picks', () => {
    expect(pickRecordingMimeType(() => false)).toBeNull()
  })
})
