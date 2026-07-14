// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  formatAttachmentSize,
  isArchiveAttachment,
  isImageAttachment,
  isVideoAttachment,
} from '../video-attachment-utils'

describe('video attachment utils', () => {
  test('detects videos by MIME type and common extensions', () => {
    expect(isVideoAttachment('video/mp4', 'clip.bin')).toBe(true)
    expect(isVideoAttachment('', 'screen-recording.mov')).toBe(true)
    expect(isVideoAttachment('application/octet-stream', 'demo.webm')).toBe(true)
    expect(isVideoAttachment('image/png', 'image.png')).toBe(false)
  })

  test('keeps image and archive detection separate from videos', () => {
    expect(isImageAttachment('image/jpeg')).toBe(true)
    expect(isImageAttachment('video/mp4')).toBe(false)
    expect(isArchiveAttachment('application/zip', 'bundle.zip')).toBe(true)
    expect(isArchiveAttachment('video/mp4', 'clip.mp4')).toBe(false)
  })

  test('formats attachment sizes consistently for composer previews', () => {
    expect(formatAttachmentSize(12)).toBe('12 B')
    expect(formatAttachmentSize(1536)).toBe('1.5 KB')
    expect(formatAttachmentSize(2 * 1024 * 1024)).toBe('2.0 MB')
  })
})
