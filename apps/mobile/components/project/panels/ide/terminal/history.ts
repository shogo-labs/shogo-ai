// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Free-form prompt history walker. Mirrors the behavior of bash readline
 * with ↑ / ↓: navigation is per-session, capped at 100 entries, and
 * consecutive duplicates collapse to a single entry.
 */

export const HISTORY_CAP = 100

/**
 * Append `entry` to `history`, deduping consecutive duplicates and
 * capping the list at `HISTORY_CAP`. Returns the same `history`
 * reference when the new entry was a no-op (consecutive duplicate) so
 * callers using strict-equality reconciliation can short-circuit.
 */
export function pushHistory(history: string[], entry: string): string[] {
  if (history[history.length - 1] === entry) return history
  const next = [...history, entry]
  return next.length > HISTORY_CAP ? next.slice(next.length - HISTORY_CAP) : next
}

export interface HistoryWalkResult {
  /** New cursor position; null means "back to live editing state". */
  index: number | null
  /** Value to populate the prompt with. Empty string when index is null. */
  value: string
}

/**
 * Compute the next prompt cursor + value when the user presses ↑ or ↓.
 *
 *   - dir 'up' from `null` jumps to the most recent entry.
 *   - dir 'up' at index 0 stays at 0 (clamped).
 *   - dir 'down' past the end resets to `null` + empty value.
 *   - dir 'down' from `null` is a no-op (cursor stays at null).
 */
export function walkHistory(
  history: string[],
  current: number | null,
  dir: 'up' | 'down',
): HistoryWalkResult | null {
  if (history.length === 0) return null

  if (dir === 'up') {
    const next = current === null ? history.length - 1 : Math.max(0, current - 1)
    return { index: next, value: history[next] ?? '' }
  }

  if (current === null) return null
  const next = current + 1
  if (next >= history.length) {
    return { index: null, value: '' }
  }
  return { index: next, value: history[next] ?? '' }
}
