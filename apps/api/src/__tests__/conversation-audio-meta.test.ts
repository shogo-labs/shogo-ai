// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The voice-note metadata the server accepts and the preview it builds from
 * it. Audio cannot be decoded here, so duration and waveform come from the
 * client and are clamped rather than trusted.
 */

import { describe, expect, test } from 'bun:test'
import {
  formatClipDurationLabel,
  parseAttachmentDurationMs,
  parseAttachmentPeaks,
  parseByteRange,
  previewForAttachments,
} from '../lib/conversation-files'

describe('parseAttachmentDurationMs', () => {
  test('keeps a sane clip length', () => {
    expect(parseAttachmentDurationMs('7350')).toBe(7350)
    expect(parseAttachmentDurationMs(1500)).toBe(1500)
  })

  test('rounds rather than truncating', () => {
    expect(parseAttachmentDurationMs('1499.6')).toBe(1500)
  })

  test('clamps an over-long clip to an hour', () => {
    expect(parseAttachmentDurationMs(String(90 * 60 * 1000))).toBe(60 * 60 * 1000)
  })

  test('drops anything that is not a positive length', () => {
    for (const value of ['', '   ', 'abc', '0', '-5', null, undefined, NaN, Infinity]) {
      expect(parseAttachmentDurationMs(value)).toBeNull()
    }
  })
})

describe('parseAttachmentPeaks', () => {
  test('keeps levels, space separated', () => {
    expect(parseAttachmentPeaks('0 40 100')).toBe('0 40 100')
  })

  test('accepts commas and stray whitespace', () => {
    expect(parseAttachmentPeaks(' 12, 40 ,88 ')).toBe('12 40 88')
  })

  test('clamps levels into 0-100 and rounds them', () => {
    expect(parseAttachmentPeaks('-20 140 55.6')).toBe('0 100 56')
  })

  test('caps how many it stores', () => {
    const stored = parseAttachmentPeaks(Array.from({ length: 400 }, () => 50).join(' '))
    expect(stored?.split(' ').length).toBe(256)
  })

  test('drops the waveform when any level is unparseable', () => {
    expect(parseAttachmentPeaks('10 nope 30')).toBeNull()
    expect(parseAttachmentPeaks('')).toBeNull()
    expect(parseAttachmentPeaks(null)).toBeNull()
  })
})

describe('parseByteRange', () => {
  test('resolves the common forms against the size', () => {
    expect(parseByteRange('bytes=2-5', 10)).toEqual({ kind: 'range', start: 2, end: 5 })
    expect(parseByteRange('bytes=0-', 10)).toEqual({ kind: 'range', start: 0, end: 9 })
    expect(parseByteRange('bytes=-3', 10)).toEqual({ kind: 'range', start: 7, end: 9 })
    expect(parseByteRange('bytes=8-999', 10)).toEqual({ kind: 'range', start: 8, end: 9 })
  })

  test('reports an unsatisfiable start past the end', () => {
    expect(parseByteRange('bytes=10-', 10)).toEqual({ kind: 'unsatisfiable' })
    expect(parseByteRange('bytes=-0', 0)).toEqual({ kind: 'unsatisfiable' })
  })

  test('ignores anything else, as RFC 9110 asks', () => {
    for (const header of [undefined, null, '', 'items=0-1', 'bytes=abc', 'bytes=5-2', 'bytes=0-1,4-5', 'bytes=-']) {
      expect(parseByteRange(header, 10)).toEqual({ kind: 'none' })
    }
  })
})

describe('formatClipDurationLabel', () => {
  test('shows minutes and seconds, and hours only when needed', () => {
    expect(formatClipDurationLabel(12_000)).toBe('0:12')
    expect(formatClipDurationLabel(0)).toBe('0:00')
    expect(formatClipDurationLabel(62_000)).toBe('1:02')
    expect(formatClipDurationLabel(3_723_000)).toBe('1:02:03')
  })
})

describe('previewForAttachments', () => {
  test('labels a voice note with its length', () => {
    expect(previewForAttachments([{ mimeType: 'audio/mp4', durationMs: 12_000 }])).toBe('🎤 Voice note · 0:12')
  })

  test('degrades to a plain label without a length', () => {
    expect(previewForAttachments([{ mimeType: 'audio/mp4', durationMs: null }])).toBe('🎤 Voice note')
  })

  test('stays blank for anything that is not a voice note', () => {
    expect(previewForAttachments([{ mimeType: 'image/png', durationMs: 12_000 }])).toBe('')
    expect(previewForAttachments([])).toBe('')
    expect(previewForAttachments(null)).toBe('')
    expect(previewForAttachments(undefined)).toBe('')
  })
})
