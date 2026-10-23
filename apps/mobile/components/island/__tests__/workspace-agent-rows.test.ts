// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { ISLAND_WORKSPACE_AGENT_ID, type IslandSession } from "../types"
import { workspaceAgentChatRows, type WorkspaceAgentChat } from "../workspace-agent-rows"

function liveSession(overrides: Partial<IslandSession> & Pick<IslandSession, "sessionId">): IslandSession {
  return {
    projectId: ISLAND_WORKSPACE_AGENT_ID,
    projectName: "Shogo",
    title: "Untitled chat",
    status: "idle",
    ...overrides,
  }
}

const chats: WorkspaceAgentChat[] = [
  { id: "older", title: "Plan my week", activity: 1_000 },
  { id: "newer", title: "Create a project", activity: 2_000 },
]

describe("workspaceAgentChatRows", () => {
  test("lists recent agent chats most recent first", () => {
    expect(workspaceAgentChatRows(chats, []).map((row) => row.sessionId)).toEqual(["newer", "older"])
  })

  test("ignores project sessions in the snapshot", () => {
    const rows = workspaceAgentChatRows(
      chats,
      [{ projectId: "project-1", projectName: "Website", sessionId: "p-session", title: "Chat", status: "running" }],
    )
    expect(rows.map((row) => row.sessionId)).toEqual(["newer", "older"])
    expect(rows.every((row) => !row.live)).toBe(true)
  })

  test("live status and title win over the API list", () => {
    const rows = workspaceAgentChatRows(chats, [
      liveSession({
        sessionId: "older",
        status: "needs_approval",
        title: "Plan my week v2",
        lastActivityAt: 5_000,
        replyPreview: "Waiting on a permission",
      }),
    ])
    expect(rows[0]).toMatchObject({
      sessionId: "older",
      title: "Plan my week v2",
      status: "needs_approval",
      live: true,
      activity: 5_000,
    })
  })

  test("a chat the API has not listed yet is kept as a live row", () => {
    const rows = workspaceAgentChatRows(chats, [
      liveSession({ sessionId: "brand-new", title: "New chat", status: "running", lastActivityAt: 9_000 }),
    ])
    expect(rows[0]).toMatchObject({ sessionId: "brand-new", status: "running", live: true })
    expect(rows).toHaveLength(3)
  })

  test("needs-you sorts above running and idle", () => {
    const rows = workspaceAgentChatRows(chats, [
      liveSession({ sessionId: "newer", status: "running" }),
      liveSession({ sessionId: "older", status: "needs_answer" }),
    ])
    expect(rows.map((row) => row.sessionId)).toEqual(["older", "newer"])
  })

  test("caps the list", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      id: `chat-${index}`,
      title: `Chat ${index}`,
      activity: index,
    }))
    expect(workspaceAgentChatRows(many, [])).toHaveLength(8)
  })
})
