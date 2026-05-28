// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import {
  dropDataFromEvent,
  formatDropPaths,
  posixQuote,
  quotePaths,
} from '../drag-drop-paste'

// ─── posixQuote ────────────────────────────────────────────────────

describe('posixQuote', () => {
  it('passes through safe tokens', () => {
    expect(posixQuote('foo')).toBe('foo')
    expect(posixQuote('/tmp/foo.txt')).toBe('/tmp/foo.txt')
    expect(posixQuote('build-output_v2.tar.gz')).toBe('build-output_v2.tar.gz')
    expect(posixQuote('host:port')).toBe('host:port')
  })

  it('quotes tokens with spaces', () => {
    expect(posixQuote('/tmp/My Documents/file.txt')).toBe("'/tmp/My Documents/file.txt'")
  })

  it('quotes tokens with shell metacharacters', () => {
    expect(posixQuote('a;b')).toBe("'a;b'")
    expect(posixQuote('a$b')).toBe("'a$b'")
    expect(posixQuote('a&b')).toBe("'a&b'")
    expect(posixQuote('a|b')).toBe("'a|b'")
    expect(posixQuote('a(b)c')).toBe("'a(b)c'")
  })

  it('escapes embedded single quotes with the standard idiom', () => {
    expect(posixQuote("it's a file")).toBe("'it'\\''s a file'")
  })

  it('quotes the empty string as ""', () => {
    expect(posixQuote('')).toBe("''")
  })
})

// ─── quotePaths ────────────────────────────────────────────────────

describe('quotePaths', () => {
  it('joins quoted paths with spaces, no trailing space', () => {
    expect(quotePaths(['/a/b', '/c d/e'])).toBe("/a/b '/c d/e'")
  })

  it('returns empty string for empty input', () => {
    expect(quotePaths([])).toBe('')
  })
})

// ─── formatDropPaths ──────────────────────────────────────────────

describe('formatDropPaths', () => {
  it('formats a single file path with trailing space', () => {
    const r = formatDropPaths({ files: [{ name: 'foo.txt', path: '/tmp/foo.txt' }] })
    expect(r).toEqual({ payload: '/tmp/foo.txt ', pathCount: 1, source: 'files' })
  })

  it('quotes paths with spaces', () => {
    const r = formatDropPaths({ files: [{ name: 'My File.txt', path: '/tmp/My File.txt' }] })
    expect(r.payload).toBe("'/tmp/My File.txt' ")
    expect(r.pathCount).toBe(1)
  })

  it('joins multiple paths', () => {
    const r = formatDropPaths({
      files: [
        { name: 'a.txt', path: '/a.txt' },
        { name: 'b.txt', path: '/b.txt' },
      ],
    })
    expect(r.payload).toBe('/a.txt /b.txt ')
    expect(r.pathCount).toBe(2)
  })

  it('skips empty paths but counts the survivors', () => {
    const r = formatDropPaths({
      files: [
        { name: 'a.txt', path: '/a.txt' },
        { name: 'no-path', path: '' },
        { name: 'b.txt', path: '/b.txt' },
      ],
    })
    expect(r.payload).toBe('/a.txt /b.txt ')
    expect(r.pathCount).toBe(2)
  })

  it('falls back to text/plain when files have no usable paths', () => {
    const r = formatDropPaths({
      files: [{ name: 'no-path', path: '' }],
      text: 'hello world',
    })
    expect(r).toEqual({ payload: 'hello world ', pathCount: 0, source: 'text' })
  })

  it('emits empty payload for empty drops', () => {
    expect(formatDropPaths({})).toEqual({ payload: '', pathCount: 0, source: 'empty' })
    expect(formatDropPaths({ files: [], text: '' })).toEqual({ payload: '', pathCount: 0, source: 'empty' })
  })

  it('does not quote text/plain content (literal preserved)', () => {
    const r = formatDropPaths({ text: 'echo $HOME' })
    expect(r.payload).toBe('echo $HOME ')
    expect(r.source).toBe('text')
  })

  it('preserves Windows backslash paths verbatim', () => {
    const r = formatDropPaths({ files: [{ name: 'foo.txt', path: 'C:\\Users\\Bob\\foo.txt' }] })
    expect(r.payload).toBe("'C:\\Users\\Bob\\foo.txt' ")
  })
})

// ─── dropDataFromEvent ────────────────────────────────────────────

describe('dropDataFromEvent', () => {
  function fakeFile(name: string, path: string): File {
    return { name, path } as unknown as File
  }

  function makeDT(files: File[], text: string | null = null): { dataTransfer: DataTransfer } {
    const list = {
      length: files.length,
      item: (i: number) => files[i] ?? null,
    } as unknown as FileList
    const dt = {
      files: list,
      getData: (kind: string) => kind === 'text/plain' ? (text ?? '') : '',
    } as unknown as DataTransfer
    return { dataTransfer: dt }
  }

  it('extracts files with their paths', () => {
    const ev = makeDT([fakeFile('a.txt', '/tmp/a.txt'), fakeFile('b.txt', '/tmp/b.txt')])
    const d = dropDataFromEvent(ev)
    expect(d.files).toHaveLength(2)
    expect(d.files![0]!.path).toBe('/tmp/a.txt')
    expect(d.files![1]!.path).toBe('/tmp/b.txt')
  })

  it('falls back to file.name when File.path is missing', () => {
    const ev = makeDT([fakeFile('a.txt', '')])
    const d = dropDataFromEvent(ev)
    expect(d.files![0]!.path).toBe('a.txt')
  })

  it('reads text/plain when present', () => {
    const ev = makeDT([], 'hello')
    const d = dropDataFromEvent(ev)
    expect(d.text).toBe('hello')
  })

  it('returns empty object for events without dataTransfer', () => {
    expect(dropDataFromEvent({ dataTransfer: null })).toEqual({})
  })

  it('survives getData throwing', () => {
    const ev = { dataTransfer: {
      files: { length: 0, item: () => null } as unknown as FileList,
      getData: () => { throw new Error('not allowed') },
    } as unknown as DataTransfer }
    const d = dropDataFromEvent(ev)
    expect(d).toEqual({})
  })
})
