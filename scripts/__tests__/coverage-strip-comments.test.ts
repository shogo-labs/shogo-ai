// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { classifySource, stripCommentLines } from '../coverage-strip-comments'

describe('classifySource', () => {
  test('marks blank lines as non-executable', () => {
    const out = classifySource('\n\n\n')
    expect(out.map((l) => l.executable)).toEqual([false, false, false, false])
  })
  test('marks single-line // comments as non-executable', () => {
    const out = classifySource('// hi\n// bye')
    expect(out.map((l) => l.executable)).toEqual([false, false])
  })
  test('marks block comments as non-executable across multiple lines', () => {
    const out = classifySource('/*\n * hello\n * world\n */')
    expect(out.map((l) => l.executable)).toEqual([false, false, false, false])
  })
  test('keeps executable line that ends with // trailing comment', () => {
    const out = classifySource('const x = 1 // assign')
    expect(out[0].executable).toBe(true)
  })
  test('keeps executable line that has block comment mid-line', () => {
    const out = classifySource('const y = /* mid */ 2')
    expect(out[0].executable).toBe(true)
  })
  test('treats `//` inside a string as part of the string, not a comment', () => {
    const out = classifySource('const s = "// not a comment"')
    expect(out[0].executable).toBe(true)
  })
  test('handles template literals', () => {
    const out = classifySource('const t = `// still a string`')
    expect(out[0].executable).toBe(true)
  })
  test('handles escape sequences inside strings', () => {
    const out = classifySource('const e = "a \\" b"')
    expect(out[0].executable).toBe(true)
  })
  test('mixed lines: code, then pure comment, then code', () => {
    const out = classifySource('let a = 1\n// comment\nreturn a')
    expect(out.map((l) => l.executable)).toEqual([true, false, true])
  })
})

describe('stripCommentLines', () => {
  test('drops DA: entries on pure comment lines and recomputes LF/LH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'strip-comments-'))
    try {
      const src = 'const x = 1\n// pure comment\nreturn x'
      writeFileSync(join(dir, 'sample.ts'), src)
      const lcov = [
        `SF:sample.ts`,
        `DA:1,1`,
        `DA:2,0`,
        `DA:3,1`,
        `LF:3`,
        `LH:2`,
        `BRF:0`,
        `BRH:0`,
        `end_of_record`,
        ``,
      ].join('\n')
      const { lcov: cleaned, before, after } = stripCommentLines(lcov, dir)
      expect(before.lines.total).toBe(3)
      expect(after.lines.total).toBe(2)
      expect(after.lines.hit).toBe(2)
      expect(after.scrubbedLineEntries).toBe(1)
      expect(cleaned).not.toContain('DA:2,0')
      expect(cleaned).toContain('LF:2')
      expect(cleaned).toContain('LH:2')
      rmSync(dir, { recursive: true, force: true })
    } catch (e) {
      rmSync(dir, { recursive: true, force: true })
      throw e
    }
  })
  test('does NOT scrub a hit line on a comment (paranoid: never demote)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'strip-comments-'))
    try {
      writeFileSync(join(dir, 's.ts'), '// comment\nlet a = 1')
      const lcov = `SF:s.ts\nDA:1,5\nDA:2,1\nLF:2\nLH:2\nBRF:0\nBRH:0\nend_of_record\n`
      const { lcov: cleaned, after } = stripCommentLines(lcov, dir)
      expect(after.scrubbedLineEntries).toBe(0)
      expect(cleaned).toContain('DA:1,5')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test('passes through unchanged when source file is missing', () => {
    const lcov = `SF:missing.ts\nDA:1,0\nLF:1\nLH:0\nBRF:0\nBRH:0\nend_of_record\n`
    const { lcov: cleaned, after } = stripCommentLines(lcov, '/nonexistent')
    expect(after.scrubbedLineEntries).toBe(0)
    expect(cleaned).toContain('DA:1,0')
  })
  test('handles lcov with multiple SF blocks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'strip-comments-'))
    try {
      writeFileSync(join(dir, 'a.ts'), '// c1\nconst x = 1')
      writeFileSync(join(dir, 'b.ts'), 'const y = 2\n// c2')
      const lcov =
        `SF:a.ts\nDA:1,0\nDA:2,1\nLF:2\nLH:1\nBRF:0\nBRH:0\nend_of_record\n` +
        `SF:b.ts\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nBRF:0\nBRH:0\nend_of_record\n`
      const { after } = stripCommentLines(lcov, dir)
      expect(after.scrubbedLineEntries).toBe(2)
      expect(after.lines.total).toBe(2)
      expect(after.lines.hit).toBe(2)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
