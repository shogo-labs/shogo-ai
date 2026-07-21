// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  allocateVideoFrameBudgets,
  formatAttachmentSize,
  isArchiveAttachment,
  isImageAttachment,
  isVideoAttachment,
  normaliseVideoFileForMetadata,
  processChatAttachmentFiles,
} from '../video-attachment-utils'

describe('video attachment utils', () => {
  test('detects videos by MIME type and common extensions', () => {
    expect(isVideoAttachment('video/mp4', 'clip.bin')).toBe(true)
    expect(isVideoAttachment('', 'screen-recording.mov')).toBe(true)
    expect(isVideoAttachment('application/octet-stream', 'demo.webm')).toBe(true)
    expect(isVideoAttachment('image/png', 'image.png')).toBe(false)
  })

  test('normalises generic video blobs using the filename extension for metadata loading', () => {
    const genericMov = new File([Buffer.from('mov')], 'screen-recording.mov', {
      type: 'application/octet-stream',
    })
    const normalised = normaliseVideoFileForMetadata(genericMov)

    expect(normalised).not.toBe(genericMov)
    expect(normalised.type).toBe('video/quicktime')
  })

  test('keeps explicit video MIME types unchanged for metadata loading', () => {
    const mp4 = new File([Buffer.from('mp4')], 'clip.mp4', { type: 'video/mp4' })

    expect(normaliseVideoFileForMetadata(mp4)).toBe(mp4)
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

  test('splits limited derived frame slots across multiple videos', () => {
    expect(allocateVideoFrameBudgets(3, 5, 8)).toEqual([2, 2, 1])
    expect(allocateVideoFrameBudgets(2, 20, 8)).toEqual([8, 8])
    expect(allocateVideoFrameBudgets(2, 0, 8)).toEqual([0, 0])
  })

  test('reserves original and context slots for accepted videos before frames', async () => {
    const previousFileReader = (globalThis as any).FileReader
    ;(globalThis as any).FileReader = class MockFileReader {
      result: string | null = null
      error: Error | null = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null

      async readAsDataURL(file: File) {
        const bytes = Buffer.from(await file.arrayBuffer())
        this.result = `data:${file.type};base64,${bytes.toString('base64')}`
        this.onload?.()
      }
    }

    try {
      const first = new File([Buffer.from('one')], 'first.mp4', { type: 'video/mp4' })
      const second = new File([Buffer.from('two')], 'second.mov', { type: 'application/octet-stream' })
      const result = await processChatAttachmentFiles([first, second], {
        currentCount: 0,
        maxFiles: 3,
        maxFileSizeBytes: 10 * 1024 * 1024,
      })

      expect(result.files.map((file) => file.name)).toEqual(['first.mp4', 'first.video-context.txt'])
      expect(result.files[1].internal).toBe(true)
      expect(result.files[1].sourceFileId).toBe(result.files[0].id)
      expect(result.structuredErrors[0]).toMatchObject({
        code: 'video_frame_extraction_failed',
        fileName: 'first.mp4',
      })
      expect(result.structuredErrors.some((error) => error.code === 'attachment_limit_exceeded' && error.fileName === 'second.mov')).toBe(true)
    } finally {
      if (previousFileReader) (globalThis as any).FileReader = previousFileReader
      else delete (globalThis as any).FileReader
    }
  })

})
