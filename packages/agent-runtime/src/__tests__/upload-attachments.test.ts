// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildUploadedFilesNote,
  isZipUpload,
  saveUploadedFileParts,
  type UploadedFilePart,
} from '../upload-attachments'

function dataUrl(mediaType: string, content: Buffer | string): string {
  const buf = typeof content === 'string' ? Buffer.from(content) : content
  return `data:${mediaType};base64,${buf.toString('base64')}`
}

const SILENT_LOG = () => {}
const SILENT_ERR = () => {}

describe('isZipUpload', () => {
  test('matches by application/zip MIME', () => {
    expect(isZipUpload(undefined, 'application/zip')).toBe(true)
    expect(isZipUpload('whatever', 'application/x-zip-compressed')).toBe(true)
  })

  test('matches by .zip extension regardless of MIME', () => {
    expect(isZipUpload('archive.zip', 'application/octet-stream')).toBe(true)
    expect(isZipUpload('Archive.ZIP', undefined)).toBe(true)
  })

  test('rejects non-zip uploads', () => {
    expect(isZipUpload('notes.txt', 'text/plain')).toBe(false)
    expect(isZipUpload('photo.png', 'image/png')).toBe(false)
    expect(isZipUpload(undefined, undefined)).toBe(false)
  })
})

describe('saveUploadedFileParts', () => {
  let workspaceDir: string

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'shogo-upload-test-'))
  })

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true })
  })

  test('routes .zip uploads to the workspace root', () => {
    const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])
    const parts: UploadedFilePart[] = [
      {
        type: 'file',
        mediaType: 'application/zip',
        name: 'archive.zip',
        url: dataUrl('application/zip', zipBytes),
      },
    ]

    const { saved, savedSummaries, zipUploaded } = saveUploadedFileParts({
      workspaceDir,
      parts,
      log: SILENT_LOG,
      logError: SILENT_ERR,
    })

    expect(zipUploaded).toBe(true)
    expect(saved).toHaveLength(1)
    expect(saved[0].isZip).toBe(true)
    expect(saved[0].savedPath).toBe('archive.zip')
    expect(saved[0].absolutePath).toBe(join(workspaceDir, 'archive.zip'))
    expect(existsSync(join(workspaceDir, 'archive.zip'))).toBe(true)
    expect(existsSync(join(workspaceDir, 'files', 'archive.zip'))).toBe(false)
    expect(parts[0].savedPath).toBe('archive.zip')

    const onDisk = readFileSync(join(workspaceDir, 'archive.zip'))
    expect(onDisk.equals(zipBytes)).toBe(true)

    expect(savedSummaries).toHaveLength(1)
    expect(savedSummaries[0]).toContain('`archive.zip`')
    expect(savedSummaries[0]).toContain('application/zip')
  })

  test('detects zip by extension when MIME is generic', () => {
    const parts: UploadedFilePart[] = [
      {
        type: 'file',
        mediaType: 'application/octet-stream',
        name: 'bundle.zip',
        url: dataUrl('application/octet-stream', Buffer.from([0x50, 0x4b])),
      },
    ]

    const { saved, zipUploaded } = saveUploadedFileParts({
      workspaceDir,
      parts,
      log: SILENT_LOG,
      logError: SILENT_ERR,
    })

    expect(zipUploaded).toBe(true)
    expect(saved[0].savedPath).toBe('bundle.zip')
    expect(existsSync(join(workspaceDir, 'bundle.zip'))).toBe(true)
  })

  test('non-zip uploads still land in files/', () => {
    const parts: UploadedFilePart[] = [
      {
        type: 'file',
        mediaType: 'text/plain',
        name: 'notes.txt',
        url: dataUrl('text/plain', 'hello'),
      },
    ]

    const { saved, savedSummaries, zipUploaded } = saveUploadedFileParts({
      workspaceDir,
      parts,
      log: SILENT_LOG,
      logError: SILENT_ERR,
    })

    expect(zipUploaded).toBe(false)
    expect(saved[0].isZip).toBe(false)
    expect(saved[0].savedPath).toBe('files/notes.txt')
    expect(existsSync(join(workspaceDir, 'files', 'notes.txt'))).toBe(true)
    expect(existsSync(join(workspaceDir, 'notes.txt'))).toBe(false)
    expect(savedSummaries[0]).toContain('`files/notes.txt`')
  })

  test('mixes zips at root with other uploads in files/ in a single call', () => {
    const parts: UploadedFilePart[] = [
      {
        type: 'file',
        mediaType: 'application/zip',
        name: 'project.zip',
        url: dataUrl('application/zip', Buffer.from([0x50, 0x4b, 0x03, 0x04])),
      },
      {
        type: 'file',
        mediaType: 'text/plain',
        name: 'readme.txt',
        url: dataUrl('text/plain', 'hi'),
      },
    ]

    const { saved, zipUploaded } = saveUploadedFileParts({
      workspaceDir,
      parts,
      log: SILENT_LOG,
      logError: SILENT_ERR,
    })

    expect(zipUploaded).toBe(true)
    expect(saved.map((s) => s.savedPath).sort()).toEqual(['files/readme.txt', 'project.zip'])
    expect(existsSync(join(workspaceDir, 'project.zip'))).toBe(true)
    expect(existsSync(join(workspaceDir, 'files', 'readme.txt'))).toBe(true)
  })

  test('sanitises filenames so traversal cannot escape the workspace root', () => {
    const parts: UploadedFilePart[] = [
      {
        type: 'file',
        mediaType: 'application/zip',
        name: '../../../escape.zip',
        url: dataUrl('application/zip', Buffer.from([0x50, 0x4b])),
      },
    ]

    const { saved } = saveUploadedFileParts({
      workspaceDir,
      parts,
      log: SILENT_LOG,
      logError: SILENT_ERR,
    })

    expect(saved).toHaveLength(1)
    // Slashes/backslashes are stripped, so the literal ".." sequence cannot
    // act as a path component anymore. The savedPath stays a single segment
    // and the on-disk path must remain inside the workspace root.
    expect(saved[0].savedPath).not.toContain('/')
    expect(saved[0].savedPath).not.toContain('\\')
    expect(saved[0].absolutePath.startsWith(workspaceDir)).toBe(true)
    expect(existsSync(join(workspaceDir, saved[0].savedPath))).toBe(true)
  })

  test('skips parts without a base64 data URL', () => {
    const parts: UploadedFilePart[] = [
      { type: 'file', mediaType: 'application/zip', name: 'remote.zip', url: 'https://example.com/x.zip' },
      { type: 'file', mediaType: 'application/zip', name: 'no-url.zip' },
    ]

    const { saved, savedSummaries, zipUploaded } = saveUploadedFileParts({
      workspaceDir,
      parts,
      log: SILENT_LOG,
      logError: SILENT_ERR,
    })

    expect(saved).toHaveLength(0)
    expect(savedSummaries).toHaveLength(0)
    expect(zipUploaded).toBe(false)
  })
})

describe('buildUploadedFilesNote', () => {
  test('returns empty string when nothing was saved', () => {
    expect(buildUploadedFilesNote([], false)).toBe('')
  })

  test('omits the zip-extraction hint when no zips are present', () => {
    const note = buildUploadedFilesNote(['- `files/foo.txt` (text/plain, 5 B)'], false)
    expect(note).toContain('SYSTEM NOTE')
    expect(note).toContain('files/foo.txt')
    expect(note.toLowerCase()).not.toContain('workspace root')
    expect(note).not.toContain('unzip')
  })

  test('adds a hint that zips live at the workspace root', () => {
    const note = buildUploadedFilesNote(
      ['- `archive.zip` (application/zip, 1.0 KB)'],
      true,
    )
    expect(note).toContain('archive.zip')
    expect(note).toContain('WORKSPACE ROOT')
    expect(note).toContain('unzip')
    expect(note).toContain('not files/')
  })

  test('marks the note as system context so the model does not echo it back', () => {
    const note = buildUploadedFilesNote(['- `archive.zip` (application/zip, 1.0 KB)'], true)
    expect(note.split('\n')[0]).toContain('not written by the user')
    expect(note.split('\n')[0]).toContain('do not echo')
    expect(note.endsWith(']')).toBe(true)
  })
})
