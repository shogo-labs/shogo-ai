// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { EMPTY_SELECTION, handleKey, targetIds, toggleSelected, type KeyInput, type SelectionState } from '../work-selection'

const ids = ['a', 'b', 'c', 'd']

function press(state: SelectionState, ...keys: KeyInput[]): SelectionState {
  return keys.reduce((s, k) => handleKey(s, ids, k).state, state)
}

describe('handleKey', () => {
  test('arrows move the cursor and stop at the ends', () => {
    expect(press(EMPTY_SELECTION, { key: 'ArrowDown' }).cursor).toBe(0)
    expect(press(EMPTY_SELECTION, { key: 'ArrowUp' }).cursor).toBe(3)
    expect(press(EMPTY_SELECTION, { key: 'ArrowDown' }, { key: 'ArrowDown' }, { key: 'ArrowDown' }, { key: 'ArrowDown' }, { key: 'ArrowDown' }).cursor).toBe(3)
  })

  test('shift + arrows select a range from where it started, in both directions', () => {
    const start = press(EMPTY_SELECTION, { key: 'ArrowDown' }, { key: 'ArrowDown' })
    const down = press(start, { key: 'ArrowDown', shiftKey: true }, { key: 'ArrowDown', shiftKey: true })
    expect(down.selected).toEqual(['b', 'c', 'd'])
    const back = press(down, { key: 'ArrowUp', shiftKey: true }, { key: 'ArrowUp', shiftKey: true }, { key: 'ArrowUp', shiftKey: true })
    expect(back.selected).toEqual(['a', 'b'])
  })

  test('cmd+A selects all and Esc clears', () => {
    const all = press(EMPTY_SELECTION, { key: 'a', metaKey: true })
    expect(all.selected).toEqual(ids)
    expect(press(all, { key: 'Escape' }).selected).toEqual([])
    expect(handleKey(EMPTY_SELECTION, ids, { key: 'Escape' }).handled).toBe(false)
  })

  test('A, P and S act on the selection, or the row under the cursor', () => {
    expect(handleKey(EMPTY_SELECTION, ids, { key: 'a' }).action).toBeUndefined()
    const cursor = press(EMPTY_SELECTION, { key: 'ArrowDown' })
    expect(handleKey(cursor, ids, { key: 'a' }).action).toBe('assign')
    expect(handleKey(cursor, ids, { key: 'P' }).action).toBe('priority')
    expect(handleKey(cursor, ids, { key: 's' }).action).toBe('status')
    expect(handleKey(cursor, ids, { key: 'Enter' }).action).toBe('open')
    expect(targetIds(cursor, ids)).toEqual(['a'])
    expect(targetIds({ ...cursor, selected: ['c', 'gone'] }, ids)).toEqual(['c'])
  })

  test('alt+shift+F clears filters; other modified keys pass through', () => {
    expect(handleKey(EMPTY_SELECTION, ids, { key: 'F', altKey: true, shiftKey: true }).action).toBe('clearFilters')
    expect(handleKey(EMPTY_SELECTION, ids, { key: 'c', metaKey: true }).handled).toBe(false)
  })

  test('space and clicks toggle one row', () => {
    const cursor = press(EMPTY_SELECTION, { key: 'ArrowDown' })
    expect(press(cursor, { key: ' ' }).selected).toEqual(['a'])
    expect(press(cursor, { key: ' ' }, { key: ' ' }).selected).toEqual([])
    expect(toggleSelected(EMPTY_SELECTION, 'c', 2)).toEqual({ cursor: 2, anchor: 2, selected: ['c'] })
  })
})
