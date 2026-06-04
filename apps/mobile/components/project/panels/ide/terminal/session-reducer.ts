// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pure reducer + helpers for the multi-tab Terminal session list.
 *
 * Each session holds the React-side bookkeeping for one PTY shell. The
 * actual shell + scrollback live on the server (see `packages/agent-runtime/
 * src/pty-session.ts`); the session keeps a `PtyClient` that owns its
 * WebSocket and an `XtermView` that owns the rendering.
 *
 * Tabs vs. splits (VS Code parity):
 *   - A *tab* is a group of one or more sessions that share a `groupId`.
 *   - "New Terminal" creates a session in a brand-new group → a new tab.
 *   - "Split Terminal" adds a session to the active session's group → a
 *     second pane shown side-by-side inside the same tab.
 *
 * Labels are derived from a group's *position*, not its id, so closing
 * tab #2 leaves "Terminal 1, 2" rather than "Terminal 1, 3".
 */

import type { PtyClientLike } from './pty-factory'

export type SessionStatus = 'creating' | 'ready' | 'error' | 'closed'

export interface Session {
  /** Stable client-side id; survives across remounts. */
  id: string
  /**
   * Tab grouping id. Sessions that share a `groupId` live in the same tab
   * and render side-by-side as splits. "New Terminal" mints a fresh group;
   * "Split Terminal" reuses the active session's group.
   */
  groupId: string
  /**
   * Server-allocated PTY session id. `null` while the create REST call is
   * in flight; non-null once we own a real shell on the server.
   */
  ptySessionId: string | null
  /** WebSocket wrapper. Constructed once we have `ptySessionId`. */
  client: PtyClientLike | null
  status: SessionStatus
  /** Current working directory shown in the terminal chrome. */
  cwd: string | null
  /** Surfaced when status === 'error' (REST 4xx/5xx, WS dead, etc.). */
  errorMessage: string | null
  /**
   * Last seen exit info (after the shell has exited). Kept for UI display
   * so a closed tab shows "[exited 0]" until the user dismisses it.
   */
  exit: { code: number | null; signal: string | null } | null
  /**
   * User-chosen label that overrides the positional "Terminal N" name.
   * Stored per-session but every pane in a group shares the same value
   * (renameGroup writes to all of them). `null` falls back to the
   * positional label. Empty strings are normalised to `null` by the
   * reducer.
   */
  customLabel: string | null
  /**
   * Optional accent color (CSS hex like `#0078d4`) for this tab/group.
   * Like `customLabel`, stored per-session but kept in sync across every
   * pane in a group by `setTabColor`. `null` means "use the theme's
   * default accent". Anything that doesn't match `/^#[0-9a-fA-F]{6}$/`
   * is normalised to `null` on write.
   */
  tabColor: string | null
  /** Agent-spawned (∞ Shogo) background terminal — read-only tab. */
  isAgentTerminal?: boolean
}

let _idSeq = 0
let _groupSeq = 0

/**
 * Test hook — reset the id sequence so test cases produce stable ids
 * across runs without leaking module state.
 */
export function __resetSessionIdSeqForTest(): void {
  _idSeq = 0
  _groupSeq = 0
}

/**
 * Create a session. Pass an existing `groupId` to add it as a split inside
 * that tab; omit it to mint a brand-new group (a new tab).
 */
export function makeSession(groupId?: string): Session {
  return {
    id: `t-${Date.now().toString(36)}-${++_idSeq}`,
    groupId: groupId ?? `g-${Date.now().toString(36)}-${++_groupSeq}`,
    ptySessionId: null,
    client: null,
    status: 'creating',
    cwd: null,
    errorMessage: null,
    exit: null,
    customLabel: null,
    tabColor: null,
    isAgentTerminal: false,
  }
}

/** Attach UI to an agent-spawned PTY session (already running in the host). */
export function makeAgentSession(opts: {
  ptySessionId: string
  label: string
  cwd?: string | null
}): Session {
  const s = makeSession()
  return {
    ...s,
    ptySessionId: opts.ptySessionId,
    customLabel: opts.label,
    cwd: opts.cwd ?? null,
    isAgentTerminal: true,
  }
}

/**
 * 6-digit CSS hex (`#rrggbb`) — lower or upper case. Anything else is
 * treated as "no color" by `setTabColor`. We intentionally do not accept
 * 3-digit `#rgb` shorthand to keep the parser predictable and the wire
 * format stable.
 */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

export function isValidTabColor(value: string): boolean {
  return HEX_COLOR_RE.test(value)
}

/**
 * Set the accent color on every pane in `groupId`. Returns the same array
 * by reference when no session is mutated. Invalid hex strings (and the
 * empty string) are normalised to `null` so the caller can pass user
 * input straight through.
 */
export function setTabColor(
  sessions: Session[],
  groupId: string,
  color: string | null,
): Session[] {
  const normalised =
    color && color.trim().length > 0 && HEX_COLOR_RE.test(color.trim())
      ? color.trim().toLowerCase()
      : null
  let mutated = false
  const next = sessions.map((s) => {
    if (s.groupId !== groupId) return s
    if (s.tabColor === normalised) return s
    mutated = true
    return { ...s, tabColor: normalised }
  })
  return mutated ? next : sessions
}

/** Ordered, de-duplicated list of group ids in session order. */
export function groupIdsOf(sessions: Session[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of sessions) {
    if (seen.has(s.groupId)) continue
    seen.add(s.groupId)
    out.push(s.groupId)
  }
  return out
}

/** Sessions belonging to a single group, in array order. */
export function sessionsInGroup(sessions: Session[], groupId: string): Session[] {
  return sessions.filter((s) => s.groupId === groupId)
}

/**
 * `Map<sessionId, "Terminal N">`. Labels are per *group* (tab), so every
 * split pane inside a tab shares that tab's positional label. Re-derive on
 * every render so labels stay correct after a tab closes.
 *
 * If any pane in a group has a non-null `customLabel`, that wins for the
 * whole group (renameGroup keeps every pane in sync, but the reducer is
 * permissive — first non-null label found is used as a fallback).
 */
export function labelsFor(sessions: Session[]): Map<string, string> {
  const positional = new Map(
    groupIdsOf(sessions).map((g, i) => [g, `Terminal ${i + 1}`]),
  )
  const groupLabel = new Map<string, string>()
  for (const g of positional.keys()) groupLabel.set(g, positional.get(g)!)
  for (const s of sessions) {
    if (s.customLabel && s.customLabel.length > 0) {
      groupLabel.set(s.groupId, s.customLabel)
    }
  }
  return new Map(
    sessions.map((s) => [s.id, groupLabel.get(s.groupId) ?? s.id]),
  )
}

/**
 * `Map<groupId, hex | null>` — the resolved accent color for each group.
 * Tracks the first non-null `tabColor` across the group's panes (in
 * practice all panes share the same value after `setTabColor`).
 */
export function colorsFor(sessions: Session[]): Map<string, string | null> {
  const out = new Map<string, string | null>()
  for (const s of sessions) {
    const existing = out.get(s.groupId)
    if (existing == null && s.tabColor) out.set(s.groupId, s.tabColor)
    else if (!out.has(s.groupId)) out.set(s.groupId, null)
  }
  return out
}

/**
 * Set a custom label on every pane in a group. Pass `null` or an empty
 * string to clear the custom label and fall back to the positional name.
 * Empty strings are normalised to `null` for storage uniformity.
 */
export function renameGroup(
  sessions: Session[],
  groupId: string,
  label: string | null,
): Session[] {
  const normalised = label && label.trim().length > 0 ? label.trim() : null
  let mutated = false
  const next = sessions.map((s) => {
    if (s.groupId !== groupId) return s
    if (s.customLabel === normalised) return s
    mutated = true
    return { ...s, customLabel: normalised }
  })
  return mutated ? next : sessions
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

/**
 * Append a new session (new tab) and return the updated array. The session
 * carries its own fresh `groupId`, so it renders as a standalone tab rather
 * than a split.
 */
export function addSession(sessions: Session[], created: Session): Session[] {
  return [...sessions, created]
}

/**
 * Insert a split session immediately after the last existing member of its
 * group, keeping each group contiguous in the array. Contiguity lets the
 * close-active logic land on a sibling pane rather than jumping tabs.
 */
export function addSplit(sessions: Session[], created: Session): Session[] {
  let lastIdx = -1
  for (let i = 0; i < sessions.length; i++) {
    if (sessions[i].groupId === created.groupId) lastIdx = i
  }
  if (lastIdx === -1) return [...sessions, created]
  const next = sessions.slice()
  next.splice(lastIdx + 1, 0, created)
  return next
}

/**
 * Close every session in a group (i.e. close a whole tab). Mirrors
 * `closeSession`'s panel-dismiss / next-active semantics, but operates on
 * all panes of the group at once.
 */
export function closeGroup(
  sessions: Session[],
  groupId: string,
  activeId: string,
): CloseResult {
  const idx = sessions.findIndex((s) => s.groupId === groupId)
  if (idx === -1) {
    return { sessions, nextActiveId: null, panelDismissed: false }
  }
  const next = sessions.filter((s) => s.groupId !== groupId)
  if (next.length === 0) {
    return { sessions: next, nextActiveId: null, panelDismissed: true }
  }
  const activeWasInGroup = sessions.some(
    (s) => s.id === activeId && s.groupId === groupId,
  )
  if (activeWasInGroup) {
    const neighbour = next[Math.min(idx, next.length - 1)]
    return { sessions: next, nextActiveId: neighbour.id, panelDismissed: false }
  }
  return { sessions: next, nextActiveId: null, panelDismissed: false }
}

/**
 * Move a whole group (tab) to a different position relative to a target
 * group. Implementation extracts the source group's contiguous run of
 * sessions, removes it, then splices it back in `before`/`after` the
 * target group's run. Preserves:
 *
 *   - Contiguity of every group (the `groupIdsOf` invariant).
 *   - Order of sessions *within* the moved group (splits keep their
 *     left-to-right order).
 *   - Session identity (no clones, just permutation).
 *
 * No-ops when `from === to`, when the source group doesn't exist, or
 * when the target group doesn't exist. The caller does not need to
 * update the active id — the moved sessions keep their ids, so the
 * existing active session stays focused.
 */
export function reorderGroups(
  sessions: Session[],
  fromGroupId: string,
  toGroupId: string,
  edge: 'before' | 'after',
): Session[] {
  if (fromGroupId === toGroupId) return sessions
  const sourceRun: Session[] = []
  const remainder: Session[] = []
  for (const s of sessions) {
    if (s.groupId === fromGroupId) sourceRun.push(s)
    else remainder.push(s)
  }
  if (sourceRun.length === 0) return sessions

  const targetIdxInRemainder = remainder.findIndex((s) => s.groupId === toGroupId)
  if (targetIdxInRemainder === -1) return sessions

  let insertAt = targetIdxInRemainder
  if (edge === 'after') {
    insertAt = targetIdxInRemainder + 1
    while (
      insertAt < remainder.length &&
      remainder[insertAt].groupId === toGroupId
    ) {
      insertAt++
    }
  }
  const next = remainder.slice()
  next.splice(insertAt, 0, ...sourceRun)
  return next
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
