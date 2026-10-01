// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { IslandSession, IslandSnapshot } from "../types"
import type { BuddyState } from "./engine"

/** Idle for this long with the island open and the buddy dozes off. */
export const BUDDY_SLEEP_AFTER_MS = 10 * 60_000

export function buddyStateForSession(session: Pick<IslandSession, "status">): BuddyState {
  switch (session.status) {
    case "running":
      return "working"
    case "needs_approval":
      return "approval"
    case "needs_answer":
      return "question"
    case "done":
      return "finished"
    default:
      return "idle"
  }
}

const PRIORITY: BuddyState[] = ["error", "approval", "question", "working", "finished", "idle"]

/** The state the main buddy shows for the whole island: whatever needs the
 * user most, then work in progress, then the last finish. */
export function buddyStateForSnapshot(snapshot: IslandSnapshot, now = Date.now()): BuddyState {
  if (snapshot.notice) return "error"
  const states = new Set(snapshot.sessions.map(buddyStateForSession))
  const best = PRIORITY.find((state) => states.has(state)) ?? "idle"
  if (best !== "idle") return best
  const lastActivity = Math.max(0, ...snapshot.sessions.map((s) => s.lastActivityAt ?? 0), snapshot.updatedAt)
  return lastActivity > 0 && now - lastActivity > BUDDY_SLEEP_AFTER_MS ? "sleeping" : "idle"
}
