// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { islandSoundForTransition, meetingSoundForTransition } from "../island-sounds"
import type { IslandSession, IslandSnapshot } from "../types"

function snapshot(sessions: IslandSession[], extra: Partial<IslandSnapshot> = {}): IslandSnapshot {
  return { sessions, recentProjects: [], updatedAt: 0, ...extra }
}

function session(overrides: Partial<IslandSession>): IslandSession {
  return { sessionId: "s", projectId: "p", projectName: "P", title: "Chat", status: "running", ...overrides }
}

const permission = (id: string) => ({
  kind: "permission" as const,
  request: { id, toolName: "exec", category: "shell", params: {}, reason: "", timeout: 30, startedAt: 0 },
})

describe("islandSoundForTransition", () => {
  test("chimes once for a new permission request, not for the same one again", () => {
    const before = snapshot([session({})])
    const asking = snapshot([session({ status: "needs_approval", pending: permission("perm-1") })])
    expect(islandSoundForTransition(before, asking)).toBe("needs-you")
    expect(islandSoundForTransition(asking, asking)).toBeNull()
  })

  test("chimes for a new plan", () => {
    const plan = { name: "Plan", overview: "", plan: "x", todos: [], toolCallId: "call-1" }
    expect(
      islandSoundForTransition(snapshot([session({})]), snapshot([session({ status: "done", pendingPlan: plan })])),
    ).toBe("needs-you")
  })

  test("plays done when a run finishes and needs-you wins over done", () => {
    const before = snapshot([session({ sessionId: "a" }), session({ sessionId: "b" })])
    expect(
      islandSoundForTransition(before, snapshot([session({ sessionId: "a", status: "done" }), session({ sessionId: "b" })])),
    ).toBe("done")
    expect(
      islandSoundForTransition(
        before,
        snapshot([
          session({ sessionId: "a", status: "done" }),
          session({ sessionId: "b", status: "needs_approval", pending: permission("perm-2") }),
        ]),
      ),
    ).toBe("needs-you")
  })

  test("stays quiet for the chat the user is looking at", () => {
    expect(
      islandSoundForTransition(
        snapshot([session({})]),
        snapshot([session({ status: "done" })], { focusedSessionKey: "p:s" }),
      ),
    ).toBeNull()
  })

  test("plays error for a new notice", () => {
    expect(islandSoundForTransition(snapshot([]), snapshot([], { notice: "Couldn't open" }))).toBe("error")
    expect(
      islandSoundForTransition(snapshot([], { notice: "Couldn't open" }), snapshot([], { notice: "Couldn't open" })),
    ).toBeNull()
  })
})

describe("meetingSoundForTransition", () => {
  const prompt = { id: "meeting-1", app: "Zoom", detectedAt: 1, suggestAutoRecord: false }

  test("chimes for a new meeting prompt only", () => {
    expect(meetingSoundForTransition({}, { prompt })).toBe("needs-you")
    expect(meetingSoundForTransition({ prompt }, { prompt, busy: true })).toBeNull()
    expect(meetingSoundForTransition({ prompt }, { recording: { id: "r", startedAt: 2 } })).toBeNull()
  })

  test("plays error when recording fails", () => {
    expect(meetingSoundForTransition({ prompt }, { prompt, error: "Open a Shogo window" })).toBe("error")
  })
})
