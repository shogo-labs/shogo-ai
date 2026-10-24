// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { withHardBreaks } from '../markdown-breaks'

describe('withHardBreaks', () => {
  test('turns a typed newline into a hard break', () => {
    expect(withHardBreaks('one\ntwo')).toBe('one  \ntwo')
  })

  test('leaves a single line untouched', () => {
    expect(withHardBreaks('just one line')).toBe('just one line')
  })

  test('keeps the blank line that already separates paragraphs', () => {
    expect(withHardBreaks('para\n\npara')).toBe('para  \n\npara')
  })

  test('is idempotent — an existing hard break is not doubled', () => {
    const once = withHardBreaks('one\ntwo')
    expect(withHardBreaks(once)).toBe(once)
  })

  test('treats a line ending in a backslash as already broken', () => {
    expect(withHardBreaks('one\\\ntwo')).toBe('one\\\ntwo')
  })

  test('does not touch lines inside a fenced code block', () => {
    const md = 'before\n```\nconst a = 1\nconst b = 2\n```\nafter'
    expect(withHardBreaks(md)).toBe('before  \n```\nconst a = 1\nconst b = 2\n```\nafter')
  })

  test('does not touch table rows', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    expect(withHardBreaks(md)).toBe(md)
  })

  test('preserves CRLF line endings', () => {
    expect(withHardBreaks('one\r\ntwo')).toBe('one  \r\ntwo')
  })

  test('handles a schedule typed one entry per line (the reported case)', () => {
    const md = 'Oct 22nd 12 PM - Patch\nOct 21st 11 AM - IDBI\nOct 19th 11 AM - Emirates'
    expect(withHardBreaks(md)).toBe('Oct 22nd 12 PM - Patch  \nOct 21st 11 AM - IDBI  \nOct 19th 11 AM - Emirates')
  })
})
