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

  test('rejects oversized non-archive files', () => {
    expect(
      validateIslandFiles([
        {
          name: 'large.txt',
          type: 'text/plain',
          size: ISLAND_MAX_FILE_SIZE + 1,
        },
      ]),
    ).toContain('large.txt')
  })

  test('allows project archives to exceed the byte limit', () => {
    expect(
      validateIslandFiles([
        {
          name: 'project.shogo',
          type: 'application/octet-stream',
          size: ISLAND_MAX_FILE_SIZE + 1,
        },
      ]),
    ).toBeNull()
  })

  test('still caps project archives', () => {
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
