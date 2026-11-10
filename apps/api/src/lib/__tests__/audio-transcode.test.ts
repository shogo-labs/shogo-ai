// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { expect, test } from 'bun:test'
import { getTranscodedAudio } from '../audio-transcode'

test('passes AAC-in-MP4 voice notes through without starting a conversion', async () => {
  const source = new Uint8Array(32)
  const view = new DataView(source.buffer)
  view.setUint32(0, 16)
  source.set(new TextEncoder().encode('ftyp'), 4)
  source.set(new TextEncoder().encode('M4A '), 8)
  view.setUint32(16, 16)
  source.set(new TextEncoder().encode('moov'), 20)
  source.set(new TextEncoder().encode('mp4a'), 24)

  expect(await getTranscodedAudio('test-aac-pass-through', async () => source)).toBe(source)
})
