// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Keyboard handling for trigger menus ("@", ":"), shared by the composer and
 * the doc editor so both menus behave the same.
 */

export type MenuKeyResult =
  | { type: 'none' }
  | { type: 'move'; index: number }
  | { type: 'select'; index: number }
  | { type: 'close' }
  | { type: 'back' }

export interface MenuKeyState {
  index: number
  count: number
  /** Inside a category, so Left / Backspace on an empty query go back up. */
  canGoBack: boolean
  queryEmpty: boolean
}

export function completionMenuKey(key: string, state: MenuKeyState): MenuKeyResult {
  const { index, count, canGoBack, queryEmpty } = state
  switch (key) {
    case 'ArrowDown':
      return count ? { type: 'move', index: (index + 1) % count } : { type: 'none' }
    case 'ArrowUp':
      return count ? { type: 'move', index: (index - 1 + count) % count } : { type: 'none' }
    case 'Enter':
    case 'Tab':
      return count ? { type: 'select', index: Math.min(index, count - 1) } : { type: 'none' }
    case 'Escape':
      return { type: 'close' }
    case 'ArrowLeft':
      return canGoBack ? { type: 'back' } : { type: 'none' }
    case 'Backspace':
      return canGoBack && queryEmpty ? { type: 'back' } : { type: 'none' }
    default:
      return { type: 'none' }
  }
}
