// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { parseBlame } from '../blame'

function blameBlock(sha: string, finalLine: number, opts: { author: string; email: string; time: number; summary: string; body: string }): string {
  return [
    `${sha} ${finalLine} ${finalLine} 1`,
    `author ${opts.author}`,
    `author-mail <${opts.email}>`,
    `author-time ${opts.time}`,
    `author-tz +0000`,
    `committer ${opts.author}`,
    `committer-mail <${opts.email}>`,
    `committer-time ${opts.time}`,
    `committer-tz +0000`,
    `summary ${opts.summary}`,
    `filename foo.ts`,
    `\t${opts.body}`,
    '',
  ].join('\n')
}

describe('parseBlame', () => {
  it('parses a single line', () => {
    const stdout = blameBlock('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, {
      author: 'Alice', email: 'a@b.co', time: 1700000000, summary: 'first commit', body: 'const x = 1',
    })
    const out = parseBlame(stdout)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      line: 1,
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shortSha: 'aaaaaaa',
      author: 'Alice',
      authorEmail: 'a@b.co',
      authorTime: 1700000000,
      summary: 'first commit',
    })
  })

  it('deduplicates commit metadata across lines from the same commit', () => {
    const sha = 'b'.repeat(40)
    const stdout =
      blameBlock(sha, 1, { author: 'Bob', email: 'b@b.co', time: 100, summary: 'fix', body: 'line 1' }) +
      // subsequent header (no metadata block), then body
      `${sha} 2 2\n\tline 2\n`
    const out = parseBlame(stdout)
    expect(out).toHaveLength(2)
    expect(out[0].author).toBe('Bob')
    expect(out[1].author).toBe('Bob')
    expect(out[1].shortSha).toBe('bbbbbbb')
    expect(out[1].summary).toBe('fix')
  })

  it('handles multiple commits in the same file', () => {
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    const stdout =
      blameBlock(a, 1, { author: 'Alice', email: 'a@x', time: 1, summary: 'a', body: 'l1' }) +
      blameBlock(b, 2, { author: 'Bob', email: 'b@x', time: 2, summary: 'b', body: 'l2' })
    const out = parseBlame(stdout)
    expect(out).toHaveLength(2)
    expect(out[0].author).toBe('Alice')
    expect(out[1].author).toBe('Bob')
  })

  it('returns empty list for empty input', () => {
    expect(parseBlame('')).toEqual([])
  })

  it('skips header-without-body fragments without crashing', () => {
    const sha = 'c'.repeat(40)
    const stdout = `${sha} 1 1 1\nauthor X\nauthor-mail <x@x>\nauthor-time 1\nsummary s\n`
    // No body line (\t...) — should emit nothing rather than throw.
    expect(parseBlame(stdout)).toEqual([])
  })

  it('strips angle brackets from author-mail', () => {
    const out = parseBlame(blameBlock('d'.repeat(40), 1, {
      author: 'X', email: 'x@y.z', time: 1, summary: 's', body: 'b',
    }))
    expect(out[0].authorEmail).toBe('x@y.z')
  })
})
