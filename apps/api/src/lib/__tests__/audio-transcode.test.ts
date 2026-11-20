// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { expect, test } from 'bun:test'
import { getTranscodedAudio } from '../audio-transcode'

test('passes AAC-in-MP4 voice notes through without starting a conversion', async () => {
  // ftyp > moov > trak > mdia > minf > stbl > stsd > mp4a
  const source = new Uint8Array(80)
  const view = new DataView(source.buffer)
  view.setUint32(0, 16)
  source.set(new TextEncoder().encode('ftyp'), 4)
  source.set(new TextEncoder().encode('M4A '), 8)
  view.setUint32(16, 64)
  source.set(new TextEncoder().encode('moov'), 20)
  view.setUint32(24, 56)
  source.set(new TextEncoder().encode('trak'), 28)
  view.setUint32(32, 48)
  source.set(new TextEncoder().encode('mdia'), 36)
  view.setUint32(40, 40)
  source.set(new TextEncoder().encode('minf'), 44)
  view.setUint32(48, 32)
  source.set(new TextEncoder().encode('stbl'), 52)
  view.setUint32(56, 24)
  source.set(new TextEncoder().encode('stsd'), 60)
  view.setUint32(68, 1) // one sample entry after the FullBox fields
  view.setUint32(72, 8)
  source.set(new TextEncoder().encode('mp4a'), 76)

  expect(await getTranscodedAudio('test-aac-pass-through', async () => source)).toBe(source)
})
