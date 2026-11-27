// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * How often a screen re-asks the workspace what is running (SHO-602).
 *
 * Agent turns run for minutes, and a poll wakes the phone radio. A fast cadence
 * that follows *any* running turn therefore costs ~720 requests/hour/user on
 * whatever screen the person happens to be on, which is why the fast one is
 * scoped to the thing they can actually see.
 *
 * The realtime connection already pushes both edges of a turn
 * (`chat-session.turn`, SHO-299), and each edge is worth exactly one refresh,
 * so the timer never has to be what makes an indicator appear or clear. What is
 * left for the timer is the safety net: an edge the socket never announced.
 *
 * Three cadences, in one place so the chats list and the activity feed cannot
 * drift apart:
 *  - watching: the turn or task this screen shows is running — 5 s, the same
 *    live indicator as before.
 *  - off-screen run: something is running that this screen does not show —
 *    60 s. The badge arrives on the socket; the poll only reconciles.
 *  - idle: nothing running — 30 s is plenty to notice a turn the socket missed,
 *    and 15 s doubled the request count of a screen doing nothing.
 */
export const ACTIVITY_WATCHING_POLL_MS = 5_000
export const ACTIVITY_OFFSCREEN_RUN_POLL_MS = 60_000
export const ACTIVITY_IDLE_POLL_MS = 30_000

export interface ActivityRunState {
  /** What this screen shows is running right now. */
  watchingRunning: boolean
  /** Something is running anywhere in this screen's scope. */
  anyRunning: boolean
}

/** The delay before the next poll: 5 s / 60 s / 30 s. */
export function activityPollMs({
  watchingRunning,
  anyRunning,
}: ActivityRunState): number {
  if (watchingRunning) return ACTIVITY_WATCHING_POLL_MS
  if (anyRunning) return ACTIVITY_OFFSCREEN_RUN_POLL_MS
  return ACTIVITY_IDLE_POLL_MS
}
