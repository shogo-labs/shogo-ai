// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import {
  DEFAULT_AGENT_NAME,
  initialIslandView,
  isWorkspaceAgentChat,
  parentView,
  viewForOpen,
  type IslandView,
} from "../island-view"
import { ISLAND_WORKSPACE_AGENT_ID, type IslandSession } from "../types"

const projectChat: IslandView = {
  name: "chat",
  projectId: "project-1",
  projectName: "Website",
  sessionId: "session-1",
  title: "Chat",
}

const agentChat: IslandView = {
  name: "chat",
  projectId: ISLAND_WORKSPACE_AGENT_ID,
  projectName: "Shogo",
  sessionId: "ws-session-1",
  title: "New chat",
}

describe("initialIslandView", () => {
  test("opens on a blank workspace-agent chat when the runtime supports it", () => {
    expect(initialIslandView(true)).toEqual({ name: "agent" })
  })

  test("falls back to the project inbox without the workspace runtime", () => {
    expect(initialIslandView(false)).toEqual({ name: "inbox" })
  })
})

describe("parentView", () => {
  test("the blank agent chat closes the card", () => {
    expect(parentView({ name: "agent" }, true)).toBeNull()
  })

  test("the inbox goes back to the agent chat when enabled", () => {
    expect(parentView({ name: "inbox" }, true)).toEqual({ name: "agent" })
  })

  test("the inbox closes the card when the agent view is off", () => {
    expect(parentView({ name: "inbox" }, false)).toBeNull()
  })

  test("a project goes back to the inbox", () => {
    expect(parentView({ name: "project", projectId: "p1", projectName: "Website" }, true)).toEqual({
      name: "inbox",
    })
  })

  test("a project chat goes back to its project", () => {
    expect(parentView(projectChat, true)).toEqual({
      name: "project",
      projectId: "project-1",
      projectName: "Website",
    })
  })

  test("a workspace-agent chat goes back to the inbox, not a project", () => {
    expect(parentView(agentChat, true)).toEqual({ name: "inbox" })
  })

  test("the drop sheet returns to the view it covered", () => {
    const drop: IslandView = { name: "drop", files: [], returnTo: agentChat }
    expect(parentView(drop, true)).toBe(agentChat)
  })
})

describe("isWorkspaceAgentChat", () => {
  test("only chats keyed by the agent id count", () => {
    expect(isWorkspaceAgentChat(agentChat)).toBe(true)
    expect(isWorkspaceAgentChat(projectChat)).toBe(false)
    expect(isWorkspaceAgentChat({ name: "agent" })).toBe(false)
    expect(isWorkspaceAgentChat({ name: "inbox" })).toBe(false)
  })
})

describe("viewForOpen", () => {
  const pendingSession: IslandSession = {
    projectId: "p1",
    projectName: "Website",
    sessionId: "s1",
    title: "Fix the header",
    status: "needs_approval",
    pending: {
      kind: "permission",
      request: { id: "req-1", toolName: "Bash", category: "shell" } as any,
    },
  }

  test("opens blank when nothing is waiting on the user", () => {
    expect(
      viewForOpen(true, [
        { projectId: "p1", projectName: "Website", sessionId: "s2", title: "Running", status: "running" },
      ]),
    ).toEqual({ name: "agent" })
  })

  test("a session awaiting the user takes over the open", () => {
    expect(viewForOpen(true, [pendingSession])).toMatchObject({
      name: "chat",
      projectId: "p1",
      sessionId: "s1",
    })
  })

  test("a needs_answer session without a pending payload also takes over", () => {
    const question: IslandSession = {
      projectId: "p2",
      projectName: "Atlas",
      sessionId: "s3",
      title: "Which stack?",
      status: "needs_answer",
    }
    expect(viewForOpen(true, [question])).toMatchObject({ name: "chat", sessionId: "s3" })
  })

  test("the runtime-off fallback stays on the project inbox", () => {
    expect(viewForOpen(false, [])).toEqual({ name: "inbox" })
  })
})

test("the blank agent view carries no session, so opening creates nothing", () => {
  const view = initialIslandView(true)
  expect(view).toEqual({ name: "agent" })
  expect("sessionId" in view).toBe(false)
})

test("the fallback agent name is Shogo", () => {
  expect(DEFAULT_AGENT_NAME).toBe("Shogo")
})
