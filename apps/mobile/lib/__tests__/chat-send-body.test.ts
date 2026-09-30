// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { buildChatSendBody, normalizePlanData } from "../chat-send-body"

const base = {
  chatSessionId: "session-1",
  chatSessionName: "",
  projectId: "project-1",
  focusedProjectId: "project-1",
  workspaceId: "workspace-1",
  userId: "user-1",
  agentMode: "claude-sonnet",
  interactionMode: "plan" as const,
}

describe("buildChatSendBody", () => {
  test("carries the session, scope, and mode fields", () => {
    const body = buildChatSendBody({ ...base, clientTurnId: "ctid-1" })
    expect(body).toEqual(
      expect.objectContaining({
        chatSessionId: "session-1",
        chatSessionName: undefined,
        projectId: "project-1",
        workspaceId: "workspace-1",
        userId: "user-1",
        agentMode: "claude-sonnet",
        interactionMode: "plan",
        clientTurnId: "ctid-1",
      }),
    )
    expect(typeof body.timezone).toBe("string")
    expect("viewer" in body).toBe(false)
    expect("confirmedPlan" in body).toBe(false)
    expect("references" in body).toBe(false)
  })

  test("a confirmed plan is normalized and forces agent mode", () => {
    const body = buildChatSendBody({
      ...base,
      confirmedPlan: {
        name: "Plan",
        overview: "",
        plan: "Steps",
        todos: undefined as never,
        filepath: "/nested/dir/feature.plan.md",
      },
    })
    expect(body.interactionMode).toBe("agent")
    expect(body.confirmedPlan).toEqual(
      expect.objectContaining({ todos: [], filepath: ".shogo/plans/feature.plan.md" }),
    )
  })

  test("drops empty references and lets extra override fields", () => {
    const body = buildChatSendBody({
      ...base,
      references: [],
      extra: { text: "wire text", interactionMode: "ask" },
    })
    expect("references" in body).toBe(false)
    expect(body.text).toBe("wire text")
    expect(body.interactionMode).toBe("ask")
  })
})

describe("normalizePlanData", () => {
  test("rejects plan paths that aren't .plan.md files", () => {
    expect(normalizePlanData({ name: "P", overview: "", plan: "", todos: [], filepath: "../etc/passwd" }).filepath)
      .toBeUndefined()
  })
})
