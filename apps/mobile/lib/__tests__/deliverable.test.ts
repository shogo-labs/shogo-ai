// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `isDeliverable` / `getFileExtension` — the allowlist that decides
 * whether a written file gets an auto Download chip in chat. The contract:
 * deliverables (PPT/PDF/CSV/ZIP/video/image) are offered; source/code files
 * and dotfiles are not.
 *
 * Run: bun test apps/mobile/lib/__tests__/deliverable.test.ts
 */

import { describe, test, expect } from 'bun:test'

import { isDeliverable, getFileExtension, DELIVERABLE_EXTENSIONS } from '../deliverable'

describe('getFileExtension', () => {
  test('returns lowercased extension without the dot', () => {
    expect(getFileExtension('report.PDF')).toBe('pdf')
    expect(getFileExtension('deck/slides.pptx')).toBe('pptx')
    expect(getFileExtension('a\\b\\data.CSV')).toBe('csv')
  })

  test('returns empty string for no extension or dotfiles', () => {
    expect(getFileExtension('Makefile')).toBe('')
    expect(getFileExtension('.env')).toBe('')
    expect(getFileExtension('.gitignore')).toBe('')
    expect(getFileExtension('folder/README')).toBe('')
  })
})

describe('isDeliverable', () => {
  test('offers deliverable artifacts', () => {
    for (const ext of [
      'report.pdf',
      'deck.pptx',
      'data.csv',
      'sheet.xlsx',
      'archive.zip',
      'clip.mp4',
      'audio.mp3',
      'diagram.png',
      'photo.jpeg',
      'logo.svg',
    ]) {
      expect(isDeliverable(ext)).toBe(true)
    }
  })

  test('does not offer source / code / config files', () => {
    for (const path of [
      'src/main.ts',
      'index.tsx',
      'app.js',
      'styles.css',
      'page.html',
      'config.json',
      'README.md',
      'script.py',
      '.env',
      'Dockerfile',
    ]) {
      expect(isDeliverable(path)).toBe(false)
    }
  })

  test('handles null / undefined / empty input', () => {
    expect(isDeliverable(null)).toBe(false)
    expect(isDeliverable(undefined)).toBe(false)
    expect(isDeliverable('')).toBe(false)
  })

  test('is case-insensitive on the extension', () => {
    expect(isDeliverable('Quarterly.PPTX')).toBe(true)
    expect(isDeliverable('Archive.ZIP')).toBe(true)
  })

  test('every allowlisted extension is recognized', () => {
    for (const ext of DELIVERABLE_EXTENSIONS) {
      expect(isDeliverable(`file.${ext}`)).toBe(true)
    }
  })
})
