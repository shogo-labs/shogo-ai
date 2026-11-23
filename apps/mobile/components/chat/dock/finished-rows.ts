// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * When a settled task row leaves the running-tasks dock.
 *
 * The runtime keeps a finished task in `listDock()` for ten minutes so a late
 * `wait`, `task_list` or output read still finds it. That retention is a
 * server concern; the dock only needs the row long enough to read the outcome.
 * These constants and helpers are the dock's side of that split, kept pure so
 * the timing is testable without a mounted panel.
 */

import type { RunningProcess } from "../ProcessPanel"

/** How long a settled row stays readable before it starts leaving the dock. */
export const DOCK_FINISHED_LINGER_MS = 4_000
/** Fade + height collapse of a row on its way out. */
export const DOCK_FINISHED_EXIT_MS = 220
/**
 * Floor on how long a row stays readable *from the moment the client sees it
 * settled*. The linger above is anchored to the runtime's `finishedAt`, but the
 * client learns of a settle up to five seconds late (task-update frames only
 * flow during a turn; otherwise the 5 s dock poll), so a row that settles
 * between two polls can arrive with its whole linger already spent — and blink
 * out before anyone reads the outcome.
 */
export const DOCK_FINISHED_MIN_VISIBLE_MS = 1_500

/** Stable identity of a task row — the task id, or the run it was started as. */
export function processKey(proc: RunningProcess): string {
  return proc.id ?? proc.runId
}

/** Settled: it has a finish time or a terminal status. `stale` rows are not. */
export function isFinishedProcess(proc: RunningProcess): boolean {
  return !!proc.finishedAt || (!!proc.status && proc.status !== "running")
}

/**
 * How long until a settled row starts its exit. Clamped to the linger window
 * so a row that arrives already older than it (a reload restoring a task that
 * finished a minute ago) leaves on the next tick instead of waiting again.
 */
export function finishLingerDelayMs(proc: RunningProcess, now: number): number {
  const finishedAt = proc.finishedAt ?? now
  return Math.min(
    DOCK_FINISHED_LINGER_MS,
    Math.max(0, finishedAt + DOCK_FINISHED_LINGER_MS - now),
  )
}

/**
 * How long until a settled row starts its exit, honouring both anchors: the
 * server's finish time (so a row that was on screen when it settled keeps the
 * full linger) and the first time the client rendered it as settled (so a row
 * the poll delivers late still gets a readable window). `firstSeenSettledAt` is
 * written once per task, so a poll landing mid-linger cannot restart it.
 */
export function visibleLingerDelayMs(
  proc: RunningProcess,
  now: number,
  firstSeenSettledAt: number,
): number {
  const fromFinish = finishLingerDelayMs(proc, now)
  const fromFirstSight = DOCK_FINISHED_MIN_VISIBLE_MS - (now - firstSeenSettledAt)
  return Math.max(0, Math.min(DOCK_FINISHED_LINGER_MS, Math.max(fromFinish, fromFirstSight)))
}

/**
 * How long this device remembers a row it watched retire.
 *
 * The runtime lists a settled task for ten minutes (see the header), so every
 * reopen inside that window is handed the row again. A row that already played
 * its exit here must not play it again, and the memory only has to outlive that
 * listing: this is the runtime's retention plus a margin.
 */
export const DOCK_SEEN_RETENTION_MS = 15 * 60_000
/** Newest retired keys kept per chat — beyond this a chat is past reading anyway. */
export const DOCK_SEEN_MAX_KEYS_PER_SESSION = 300
/** Chats kept at once; the ones that retired nothing most recently go first. */
export const DOCK_SEEN_MAX_SESSIONS = 20

/** Chat session id -> task key -> when this device watched the row retire. */
export type DockSeenLedger = Record<string, Record<string, number>>

function isUsableStamp(at: unknown): at is number {
  return typeof at === "number" && Number.isFinite(at)
}

/**
 * Drop everything the ledger no longer needs: entries older than the runtime's
 * retention, then the oldest keys past the per-chat cap, then the chats that
 * retired nothing most recently past the chat cap. Returns the same object when
 * there is nothing to drop, so a caller can skip a pointless write.
 */
export function pruneSeenLedger(
  ledger: DockSeenLedger,
  now: number,
  retentionMs: number = DOCK_SEEN_RETENTION_MS,
): DockSeenLedger {
  let changed = false
  const sessions: { id: string; entries: [string, number][]; newest: number }[] = []

  for (const [sessionId, entries] of Object.entries(ledger)) {
    if (!entries || typeof entries !== "object") {
      changed = true
      continue
    }
    const kept = Object.entries(entries).filter(([, at]) =>
      isUsableStamp(at) && now - at < retentionMs,
    ) as [string, number][]
    if (kept.length !== Object.keys(entries).length) changed = true
    if (kept.length === 0) continue
    kept.sort((a, b) => b[1] - a[1])
    const capped =
      kept.length > DOCK_SEEN_MAX_KEYS_PER_SESSION ? kept.slice(0, DOCK_SEEN_MAX_KEYS_PER_SESSION) : kept
    if (capped.length !== kept.length) changed = true
    sessions.push({ id: sessionId, entries: capped, newest: capped[0]![1] })
  }

  sessions.sort((a, b) => b.newest - a.newest)
  if (sessions.length > DOCK_SEEN_MAX_SESSIONS) {
    sessions.length = DOCK_SEEN_MAX_SESSIONS
    changed = true
  }
  if (!changed) return ledger

  const next: DockSeenLedger = {}
  for (const session of sessions) next[session.id] = Object.fromEntries(session.entries)
  return next
}

/** Has this device already watched this row retire in this chat? */
export function wasSeenRow(
  ledger: DockSeenLedger,
  sessionId: string | null | undefined,
  key: string,
  now: number,
): boolean {
  if (!sessionId) return false
  const at = ledger[sessionId]?.[key]
  if (!isUsableStamp(at)) return false
  return now - at < DOCK_SEEN_RETENTION_MS
}

/**
 * Remember that this device watched the row retire. The first stamp wins: a
 * row re-sent by the poll must not extend its own memory.
 */
export function markSeenRow(
  ledger: DockSeenLedger,
  sessionId: string | null | undefined,
  key: string,
  at: number,
  now: number = at,
): DockSeenLedger {
  if (!sessionId) return ledger
  const pruned = pruneSeenLedger(ledger, now)
  const entries = pruned[sessionId]
  if (entries?.[key] != null) return pruned
  return pruneSeenLedger({ ...pruned, [sessionId]: { ...entries, [key]: at } }, now)
}
