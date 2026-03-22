// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import { extractFilePartsAsText, parseFileAttachments } from '../file-attachment-utils'

function toBase64DataUrl(content: string, mediaType: string): string {
  const base64 = Buffer.from(content).toString('base64')
  return `data:${mediaType};base64,${base64}`
}

describe('extractFilePartsAsText', () => {
  test('returns empty string when no file parts present', () => {
    const parts = [{ type: 'text', text: 'Hello' }]
    expect(extractFilePartsAsText(parts)).toBe('')
  })

  test('decodes text/plain file attachment', () => {
    const content = 'Hello, this is a text file.\nLine 2.'
    const parts = [
      { type: 'text', text: 'What does this file say?' },
      { type: 'file', mediaType: 'text/plain', url: toBase64DataUrl(content, 'text/plain') },
    ]

    const result = extractFilePartsAsText(parts)
    expect(result).toContain('[Attached File (text/plain)]')
    expect(result).toContain(content)
    expect(result).toContain('[End of Attached File]')
  })

  test('decodes text/csv file attachment', () => {
    const content = 'name,age,city\nAlice,30,NYC\nBob,25,LA'
    const parts = [
      { type: 'file', mediaType: 'text/csv', url: toBase64DataUrl(content, 'text/csv') },
    ]

    const result = extractFilePartsAsText(parts)
    expect(result).toContain('Alice,30,NYC')
    expect(result).toContain('Bob,25,LA')
  })

  test('decodes application/json file attachment', () => {
    const content = JSON.stringify({ users: [{ name: 'Alice' }] }, null, 2)
    const parts = [
      { type: 'file', mediaType: 'application/json', url: toBase64DataUrl(content, 'application/json') },
    ]

    const result = extractFilePartsAsText(parts)
    expect(result).toContain('[Attached File (application/json)]')
    expect(result).toContain('"name": "Alice"')
  })

  test('decodes text/markdown file attachment', () => {
    const content = '# Heading\n\nSome **bold** text.'
    const parts = [
      { type: 'file', mediaType: 'text/markdown', url: toBase64DataUrl(content, 'text/markdown') },
    ]

    const result = extractFilePartsAsText(parts)
    expect(result).toContain('# Heading')
    expect(result).toContain('Some **bold** text.')
  })

  test('images are routed to native vision, not text output', () => {
    const parts = [
      { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' },
    ]

    const result = extractFilePartsAsText(parts)
    expect(result).toBe('')

    const parsed = parseFileAttachments(parts)
    expect(parsed.images).toHaveLength(1)
    expect(parsed.images[0].mimeType).toBe('image/png')
    expect(parsed.images[0].data).toBe('iVBORw0KGgoAAAANSUhEUg==')
  })

  test('handles multiple file attachments', () => {
    const parts = [
      { type: 'text', text: 'Compare these two files' },
      { type: 'file', mediaType: 'text/plain', url: toBase64DataUrl('File A content', 'text/plain') },
      { type: 'file', mediaType: 'text/plain', url: toBase64DataUrl('File B content', 'text/plain') },
    ]

    const result = extractFilePartsAsText(parts)
    expect(result).toContain('File A content')
    expect(result).toContain('File B content')
    const attachedCount = (result.match(/\[Attached File/g) || []).length
    expect(attachedCount).toBe(2)
  })

  test('handles mixed text and image attachments', () => {
    const parts = [
      { type: 'file', mediaType: 'text/plain', url: toBase64DataUrl('readme content', 'text/plain') },
      { type: 'file', mediaType: 'image/jpeg', url: 'data:image/jpeg;base64,/9j/4AAQ==' },
    ]

    const parsed = parseFileAttachments(parts)
    expect(parsed.textContext).toContain('readme content')
    expect(parsed.images).toHaveLength(1)
    expect(parsed.images[0].mimeType).toBe('image/jpeg')

    const textOnly = extractFilePartsAsText(parts)
    expect(textOnly).toContain('readme content')
    expect(textOnly).not.toContain('image/jpeg')
  })

  test('attempts to decode unknown media types as text if printable', () => {
    const content = 'This is printable text in an unknown format'
    const parts = [
      { type: 'file', mediaType: 'application/octet-stream', url: toBase64DataUrl(content, 'application/octet-stream') },
    ]

    const result = extractFilePartsAsText(parts)
    expect(result).toContain(content)
  })

  test('marks binary content as non-displayable', () => {
    const binaryContent = 'binary\0content\0with\0nulls'
    const parts = [
      { type: 'file', mediaType: 'application/octet-stream', url: toBase64DataUrl(binaryContent, 'application/octet-stream') },
    ]

    const result = extractFilePartsAsText(parts)
    expect(result).toContain('Binary file attached')
    expect(result).toContain('cannot be displayed as text')
  })

  test('skips parts without url', () => {
    const parts = [
      { type: 'file', mediaType: 'text/plain' },
    ]

    const result = extractFilePartsAsText(parts)
    expect(result).toBe('')
  })

  test('skips non-data-url file parts', () => {
    const parts = [
      { type: 'file', mediaType: 'text/plain', url: 'https://example.com/file.txt' },
    ]

    const result = extractFilePartsAsText(parts)
    expect(result).toBe('')
  })

  test('includes file name in label when available', () => {
    const content = 'named file content'
    const parts = [
      { type: 'file', mediaType: 'text/plain', url: toBase64DataUrl(content, 'text/plain'), name: 'readme.txt' },
    ]

    const result = extractFilePartsAsText(parts)
    expect(result).toContain('readme.txt (text/plain)')
  })
})
