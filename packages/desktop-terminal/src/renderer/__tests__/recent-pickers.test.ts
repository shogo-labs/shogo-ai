// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the recent-picker reducer. The hooks (useCommandPicker /
 * useDirectoryPicker) are exercised when apps/desktop integrates;
 * here we own the state machine via the pure reducer.
 */

import { describe, it, expect } from 'bun:test'
import { pickerReducer, type PickerState } from '../pickers/recent-pickers'

interface Entry { id: string; command: string }

const initial: PickerState<Entry> = { isOpen: false, query: '', entries: [], highlight: -1 }

const entries: Entry[] = [
  { id: '1', command: 'a' },
  { id: '2', command: 'b' },
  { id: '3', command: 'c' },
]

// ─── open + close ──────────────────────────────────────────────────

describe('pickerReducer — open + close', () => {
  it('open sets isOpen, populates entries, highlights first', () => {
    const s = pickerReducer(initial, { kind: 'open', entries })
    expect(s.isOpen).toBe(true)
    expect(s.entries).toBe(entries)
    expect(s.highlight).toBe(0)
    expect(s.query).toBe('')
  })

  it('open with zero entries sets highlight to -1', () => {
    const s = pickerReducer(initial, { kind: 'open', entries: [] })
    expect(s.isOpen).toBe(true)
    expect(s.highlight).toBe(-1)
  })

  it('close clears entries, query, and highlight', () => {
    const open = pickerReducer(initial, { kind: 'open', entries })
    const s = pickerReducer(open, { kind: 'close' })
    expect(s.isOpen).toBe(false)
    expect(s.entries).toEqual([])
    expect(s.highlight).toBe(-1)
    expect(s.query).toBe('')
  })
})

// ─── set-query ────────────────────────────────────────────────────

describe('pickerReducer — set-query', () => {
  it('stores the query and entries; resets highlight to 0', () => {
    const open = pickerReducer(initial, { kind: 'open', entries })
    // Pretend the user moved before retyping.
    const moved = pickerReducer(open, { kind: 'move', delta: 2 })
    const s = pickerReducer(moved, { kind: 'set-query', query: 'b', entries: [entries[1]!] })
    expect(s.query).toBe('b')
    expect(s.entries).toEqual([entries[1]])
    expect(s.highlight).toBe(0)
  })

  it('sets highlight to -1 when filtered entries are empty', () => {
    const open = pickerReducer(initial, { kind: 'open', entries })
    const s = pickerReducer(open, { kind: 'set-query', query: 'zzz', entries: [] })
    expect(s.entries).toEqual([])
    expect(s.highlight).toBe(-1)
  })
})

// ─── move (with wrap) ────────────────────────────────────────────

describe('pickerReducer — move', () => {
  it('moves +1 within bounds', () => {
    const open = pickerReducer(initial, { kind: 'open', entries })
    expect(pickerReducer(open, { kind: 'move', delta: 1 }).highlight).toBe(1)
  })

  it('wraps below 0 to last', () => {
    const open = pickerReducer(initial, { kind: 'open', entries })
    expect(pickerReducer(open, { kind: 'move', delta: -1 }).highlight).toBe(entries.length - 1)
  })

  it('wraps past last to 0', () => {
    const open = pickerReducer(initial, { kind: 'open', entries })
    const last = pickerReducer(open, { kind: 'move', delta: entries.length - 1 })
    expect(pickerReducer(last, { kind: 'move', delta: 1 }).highlight).toBe(0)
  })

  it('handles large positive + negative deltas via wrap', () => {
    const open = pickerReducer(initial, { kind: 'open', entries })
    expect(pickerReducer(open, { kind: 'move', delta: 7 }).highlight).toBe(7 % entries.length)
    expect(pickerReducer(open, { kind: 'move', delta: -7 }).highlight).toBe(((-7 % entries.length) + entries.length) % entries.length)
  })

  it('is a no-op when entries are empty', () => {
    const open = pickerReducer(initial, { kind: 'open', entries: [] })
    const s = pickerReducer(open, { kind: 'move', delta: 1 })
    expect(s.highlight).toBe(-1)
  })
})

// ─── invariants ──────────────────────────────────────────────────

describe('pickerReducer — invariants', () => {
  it('reducer never returns undefined fields', () => {
    let s: PickerState<Entry> = initial
    s = pickerReducer(s, { kind: 'open', entries })
    s = pickerReducer(s, { kind: 'set-query', query: 'foo', entries: entries.slice(0, 2) })
    s = pickerReducer(s, { kind: 'move', delta: 1 })
    s = pickerReducer(s, { kind: 'close' })
    expect(s.isOpen).toBe(false)
    expect(typeof s.query).toBe('string')
    expect(Array.isArray(s.entries)).toBe(true)
    expect(typeof s.highlight).toBe('number')
  })
})
