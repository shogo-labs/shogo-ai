// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { looksBinary } from '../mergeStages'

describe('looksBinary', () => {
  it('returns false for empty', () => {
    expect(looksBinary('')).toBe(false)
  })

  it('returns false for plain text', () => {
    expect(looksBinary('hello world\nthis is fine\n')).toBe(false)
  })

  it('returns true when a NUL byte appears in the first 8 KiB', () => {
    expect(looksBinary('abc\u0000def')).toBe(true)
  })

  it('only inspects the first 8 KiB so it stays cheap on huge files', () => {
    const head = 'a'.repeat(8192)
    const tailWithNul = '\u0000garbage'
    // NUL is past the 8 KiB head → still classified as text.
    expect(looksBinary(head + tailWithNul)).toBe(false)
  })

  it('detects NUL right at the boundary', () => {
    const justBefore = 'a'.repeat(8191) + '\u0000'
    expect(looksBinary(justBefore)).toBe(true)
  })
})
