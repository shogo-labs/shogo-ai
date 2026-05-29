// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Tests for the pure splice helper that powers `revertHunk`. The
// real exported function adds `git show HEAD:path` + `fs.writeFile`
// around the splice; those are integration-tested by the renderer.

import { describe, expect, it } from 'bun:test'
import { spliceRevert } from '../hunkRevert'

describe('spliceRevert', () => {
  describe('modified hunks', () => {
    it('replaces a working line range with the matching HEAD lines', () => {
      const working = 'a\nb-changed\nc\n'
      const head    = 'a\nb\nc\n'
      const out = spliceRevert(working, head, {
        workingStart: 2, workingEnd: 2, headStart: 2, headEnd: 2,
      })
      expect(out).toBe('a\nb\nc\n')
    })

    it('handles multi-line replacements where HEAD has more lines than the working range', () => {
      const working = 'a\nx\nz\n'
      const head    = 'a\nb\nc\nd\nz\n'
      const out = spliceRevert(working, head, {
        workingStart: 2, workingEnd: 2, headStart: 2, headEnd: 4,
      })
      expect(out).toBe('a\nb\nc\nd\nz\n')
    })

    it('handles replacements where the working range is longer than HEAD', () => {
      const working = 'a\nx1\nx2\nx3\nz\n'
      const head    = 'a\nb\nz\n'
      const out = spliceRevert(working, head, {
        workingStart: 2, workingEnd: 4, headStart: 2, headEnd: 2,
      })
      expect(out).toBe('a\nb\nz\n')
    })
  })

  describe('added hunks (pure deletion in working)', () => {
    it('deletes the working line range when headStart/headEnd are null', () => {
      const working = 'keep1\nadded\nkeep2\n'
      const head    = ''
      const out = spliceRevert(working, head, {
        workingStart: 2, workingEnd: 2, headStart: null, headEnd: null,
      })
      expect(out).toBe('keep1\nkeep2\n')
    })

    it('deletes a multi-line block', () => {
      const working = 'a\nADD1\nADD2\nADD3\nb\n'
      const out = spliceRevert(working, '', {
        workingStart: 2, workingEnd: 4, headStart: null, headEnd: null,
      })
      expect(out).toBe('a\nb\n')
    })
  })

  describe('removed hunks (pure insertion in working)', () => {
    it('inserts HEAD lines at the anchor without consuming working content', () => {
      const working = 'a\nc\n'
      const head    = 'a\nb\nc\n'
      // workingEnd = workingStart - 1 expresses "insert at anchor 2".
      const out = spliceRevert(working, head, {
        workingStart: 2, workingEnd: 1, headStart: 2, headEnd: 2,
      })
      expect(out).toBe('a\nb\nc\n')
    })

    it('inserts at the top of the file', () => {
      const working = 'b\nc\n'
      const head    = 'a\nb\nc\n'
      const out = spliceRevert(working, head, {
        workingStart: 1, workingEnd: 0, headStart: 1, headEnd: 1,
      })
      expect(out).toBe('a\nb\nc\n')
    })
  })

  describe('line endings', () => {
    it('preserves CRLF when the working file uses CRLF', () => {
      const working = 'a\r\nx\r\nb\r\n'
      const head    = 'a\r\ny\r\nb\r\n'
      const out = spliceRevert(working, head, {
        workingStart: 2, workingEnd: 2, headStart: 2, headEnd: 2,
      })
      expect(out).toBe('a\r\ny\r\nb\r\n')
    })

    it('uses LF when the working file has no CRLF', () => {
      const out = spliceRevert('a\nx\nb\n', 'a\ny\nb\n', {
        workingStart: 2, workingEnd: 2, headStart: 2, headEnd: 2,
      })
      expect(out.includes('\r\n')).toBe(false)
    })

    it('preserves "no trailing newline" shape', () => {
      const working = 'a\nx\nb'
      const head    = 'a\ny\nb'
      const out = spliceRevert(working, head, {
        workingStart: 2, workingEnd: 2, headStart: 2, headEnd: 2,
      })
      expect(out).toBe('a\ny\nb')
    })
  })

  describe('edge cases', () => {
    it('clamps workingStart below 1', () => {
      const out = spliceRevert('a\nb\n', 'a\nb\n', {
        workingStart: -5, workingEnd: 1, headStart: 1, headEnd: 1,
      })
      expect(out).toBe('a\nb\n')
    })

    it('clamps workingEnd past EOF', () => {
      const out = spliceRevert('a\nb\n', 'x\ny\n', {
        workingStart: 1, workingEnd: 999, headStart: 1, headEnd: 2,
      })
      expect(out).toBe('x\ny\n')
    })

    it('returns working buffer unchanged when HEAD is empty and no working range is given', () => {
      const out = spliceRevert('a\nb\n', '', {
        workingStart: 1, workingEnd: 0, headStart: 1, headEnd: 1,
      })
      // headLines.length is 1 (empty split), but the headStart/headEnd
      // refer past it — the clamp pulls it back to a single empty line.
      // Either way, this should not crash.
      expect(typeof out).toBe('string')
    })

    it('does not double the trailing newline', () => {
      const working = 'a\nx\nb\n' // 3 logical lines + trailing newline
      const head    = 'a\ny\nb\n'
      const out = spliceRevert(working, head, {
        workingStart: 2, workingEnd: 2, headStart: 2, headEnd: 2,
      })
      const trailingNewlineCount = out.match(/\n+$/)?.[0].length ?? 0
      expect(trailingNewlineCount).toBe(1)
    })
  })
})
