// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { expect, test } from 'bun:test'
import { normalizeVoiceNoteMetadata } from '../conversation-files'

test('corrects a mislabeled MP4 voice note before it is stored', () => {
  const bytes = new Uint8Array(12)
  bytes.set(new TextEncoder().encode('ftyp'), 4)
  expect(normalizeVoiceNoteMetadata('Voice note.webm', bytes)).toEqual({
    name: 'Voice note.m4a', mimeType: 'audio/mp4',
  })
})

test('leaves ordinary attachments and unknown audio untouched', () => {
  const bytes = new Uint8Array(12)
  bytes.set(new TextEncoder().encode('ftyp'), 4)
  expect(normalizeVoiceNoteMetadata('video.mp4', bytes)).toBeNull()
  expect(normalizeVoiceNoteMetadata('Voice note.webm', new Uint8Array(12))).toBeNull()
})
