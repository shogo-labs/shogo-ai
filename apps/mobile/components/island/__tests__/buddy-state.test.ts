// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { BUDDY_SLEEP_AFTER_MS, buddyStateForSession, buddyStateForSnapshot } from "../buddy/buddy-state"
import type { IslandSession, IslandSnapshot } from "../types"

function session(overrides: Partial<IslandSession>): IslandSession {
  return { sessionId: "s", projectId: "p", projectName: "P", title: "Chat", status: "idle", ...overrides }
}

function snapshot(sessions: IslandSession[], extra: Partial<IslandSnapshot> = {}): IslandSnapshot {
  return { sessions, recentProjects: [], updatedAt: 0, ...extra }
}

describe("buddyStateForSession", () => {
  test("maps each session status", () => {
    expect(buddyStateForSession({ status: "running" })).toBe("working")
    expect(buddyStateForSession({ status: "needs_approval" })).toBe("approval")
    expect(buddyStateForSession({ status: "needs_answer" })).toBe("question")
    expect(buddyStateForSession({ status: "done" })).toBe("finished")
    expect(buddyStateForSession({ status: "idle" })).toBe("idle")
  })
})

describe("buddyStateForSnapshot", () => {
  test("whatever needs the user wins over work in progress", () => {
    const snap = snapshot([
      session({ sessionId: "a", status: "running" }),
      session({ sessionId: "b", status: "needs_answer" }),
      session({ sessionId: "c", status: "needs_approval" }),
    ])
    expect(buddyStateForSnapshot(snap)).toBe("approval")
  })

  test("a notice shows as an error", () => {
    expect(buddyStateForSnapshot(snapshot([session({ status: "running" })], { notice: "Offline" }))).toBe("error")
  })

  test("dozes off after a long quiet stretch", () => {
    const now = 1_000_000_000
    const quiet = snapshot([session({ lastActivityAt: now - BUDDY_SLEEP_AFTER_MS - 1 })], { updatedAt: 1 })
    expect(buddyStateForSnapshot(quiet, now)).toBe("sleeping")
    const recent = snapshot([session({ lastActivityAt: now - 1000 })], { updatedAt: 1 })
    expect(buddyStateForSnapshot(recent, now)).toBe("idle")
  })
})
