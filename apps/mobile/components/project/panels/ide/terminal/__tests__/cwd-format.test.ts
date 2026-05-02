// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { formatPromptCwd } from '../cwd-format'

describe('formatPromptCwd', () => {
  test('returns empty string for null or empty', () => {
    expect(formatPromptCwd(null)).toBe('')
    expect(formatPromptCwd('')).toBe('')
  })

  test('returns "/" for the root path', () => {
    expect(formatPromptCwd('/')).toBe('/')
  })

  test('keeps single-segment absolute paths verbatim', () => {
    expect(formatPromptCwd('/tmp')).toBe('/tmp')
    expect(formatPromptCwd('/home')).toBe('/home')
  })

  test('shows the last two segments for deeper paths', () => {
    expect(formatPromptCwd('/a/b')).toBe('a/b')
    expect(formatPromptCwd('/a/b/c/d')).toBe('c/d')
    expect(formatPromptCwd('/var/lib/foo')).toBe('lib/foo')
  })

  test('tolerates trailing slashes', () => {
    expect(formatPromptCwd('/a/b/c/')).toBe('b/c')
  })
})
