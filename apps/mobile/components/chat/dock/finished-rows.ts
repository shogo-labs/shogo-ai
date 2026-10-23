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
