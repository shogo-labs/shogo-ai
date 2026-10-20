// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Two decisions that keep a shared file inside the app: which links are an
 * attachment of ours (so they open the viewer instead of a browser), and which
 * renderer a file gets once the viewer knows what it is.
 */

import { describe, expect, test } from 'bun:test'
import { parseFileLink } from '../team-chat-links'
import { fileExtension, isExtractedPreview, viewerModeFor } from '../file-viewer-mode'

const HOSTS = new Set(['studio.shogo.ai'])

describe('recognising a shared file link', () => {
  test('the capability URL an attachment carries', () => {
    expect(parseFileLink('https://studio.shogo.ai/api/conversation-files/att-1?t=sig', HOSTS)).toEqual({
      attachmentId: 'att-1',
    })
  })

  test("the viewer's own path", () => {
    expect(parseFileLink('https://studio.shogo.ai/f/att-2', HOSTS)).toEqual({ attachmentId: 'att-2' })
  })

  test('another app’s URL is not ours to open', () => {
    expect(parseFileLink('https://example.com/api/conversation-files/att-3', HOSTS)).toBeNull()
  })

  test('a message link is not a file link', () => {
    expect(parseFileLink('https://studio.shogo.ai/c/conv-1?msg=m-1', HOSTS)).toBeNull()
  })

  test('nonsense is ignored rather than thrown at', () => {
    expect(parseFileLink('not a url', HOSTS)).toBeNull()
  })
})

describe('picking a renderer', () => {
  test('pictures, video, audio and PDFs render natively', () => {
    expect(viewerModeFor('image/png', 'shot.png', false)).toBe('image')
    expect(viewerModeFor('video/mp4', 'clip.mp4', false)).toBe('video')
    expect(viewerModeFor('audio/mp4', 'note.m4a', false)).toBe('audio')
    expect(viewerModeFor('application/pdf', 'deck.pdf', false)).toBe('pdf')
  })

  test('text and code render as text even with no extraction', () => {
    expect(viewerModeFor('text/plain', 'notes.txt', false)).toBe('text')
    expect(viewerModeFor('application/json', 'data.json', false)).toBe('text')
    expect(viewerModeFor('application/octet-stream', 'deploy.sh', false)).toBe('text')
    expect(viewerModeFor('text/csv', 'rows.csv', false)).toBe('text')
  })

  test('an office document opens as its extracted text', () => {
    expect(viewerModeFor('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck.pptx', true)).toBe('text')
  })

  test('nothing readable means an honest download', () => {
    expect(viewerModeFor('application/zip', 'bundle.zip', false)).toBe('download')
    expect(viewerModeFor('application/octet-stream', 'blob', false)).toBe('download')
  })

  test('extracted text is labelled as an extraction', () => {
    expect(isExtractedPreview('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'report.docx')).toBe(true)
    expect(isExtractedPreview('text/plain', 'notes.txt')).toBe(false)
    expect(isExtractedPreview('application/json', 'data.json')).toBe(false)
  })

  test('the extension is what the person sees, and it wins over a bare MIME type', () => {
    expect(fileExtension('archive.tar.gz')).toBe('gz')
    expect(fileExtension('Makefile')).toBe('')
    expect(fileExtension('/some/path/README.md')).toBe('md')
  })
})
