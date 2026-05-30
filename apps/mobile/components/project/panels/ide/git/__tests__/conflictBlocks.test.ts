// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { parseConflictBlocks } from '../conflictBlocks'

describe('parseConflictBlocks', () => {
  it('returns [] for a buffer with no conflict markers', () => {
    expect(parseConflictBlocks('plain text\nno markers\n')).toEqual([])
    expect(parseConflictBlocks('')).toEqual([])
  })

  it('parses a single conflict block', () => {
    const text = [
      'unchanged',
      '<<<<<<< HEAD',
      'mine line 1',
      'mine line 2',
      '=======',
      'theirs line 1',
      '>>>>>>> feature',
      'tail',
    ].join('\n')
    const out = parseConflictBlocks(text)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      start: 2, // 1-based line of `<<<<<<<`
      mid: 5,
      end: 7,
      current: 'mine line 1\nmine line 2',
      incoming: 'theirs line 1',
    })
  })

  it('parses multiple blocks and preserves order', () => {
    const text = [
      '<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> x',
      'between',
      '<<<<<<< HEAD', 'c', '=======', 'd', '>>>>>>> y',
    ].join('\n')
    const out = parseConflictBlocks(text)
    expect(out).toHaveLength(2)
    expect(out[0].current).toBe('a')
    expect(out[0].incoming).toBe('b')
    expect(out[1].current).toBe('c')
    expect(out[1].incoming).toBe('d')
  })

  it('handles CRLF line endings', () => {
    const text = '<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> z\r\n'
    const out = parseConflictBlocks(text)
    expect(out).toHaveLength(1)
    expect(out[0].current).toBe('x')
    expect(out[0].incoming).toBe('y')
  })

  it('skips a block that has no `=======` separator', () => {
    const text = '<<<<<<< HEAD\nx\n>>>>>>> y\n'
    // No mid → never emits.
    expect(parseConflictBlocks(text)).toEqual([])
  })

  it('skips a block that has no closing `>>>>>>>`', () => {
    const text = '<<<<<<< HEAD\nx\n=======\ny\n'
    expect(parseConflictBlocks(text)).toEqual([])
  })

  it('handles empty current or incoming sides', () => {
    const text = '<<<<<<< HEAD\n=======\nonly theirs\n>>>>>>> b\n'
    const out = parseConflictBlocks(text)
    expect(out[0].current).toBe('')
    expect(out[0].incoming).toBe('only theirs')
  })

  it('does not match `=======` lines outside an open block', () => {
    const text = 'before\n=======\nafter\n'
    expect(parseConflictBlocks(text)).toEqual([])
  })

  it('handles a new `<<<<<<<` resetting an unfinished block', () => {
    // The first block never sees `=======`, so when the next `<<<<<<<` arrives
    // we reset and the second block emits cleanly.
    const text = [
      '<<<<<<< first',
      'garbage',
      '<<<<<<< second',
      'a',
      '=======',
      'b',
      '>>>>>>> done',
    ].join('\n')
    const out = parseConflictBlocks(text)
    expect(out).toHaveLength(1)
    expect(out[0].current).toBe('a')
    expect(out[0].incoming).toBe('b')
  })
})
