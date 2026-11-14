// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  ISLAND_MAX_ARCHIVE_SIZE,
  ISLAND_MAX_FILE_SIZE,
  validateIslandFiles,
} from '../island-attachments'

describe('Shogo island attachments', () => {
  test('accepts files within the shared composer limit', () => {
    expect(
      validateIslandFiles([
        { name: 'notes.txt', type: 'text/plain', size: 1024 },
        { name: 'image.png', type: 'image/png', size: ISLAND_MAX_FILE_SIZE },
      ]),
    ).toBeNull()
  })

  test('accepts a 50 MB non-archive file', () => {
    expect(
      validateIslandFiles([
        {
          name: 'large.bin',
          type: 'application/octet-stream',
          size: 50 * 1024 * 1024,
        },
      ]),
    ).toBeNull()
  })

  test('rejects oversized non-archive files', () => {
    const error = validateIslandFiles([
      {
        name: 'large.txt',
        type: 'text/plain',
        size: ISLAND_MAX_FILE_SIZE + 1,
      },
    ])
    expect(error).toContain('large.txt')
    expect(error).toContain('500MB')
  })

  test('accepts a 300 MB file and a 300 MB archive (local = paid)', () => {
    expect(
      validateIslandFiles([
        { name: 'video.mp4', type: 'video/mp4', size: 300 * 1024 * 1024 },
        { name: 'project.zip', type: 'application/zip', size: 300 * 1024 * 1024 },
      ]),
    ).toBeNull()
  })

  test('caps project archives at the same 500 MB ceiling', () => {
    expect(
      validateIslandFiles([
        {
          name: 'project.zip',
          type: 'application/zip',
          size: ISLAND_MAX_ARCHIVE_SIZE + 1,
        },
      ]),
    ).toContain('project.zip')
  })

  test('rejects more than ten files', () => {
    expect(
      validateIslandFiles(
        Array.from({ length: 11 }, (_, index) => ({
          name: `file-${index}.txt`,
          type: 'text/plain',
          size: 1,
        })),
      ),
    ).toContain('Maximum')
  })
})
