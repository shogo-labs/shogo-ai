// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pure reducer + helpers for the multi-tab Terminal session list.
 *
 * Each tab holds the React-side bookkeeping for one PTY shell. The actual
 * shell + scrollback live on the server (see `packages/agent-runtime/src/
 * pty-session.ts`); the tab keeps a `PtyClient` that owns its WebSocket
 * and an `XtermView` that owns the rendering.
 *
 * Labels are derived from the tab's *position*, not its id, so closing
 * tab #2 leaves "Terminal 1, 2" rather than "Terminal 1, 3".
 */

import type { PtyClientLike } from './pty-factory'

export type SessionStatus = 'creating' | 'ready' | 'error' | 'closed'

export interface Session {
  /** Stable client-side id; survives across remounts. */
  id: string
  /**
   * Server-allocated PTY session id. `null` while the create REST call is
   * in flight; non-null once we own a real shell on the server.
   */
  ptySessionId: string | null
  /** WebSocket wrapper. Constructed once we have `ptySessionId`. */
  client: PtyClientLike | null
  status: SessionStatus
  /** Surfaced when status === 'error' (REST 4xx/5xx, WS dead, etc.). */
  errorMessage: string | null
  /**
   * Last seen exit info (after the shell has exited). Kept for UI display
   * so a closed tab shows "[exited 0]" until the user dismisses it.
   */
  exit: { code: number | null; signal: string | null } | null
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
    ptySessionId: null,
    client: null,
    status: 'creating',
    errorMessage: null,
    exit: null,
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
 * Tearing down the closed tab's PtyClient + DELETE'ing the server PTY
 * is the caller's responsibility — this reducer is pure.
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

// Re-export so callers can keep their existing import sites.
export type { PtyClientLike }
