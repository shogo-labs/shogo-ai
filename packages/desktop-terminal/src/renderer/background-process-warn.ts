// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Background-process safety net. When the user tries to close a tab or
 * the whole app, surface any commands that the tracker recorded as
 * "still running" (saw C, no D yet) so we can present a confirmation.
 *
 * This module owns the **policy logic** only — it does not render a
 * dialog because the dialog shape is owned by apps/desktop's design
 * system (shadcn AlertDialog). The host calls `getRunningSummary()`
 * on close and decides what to show.
 *
 * Decision rules (chosen to match VS Code 1.92+ behaviour):
 *
 *   1. A command counts as "running" if the tracker has a `current`
 *      command in state `awaiting` (B seen, no C yet — user typed
 *      but didn't press Enter) **or** `running` (C seen, no D yet —
 *      command actually executing).
 *
 *      We treat `awaiting` as "running" because forcing the user to
 *      finish typing before closing matches their mental model — they
 *      were about to run something.
 *
 *   2. A command must have been running for at least `minIdleMs`
 *      (default 500 ms) to count. This filters out the tiny race
 *      between C and D for instant commands (true | : | etc.) when
 *      the user clicks "close" right after.
 *
 *   3. If `command.commandLine` is empty, fall back to the literal
 *      string `"(unknown command)"` — better than showing nothing.
 *
 *   4. Sessions are reported in input order; within a session the
 *      single `current` command is reported.
 */

import type { Command, Osc633Tracker } from './osc633-tracker'

export interface SessionLike {
  /** Stable id for the session (so the dialog can show "Terminal 2"). */
  id: string
  /** Human-friendly title (e.g. shell name). Optional. */
  title?: string
  tracker: Osc633Tracker
}

export interface RunningCommandReport {
  sessionId: string
  sessionTitle: string
  commandId: number
  commandLine: string
  /** ms the command has been running. */
  elapsedMs: number
  /** Whether the user is still typing (no C yet) or actually executing. */
  state: 'awaiting' | 'running'
}

export interface RunningSummary {
  /** True if any session has a running command. The "are we blocked?" answer. */
  hasRunning: boolean
  /** Per-session reports, only sessions with something running. */
  reports: RunningCommandReport[]
}

export interface RunningSummaryOptions {
  /** Floor for elapsed-time filter. Default 500 ms. */
  minIdleMs?: number
  /** Inject a clock for tests. */
  now?: () => number
}

export function getRunningSummary(
  sessions: readonly SessionLike[],
  opts: RunningSummaryOptions = {},
): RunningSummary {
  const minIdleMs = Math.max(0, opts.minIdleMs ?? 500)
  const now = (opts.now ?? Date.now)()
  const reports: RunningCommandReport[] = []
  for (const sess of sessions) {
    const cur = sess.tracker.snapshot().current
    if (!cur) continue
    const report = inspect(sess, cur, now, minIdleMs)
    if (report) reports.push(report)
  }
  return { hasRunning: reports.length > 0, reports }
}

function inspect(
  sess: SessionLike,
  cur: Command,
  now: number,
  minIdleMs: number,
): RunningCommandReport | null {
  if (cur.state !== 'running' && cur.state !== 'awaiting') return null
  const startedAt = cur.startedAt ?? now
  const elapsedMs = Math.max(0, now - startedAt)
  // `awaiting` commands have no startedAt; we treat their idle as 0
  // unless the caller set minIdleMs to 0 (i.e. report eagerly).
  if (cur.state === 'running' && elapsedMs < minIdleMs) return null
  return {
    sessionId: sess.id,
    sessionTitle: sess.title ?? sess.id,
    commandId: cur.id,
    commandLine: cur.commandLine || '(unknown command)',
    elapsedMs,
    state: cur.state,
  }
}

// ─── humanised message for dialog body ─────────────────────────────────

/**
 * Render a short prose summary suitable for a confirmation dialog
 * body. Examples:
 *
 *   "npm run build is running in Terminal 1."
 *   "2 commands are running: 'npm test' in Terminal 1, 'cargo build' in Terminal 2."
 *
 * Empty when nothing is running.
 */
export function describeRunningSummary(summary: RunningSummary): string {
  if (!summary.hasRunning) return ''
  const reports = summary.reports
  if (reports.length === 1) {
    const r = reports[0]!
    return `${quote(r.commandLine)} is running in ${r.sessionTitle}.`
  }
  const parts = reports.map((r) => `${quote(r.commandLine)} in ${r.sessionTitle}`)
  return `${reports.length} commands are running: ${parts.join(', ')}.`
}

function quote(s: string): string {
  if (s.startsWith("'") || s.startsWith('"')) return s
  return `'${s}'`
}

// ─── beforeunload helper (browser/electron renderer) ────────────────────

/**
 * Wire a `beforeunload` interceptor on a target (window / BrowserWindow
 * webContents-side window). Returns an `unregister` function. Hosts
 * that want a custom dialog should NOT use this helper — it relies on
 * the browser's stock confirm prompt — and should instead call
 * `getRunningSummary()` from their own close-handler.
 *
 * We export it because apps/desktop's renderer needs a "panic" fallback
 * for the case where the main process force-closes the window before
 * the user clicks through a shadcn dialog.
 */
export interface BeforeUnloadTarget {
  addEventListener(type: 'beforeunload', listener: (ev: BeforeUnloadEvent) => void): void
  removeEventListener(type: 'beforeunload', listener: (ev: BeforeUnloadEvent) => void): void
}

export function installBeforeUnloadGuard(
  target: BeforeUnloadTarget,
  sessions: () => readonly SessionLike[],
  opts: RunningSummaryOptions = {},
): () => void {
  const listener = (ev: BeforeUnloadEvent): void => {
    const summary = getRunningSummary(sessions(), opts)
    if (!summary.hasRunning) return
    ev.preventDefault()
    // Modern browsers ignore the returnValue string but still require
    // it to be set to trigger the prompt. We set it to the summary so
    // legacy hosts that DO show it still get useful text.
    ev.returnValue = describeRunningSummary(summary)
  }
  target.addEventListener('beforeunload', listener)
  return () => target.removeEventListener('beforeunload', listener)
}
