// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pure reducer + helpers for the multi-tab Terminal session list.
 *
 * Each tab owns its own output buffer, prompt history, in-flight command,
 * and synthetic-shell `cwd` / `prevCwd` (so `cd -` works across independent
 * `bash -c` invocations). Labels are derived from the tab's *position*,
 * not its id, so closing tab #2 leaves "Terminal 1, 2" rather than
 * "Terminal 1, 3".
 */

export interface Session {
  id: string
  output: string
  /** Non-null while a command (preset or free-form) is streaming. */
  runningCmdId: string | null
  /** AbortController held alongside the running command so callers can cancel. */
  abort: AbortController | null
  /** Free-form prompt history, oldest → newest. */
  history: string[]
  /**
   * Synthetic-shell cwd. `null` means "server default" (project workspace
   * root) — we resolve it lazily on first command. Updated from the
   * out-of-band metadata trailer after every command.
   */
  cwd: string | null
  /** Previous cwd so `cd -` survives across independent `bash -c` calls. */
  prevCwd: string | null
}

let _idSeq = 0

/**
 * Test hook — reset the id sequence so test cases produce stable ids
 * across runs without leaking module state.
 */
export function __resetSessionIdSeqForTest(): void {
  _idSeq = 0
}

export function makeSession(): Session {
  return {
    id: `t-${Date.now().toString(36)}-${++_idSeq}`,
    output: '',
    runningCmdId: null,
    abort: null,
    history: [],
    cwd: null,
    prevCwd: null,
  }
}

/**
 * `Map<sessionId, "Terminal N">` derived from the array's current order.
 * Re-derive on every render so positional labels stay correct after
 * close.
 */
export function labelsFor(sessions: Session[]): Map<string, string> {
  return new Map(sessions.map((s, i) => [s.id, `Terminal ${i + 1}`]))
}

export interface CloseResult {
  sessions: Session[]
  /** New active session id, or null if the caller should keep the current id. */
  nextActiveId: string | null
  /** True if the caller should treat this as "panel closed entirely". */
  panelDismissed: boolean
}

/**
 * Compute the new sessions array + active-id transitions when a tab is
 * closed. Closing the *last* tab dismisses the entire panel (matching
 * VS Code's "X = close this thing" intent). Closing a non-active middle
 * tab leaves the active id unchanged. Closing the active tab moves to
 * the right neighbor (or left if we were at the end).
 *
 * Aborting the closed tab's in-flight command is the caller's
 * responsibility — this reducer is pure.
 */
export function closeSession(
  sessions: Session[],
  id: string,
  activeId: string,
): CloseResult {
  const idx = sessions.findIndex((s) => s.id === id)
  if (idx === -1) {
    return { sessions, nextActiveId: null, panelDismissed: false }
  }
  const next = sessions.filter((s) => s.id !== id)
  if (next.length === 0) {
    // The caller seeds a fresh session for the next reopen; it picks the
    // id so we just signal `panelDismissed`.
    return { sessions: next, nextActiveId: null, panelDismissed: true }
  }
  if (id === activeId) {
    const neighbour = next[Math.min(idx, next.length - 1)]
    return { sessions: next, nextActiveId: neighbour.id, panelDismissed: false }
  }
  return { sessions: next, nextActiveId: null, panelDismissed: false }
}

/** Append a new session and return the updated array. */
export function addSession(sessions: Session[], created: Session): Session[] {
  return [...sessions, created]
}

/**
 * Apply a per-session patch immutably. Sessions that don't match `id` are
 * returned by reference so React's reconciliation can short-circuit.
 */
export function patchSession(
  sessions: Session[],
  id: string,
  patch: (s: Session) => Session,
): Session[] {
  return sessions.map((s) => (s.id === id ? patch(s) : s))
}
