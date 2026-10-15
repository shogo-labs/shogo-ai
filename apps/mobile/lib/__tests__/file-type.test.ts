// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The file badge: what a shared file is called, and the mark drawn on its tile.
 */

import { describe, expect, test } from 'bun:test'
import { fileExtension, fileTypeMeta } from '../file-type'

describe('naming what a file is', () => {
  test('names the office types the way file managers do', () => {
    expect(fileTypeMeta('EM Onboarding Guide - KM.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation').label).toBe(
      'PowerPoint Presentation',
    )
    expect(fileTypeMeta('Root Cause Analysis.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').label).toBe(
      'Word Document',
    )
    expect(fileTypeMeta('Q3 forecast.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').label).toBe('Spreadsheet')
    expect(fileTypeMeta('report.pdf', 'application/pdf').label).toBe('PDF')
  })

  test('names the remaining families', () => {
    expect(fileTypeMeta('notes.txt').label).toBe('Text File')
    expect(fileTypeMeta('deploy.sh').label).toBe('Code File')
    expect(fileTypeMeta('handover.zip').label).toBe('Archive')
    expect(fileTypeMeta('whiteboard.png').label).toBe('Image')
    expect(fileTypeMeta('standup.m4a').label).toBe('Audio')
    expect(fileTypeMeta('demo.mp4').label).toBe('Video')
  })

  test('gives each family its own tile colour', () => {
    expect(fileTypeMeta('deck.pptx').color).not.toBe(fileTypeMeta('doc.docx').color)
    expect(fileTypeMeta('doc.docx').color).not.toBe(fileTypeMeta('sheet.csv').color)
    expect(fileTypeMeta('report.pdf').color).toBe('#DC2626')
  })
})

describe('the glyph on the tile', () => {
  test('uses the office initial, matching the file it stands for', () => {
    expect(fileTypeMeta('deck.pptx').glyph).toBe('P')
    expect(fileTypeMeta('doc.docx').glyph).toBe('W')
    expect(fileTypeMeta('sheet.xlsx').glyph).toBe('X')
    expect(fileTypeMeta('report.pdf').glyph).toBe('PDF')
  })

  test('shows the extension for the types that are only distinguishable by it', () => {
    expect(fileTypeMeta('deploy.sh').glyph).toBe('SH')
    expect(fileTypeMeta('main.py').glyph).toBe('PY')
    expect(fileTypeMeta('handover.zip').glyph).toBe('ZIP')
    expect(fileTypeMeta('notes.txt').glyph).toBe('TXT')
  })

  test('falls back to a generic mark for a file it cannot place', () => {
    expect(fileTypeMeta('data.weirdext').glyph).toBe('WEIR')
    expect(fileTypeMeta('data.weirdext').label).toBe('File')
    expect(fileTypeMeta('noextension').glyph).toBe('FILE')
  })
})

describe('reading the type', () => {
  test('prefers the extension over a MIME type that says nothing', () => {
    // What a browser sends for plenty of uploads; the name is the better clue.
    expect(fileTypeMeta('proposal.docx', 'application/octet-stream').label).toBe('Word Document')
    expect(fileTypeMeta('Proposal.DOCX', 'application/octet-stream').label).toBe('Word Document')
  })

  test('falls back to the MIME type when the name has no extension', () => {
    expect(fileTypeMeta('scan', 'application/pdf').label).toBe('PDF')
    expect(fileTypeMeta('scan', 'image/jpeg').label).toBe('Image')
    expect(fileTypeMeta('payload', 'application/vnd.ms-excel').label).toBe('Spreadsheet')
    expect(fileTypeMeta('payload', 'text/csv').label).toBe('Spreadsheet')
  })

  test('ignores a MIME type parameter list', () => {
    expect(fileTypeMeta('scan', 'application/pdf; charset=utf-8').label).toBe('PDF')
  })

  test('places types with no registered extension by family', () => {
    expect(fileTypeMeta('notes', 'text/plain').glyph).toBe('TXT')
    expect(fileTypeMeta('config', 'application/json').label).toBe('Code File')
    expect(fileTypeMeta('feed', 'application/atom+xml').label).toBe('Code File')
    expect(fileTypeMeta('bundle', 'application/x-tar').label).toBe('Archive')
  })

  test('reads the last extension of a dotted name', () => {
    expect(fileExtension('Q3.2026.forecast.xlsx')).toBe('xlsx')
    expect(fileExtension('archive.tar.gz')).toBe('gz')
    expect(fileExtension('conversations/ws/conv/report.pdf')).toBe('pdf')
    expect(fileExtension('C:\\Users\\eby\\deck.pptx')).toBe('pptx')
  })

  test('treats a dotfile or a trailing dot as having no extension', () => {
    expect(fileExtension('.gitignore')).toBe(null)
    expect(fileExtension('report.')).toBe(null)
    expect(fileExtension('noextension')).toBe(null)
    // Too long to be an extension, so it is part of the name.
    expect(fileExtension('a.verylongextension')).toBe(null)
    expect(fileTypeMeta('.gitignore', 'text/plain').label).toBe('Text File')
  })

  test('keeps a project archive recognisable without a MIME type', () => {
    expect(fileTypeMeta('my-project.shogo').label).toBe('Archive')
  })
})
