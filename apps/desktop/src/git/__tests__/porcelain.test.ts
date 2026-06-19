// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { parsePorcelainV2, shortCode } from '../porcelain'

describe('parsePorcelainV2', () => {
  it('returns an empty snapshot when input is empty', () => {
    const r = parsePorcelainV2('')
    expect(r).toEqual({
      branch: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
    })
  })

  it('parses branch + upstream + ahead/behind headers', () => {
    const stdout = [
      '# branch.oid abcdef1234567890abcdef1234567890abcdef12',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +3 -1',
      '',
    ].join('\n')
    const r = parsePorcelainV2(stdout)
    expect(r.branch).toBe('main')
    expect(r.detached).toBe(false)
    expect(r.upstream).toBe('origin/main')
    expect(r.ahead).toBe(3)
    expect(r.behind).toBe(1)
  })

  it('marks detached HEAD', () => {
    const r = parsePorcelainV2('# branch.head (detached)\n')
    expect(r.branch).toBe('(detached)')
    expect(r.detached).toBe(true)
  })

  it('parses a tracked-file modified entry', () => {
    // `1 .M N... 100644 100644 100644 <hH> <hI> path`
    const entry = '1 .M N... 100644 100644 100644 0000000 0000000 src/foo.ts'
    const r = parsePorcelainV2(`# branch.head main\n${entry}\0`)
    expect(r.files).toHaveLength(1)
    expect(r.files[0]).toMatchObject({
      path: 'src/foo.ts',
      index: 'unmodified',
      working: 'modified',
      isConflict: false,
      isDirty: true,
    })
  })

  it('parses an untracked entry', () => {
    const stdout = '# branch.head main\n? src/new.ts\0'
    const r = parsePorcelainV2(stdout)
    expect(r.files).toHaveLength(1)
    expect(r.files[0]).toMatchObject({
      path: 'src/new.ts',
      working: 'untracked',
      isDirty: true,
    })
  })

  it('parses an ignored entry', () => {
    const r = parsePorcelainV2('! dist/build.js\0')
    expect(r.files[0]).toMatchObject({
      path: 'dist/build.js',
      working: 'ignored',
      isDirty: false,
    })
  })

  it('parses an unmerged conflict entry', () => {
    // `u UU N... <m1> <m2> <m3> <mW> <h1> <h2> <h3> path`
    const entry = 'u UU N... 100644 100644 100644 100644 0 0 0 src/conflict.ts'
    const r = parsePorcelainV2(`${entry}\0`)
    expect(r.files[0]).toMatchObject({
      path: 'src/conflict.ts',
      isConflict: true,
      isDirty: true,
    })
  })

  it('parses a rename (type 2) entry and pulls out the original path', () => {
    // `2 R. N... ... R100 newpath\0oldpath`
    const entry = '2 R. N... 100644 100644 100644 0 0 R100 src/new.ts'
    const r = parsePorcelainV2(`${entry}\0src/old.ts\0`)
    expect(r.files).toHaveLength(1)
    expect(r.files[0]).toMatchObject({
      path: 'src/new.ts',
      originalPath: 'src/old.ts',
      index: 'renamed',
    })
  })

  it('parses paths with spaces (NUL-delimited, so spaces are fine)', () => {
    const entry = '1 .M N... 100644 100644 100644 0 0 src/has space/foo bar.ts'
    const r = parsePorcelainV2(`${entry}\0`)
    expect(r.files[0].path).toBe('src/has space/foo bar.ts')
  })

  it('mixes header lines and NUL-delimited entries safely', () => {
    const stdout =
      '# branch.head feature\n' +
      '# branch.upstream origin/feature\n' +
      '? new.ts\0' +
      '1 M. N... 100644 100644 100644 0 0 changed.ts\0'
    const r = parsePorcelainV2(stdout)
    expect(r.branch).toBe('feature')
    expect(r.files.map((f) => f.path)).toEqual(['new.ts', 'changed.ts'])
  })
})

describe('shortCode', () => {
  it('returns U for conflicts', () => {
    expect(shortCode({ path: '', index: 'modified', working: 'modified', isConflict: true, isDirty: true })).toBe('U')
  })

  it('prefers working over index', () => {
    expect(shortCode({ path: '', index: 'unmodified', working: 'modified', isConflict: false, isDirty: true })).toBe('M')
    expect(shortCode({ path: '', index: 'added', working: 'unmodified', isConflict: false, isDirty: true })).toBe('A')
  })

  it('falls back to · for clean entries', () => {
    expect(shortCode({ path: '', index: 'unmodified', working: 'unmodified', isConflict: false, isDirty: false })).toBe('·')
  })

  it('maps untracked to U and ignored explicitly', () => {
    expect(shortCode({ path: '', index: 'unmodified', working: 'untracked', isConflict: false, isDirty: true })).toBe('U')
    expect(shortCode({ path: '', index: 'ignored', working: 'ignored', isConflict: false, isDirty: false })).toBe('!')
  })
})
