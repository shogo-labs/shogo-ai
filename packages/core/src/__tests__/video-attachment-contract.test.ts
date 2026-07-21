// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  VIDEO_DERIVED_ATTACHMENT,
  VIDEO_EXTENSIONS,
  isVideoAttachmentType,
  videoMimeTypeFromName,
} from '../video-attachment-contract'

describe('video attachment contract', () => {
  test('recognises common video names even when the MIME type is generic', () => {
    expect(isVideoAttachmentType('application/octet-stream', 'screen-recording.mov')).toBe(true)
    expect(isVideoAttachmentType('', 'demo.webm')).toBe(true)
    expect(isVideoAttachmentType('video/mp4', 'clip.bin')).toBe(true)
    expect(isVideoAttachmentType('image/png', 'image.png')).toBe(false)
  })

  test('maps known video extensions to upload MIME types', () => {
    expect(videoMimeTypeFromName('clip.MP4')).toBe('video/mp4')
    expect(videoMimeTypeFromName('clip.mov')).toBe('video/quicktime')
    expect(videoMimeTypeFromName('clip.webm')).toBe('video/webm')
    expect(videoMimeTypeFromName('notes.txt')).toBeUndefined()
  })

  test('publishes the derived attachment defaults used by clients and runtime', () => {
    expect(VIDEO_EXTENSIONS).toContain('.mov')
    expect(VIDEO_DERIVED_ATTACHMENT.contextSuffix).toBe('.video-context.txt')
    expect(VIDEO_DERIVED_ATTACHMENT.maxFrames).toBeGreaterThan(0)
  })
})
