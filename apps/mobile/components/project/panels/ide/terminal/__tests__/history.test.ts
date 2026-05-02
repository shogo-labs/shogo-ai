// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { HISTORY_CAP, pushHistory, walkHistory } from '../history'

describe('pushHistory', () => {
  test('appends a new entry', () => {
    expect(pushHistory([], 'ls')).toEqual(['ls'])
    expect(pushHistory(['ls'], 'pwd')).toEqual(['ls', 'pwd'])
  })

  test('dedupes consecutive duplicates by returning the same reference', () => {
    const before = ['ls']
    const after = pushHistory(before, 'ls')
    expect(after).toBe(before)
  })

  test('does NOT dedupe a non-consecutive duplicate', () => {
    expect(pushHistory(['ls', 'pwd'], 'ls')).toEqual(['ls', 'pwd', 'ls'])
  })

  test('caps history at HISTORY_CAP, dropping the oldest entries', () => {
    const big = Array.from({ length: HISTORY_CAP }, (_, i) => `cmd${i}`)
    const after = pushHistory(big, 'new')
    expect(after).toHaveLength(HISTORY_CAP)
    expect(after[0]).toBe('cmd1')
    expect(after[after.length - 1]).toBe('new')
  })
})

describe('walkHistory', () => {
  test('returns null on an empty history regardless of direction', () => {
    expect(walkHistory([], null, 'up')).toBeNull()
    expect(walkHistory([], null, 'down')).toBeNull()
    expect(walkHistory([], 0, 'up')).toBeNull()
  })

  test('arrow up from null jumps to the most recent entry', () => {
    const r = walkHistory(['a', 'b', 'c'], null, 'up')
    expect(r).toEqual({ index: 2, value: 'c' })
  })

  test('arrow up walks backwards through history', () => {
    const r = walkHistory(['a', 'b', 'c'], 2, 'up')
    expect(r).toEqual({ index: 1, value: 'b' })
  })

  test('arrow up at index 0 stays at index 0 (clamp)', () => {
    expect(walkHistory(['a', 'b'], 0, 'up')).toEqual({ index: 0, value: 'a' })
  })

  test('arrow down from null is a no-op (returns null)', () => {
    expect(walkHistory(['a', 'b'], null, 'down')).toBeNull()
  })

  test('arrow down walks forward', () => {
    expect(walkHistory(['a', 'b', 'c'], 0, 'down')).toEqual({ index: 1, value: 'b' })
  })

  test('arrow down past the last entry resets to null + empty value', () => {
    expect(walkHistory(['a', 'b'], 1, 'down')).toEqual({ index: null, value: '' })
  })
})
