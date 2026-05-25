// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * file-state-cache.ts v5 coverage — closes all 14 un-exercised methods.
 * Pre-v5: LH=17/80 (new file, only constructor executed in existing suite).
 * This file adds tests for every public method, covering all 63 uncov lines.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'
import * as fs from 'fs'
import { FileStateCache } from '../file-state-cache'

let cache: FileStateCache
beforeEach(() => { cache = new FileStateCache() })

describe('markEditedThisTurn / getEditedThisTurn / resetTurn', () => {
  test('mark adds to set, get returns it', () => {
    cache.markEditedThisTurn('src/a.ts')
    cache.markEditedThisTurn('src/b.ts')
    expect(cache.getEditedThisTurn()).toContain('src/a.ts')
    expect(cache.getEditedThisTurn()).toContain('src/b.ts')
  })
  test('resetTurn clears the set', () => {
    cache.markEditedThisTurn('src/a.ts')
    cache.resetTurn()
    expect(cache.getEditedThisTurn()).toHaveLength(0)
  })
})

describe('recordRead', () => {
  test('stores a full read record', () => {
    cache.recordRead('src/a.ts', 1000.9, 42)
    const r = cache.getRecord('src/a.ts')!
    expect(r.path).toBe('src/a.ts')
    expect(r.mtime).toBe(1000)   // Math.floor applied
    expect(r.lineCount).toBe(42)
    expect(r.partial).toBeUndefined()
    expect(r.content).toBeUndefined()
  })
  test('stores a partial read with content=undefined', () => {
    cache.recordRead('src/b.ts', 2000, 100, { offset: 1, limit: 50 }, 'some content')
    const r = cache.getRecord('src/b.ts')!
    expect(r.partial).toEqual({ offset: 1, limit: 50 })
    expect(r.content).toBeUndefined()  // partial reads don't store content
  })
  test('full read supersedes a previous partial read', () => {
    cache.recordRead('src/c.ts', 1000, 100, { offset: 1, limit: 10 })
    cache.recordRead('src/c.ts', 1001, 100)  // full read
    const r = cache.getRecord('src/c.ts')!
    expect(r.partial).toBeUndefined()
  })
  test('stores full-read content', () => {
    cache.recordRead('src/d.ts', 1000, 5, undefined, 'hello')
    expect(cache.getRecord('src/d.ts')?.content).toBe('hello')
  })
})

describe('recordEdit', () => {
  test('stores edit record with computed lineCount', () => {
    cache.recordEdit('src/e.ts', 'line1\nline2\nline3', 5000.5)
    const r = cache.getRecord('src/e.ts')!
    expect(r.mtime).toBe(5000)
    expect(r.lineCount).toBe(3)
    expect(r.content).toBe('line1\nline2\nline3')
  })
})

describe('hasBeenRead / invalidate / size', () => {
  test('hasBeenRead returns false for unknown path', () => {
    expect(cache.hasBeenRead('nope.ts')).toBe(false)
  })
  test('hasBeenRead returns true after recordRead', () => {
    cache.recordRead('x.ts', 1, 1)
    expect(cache.hasBeenRead('x.ts')).toBe(true)
  })
  test('size reflects number of tracked files', () => {
    expect(cache.size).toBe(0)
    cache.recordRead('a.ts', 1, 1)
    cache.recordRead('b.ts', 2, 2)
    expect(cache.size).toBe(2)
  })
  test('invalidate removes the record', () => {
    cache.recordRead('x.ts', 1, 1)
    cache.invalidate('x.ts')
    expect(cache.hasBeenRead('x.ts')).toBe(false)
    expect(cache.size).toBe(0)
  })
})

describe('isStale', () => {
  test('returns false when path has no record', () => {
    expect(cache.isStale('unknown.ts', '/any/path')).toBe(false)
  })
  test('returns true when resolvedPath does not exist (catch branch)', () => {
    cache.recordRead('x.ts', 1000, 5)
    expect(cache.isStale('x.ts', '/nonexistent/xyz/abc')).toBe(true)
  })
  test('returns false when mtime matches', () => {
    const stat = fs.statSync('/tmp')
    const mtime = Math.floor(stat.mtimeMs)
    cache.recordRead('x.ts', mtime, 1)
    expect(cache.isStale('x.ts', '/tmp')).toBe(false)
  })
  test('returns true when mtime differs', () => {
    cache.recordRead('x.ts', 1, 1)   // mtime=1, /tmp has a real mtime != 1
    expect(cache.isStale('x.ts', '/tmp')).toBe(true)
  })
})

describe('getSummary', () => {
  test('returns empty string when no reads', () => {
    expect(cache.getSummary('/ws')).toBe('')
  })
  test('includes file entries in summary', () => {
    cache.recordRead('src/a.ts', 1, 10)
    const summary = cache.getSummary('/ws')
    expect(summary).toContain('Files Previously Read')
    expect(summary).toContain('src/a.ts')
    expect(summary).toContain('10 lines')
  })
  test('marks partial reads in summary', () => {
    cache.recordRead('src/b.ts', 1, 100, { offset: 5, limit: 20 })
    expect(cache.getSummary('/ws')).toContain('lines 5-25')
  })
  test('shows overflow message when >50 files', () => {
    for (let i = 0; i < 55; i++) cache.recordRead(`f${i}.ts`, i, i)
    expect(cache.getSummary('/ws')).toContain('more files')
  })
})

describe('clone', () => {
  test('clone produces an independent copy of reads', () => {
    cache.recordRead('a.ts', 1, 1)
    const cloned = cache.clone()
    expect(cloned.hasBeenRead('a.ts')).toBe(true)
    cloned.invalidate('a.ts')
    expect(cache.hasBeenRead('a.ts')).toBe(true)  // original unaffected
  })
  test('clone starts with empty editedThisTurn', () => {
    cache.markEditedThisTurn('z.ts')
    const cloned = cache.clone()
    expect(cloned.getEditedThisTurn()).toHaveLength(0)
  })
})

describe('clear', () => {
  test('clear wipes reads and editedThisTurn', () => {
    cache.recordRead('a.ts', 1, 1)
    cache.markEditedThisTurn('a.ts')
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.getEditedThisTurn()).toHaveLength(0)
  })
})
