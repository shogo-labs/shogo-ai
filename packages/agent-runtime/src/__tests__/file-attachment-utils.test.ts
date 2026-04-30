// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import { parseFileAttachments, type FilePart } from '../file-attachment-utils'

function dataUrl(mediaType: string, content: Buffer | string): string {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content
  return `data:${mediaType};base64,${buf.toString('base64')}`
}

describe('parseFileAttachments', () => {
  test('returns empty result when no file parts present', () => {
    const result = parseFileAttachments([])
    expect(result.images).toEqual([])
    expect(result.textContext).toBe('')
  })

  test('inlines text-based file content with delimiters', () => {
    const parts: FilePart[] = [
      {
        type: 'file',
        mediaType: 'text/plain',
        url: dataUrl('text/plain', 'hello world'),
        name: 'note.txt',
        savedPath: 'files/note.txt',
      },
    ]
    const { textContext, images } = parseFileAttachments(parts)
    expect(images).toEqual([])
    expect(textContext).toContain('[Attached File (note.txt (text/plain))]:')
    expect(textContext).toContain('Saved to workspace at `files/note.txt`')
    expect(textContext).toContain('hello world')
    expect(textContext).toContain('[End of Attached File]')
  })

  test('emits a binary placeholder with the saved path for archives', () => {
    const zipBytes = Buffer.from([
      0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00,
      0x08, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x00,
    ])
    const parts: FilePart[] = [
      {
        type: 'file',
        mediaType: 'application/zip',
        url: dataUrl('application/zip', zipBytes),
        name: 'archive.zip',
        savedPath: 'files/archive.zip',
      },
    ]
    const { textContext, images } = parseFileAttachments(parts)
    expect(images).toEqual([])
    expect(textContext).toContain('[Attached File (archive.zip (application/zip))]:')
    expect(textContext).toContain('Binary content')
    expect(textContext).toContain('Saved to workspace at `files/archive.zip`')
    expect(textContext).not.toContain('[End of Attached File]')
  })

  test('routes images to the images array and announces saved path when present', () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const parts: FilePart[] = [
      {
        type: 'file',
        mediaType: 'image/png',
        url: dataUrl('image/png', pngBytes),
        name: 'pic.png',
        savedPath: 'files/pic.png',
      },
    ]
    const { textContext, images } = parseFileAttachments(parts)
    expect(images).toHaveLength(1)
    expect(images[0].mimeType).toBe('image/png')
    expect(images[0].data).toBe(pngBytes.toString('base64'))
    expect(textContext).toContain('[Attached Image (pic.png (image/png))]:')
    expect(textContext).toContain('Saved to workspace at `files/pic.png`')
  })

  test('omits saved-path note when no savedPath is provided', () => {
    const parts: FilePart[] = [
      {
        type: 'file',
        mediaType: 'application/zip',
        url: dataUrl('application/zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])),
        name: 'noisy.zip',
      },
    ]
    const { textContext } = parseFileAttachments(parts)
    expect(textContext).toContain('Binary content')
    expect(textContext).not.toContain('Saved to workspace at')
  })

  test('skips file parts that are not data URLs', () => {
    const parts: FilePart[] = [
      {
        type: 'file',
        mediaType: 'text/plain',
        url: 'https://example.com/file.txt',
        name: 'remote.txt',
      },
    ]
    const { textContext, images } = parseFileAttachments(parts)
    expect(textContext).toBe('')
    expect(images).toEqual([])
  })
})
