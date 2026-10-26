// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Keyboard selection for a list of cards: arrows move the cursor, Shift +
 * arrows extend the selection from where it started, Cmd/Ctrl+A selects all,
 * Esc clears. A, P and S ask for a bulk assignee, priority or status.
 */

export interface SelectionState {
  /** Index of the row with the cursor, or -1 before the first keypress. */
  cursor: number
  /** Where a Shift range started. */
  anchor: number
  selected: string[]
}

export const EMPTY_SELECTION: SelectionState = { cursor: -1, anchor: -1, selected: [] }

export type BulkAction = 'assign' | 'priority' | 'status' | 'open' | 'clearFilters'

export interface KeyInput {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}

export interface KeyResult {
  state: SelectionState
  action?: BulkAction
  /** The key was ours; stop the browser from scrolling or selecting text. */
  handled: boolean
}

function range(ids: string[], a: number, b: number): string[] {
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return ids.slice(lo, hi + 1)
}

/** The rows an action applies to: the selection, or the row under the cursor. */
export function targetIds(state: SelectionState, ids: string[]): string[] {
  if (state.selected.length) return state.selected.filter((id) => ids.includes(id))
  const id = ids[state.cursor]
  return id ? [id] : []
}

export function handleKey(state: SelectionState, ids: string[], input: KeyInput): KeyResult {
  const mod = !!(input.metaKey || input.ctrlKey)
  const last = ids.length - 1
  if (input.key === 'ArrowDown' || input.key === 'ArrowUp') {
    if (!ids.length) return { state, handled: true }
    const step = input.key === 'ArrowDown' ? 1 : -1
    const cursor = state.cursor < 0 ? (step > 0 ? 0 : last) : Math.max(0, Math.min(last, state.cursor + step))
    if (input.shiftKey) {
      const anchor = state.anchor >= 0 ? state.anchor : state.cursor >= 0 ? state.cursor : cursor
      return { state: { cursor, anchor, selected: range(ids, anchor, cursor) }, handled: true }
    }
    return { state: { cursor, anchor: -1, selected: state.selected }, handled: true }
  }
  if (mod && input.key.toLowerCase() === 'a') {
    return { state: { ...state, selected: ids.slice() }, handled: true }
  }
  if (input.key === 'Escape') {
    return { state: { cursor: state.cursor, anchor: -1, selected: [] }, handled: state.selected.length > 0 }
  }
  if (input.key === ' ' && state.cursor >= 0) {
    const id = ids[state.cursor]!
    const selected = state.selected.includes(id) ? state.selected.filter((x) => x !== id) : [...state.selected, id]
    return { state: { ...state, selected }, handled: true }
  }
  if (mod) return { state, handled: false }
  if (input.altKey && input.shiftKey && input.key.toLowerCase() === 'f') return { state, action: 'clearFilters', handled: true }
  if (input.altKey) return { state, handled: false }
  const hasTarget = targetIds(state, ids).length > 0
  const actions: Record<string, BulkAction> = { a: 'assign', p: 'priority', s: 'status' }
  const action = actions[input.key.toLowerCase()]
  if (action && hasTarget) return { state, action, handled: true }
  if (input.key === 'Enter' && state.cursor >= 0) return { state, action: 'open', handled: true }
  return { state, handled: false }
}

export function toggleSelected(state: SelectionState, id: string, index: number): SelectionState {
  const selected = state.selected.includes(id) ? state.selected.filter((x) => x !== id) : [...state.selected, id]
  return { cursor: index, anchor: index, selected }
}
