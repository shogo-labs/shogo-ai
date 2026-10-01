// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import type { UIMessage } from "@ai-sdk/react"
import {
  derivePendingPlan,
  inboxSessions,
  mergeSessionRows,
  orderIslandSessions,
  sortIslandProjects,
} from "../island-inbox"
import type { IslandSession } from "../types"

function session(overrides: Partial<IslandSession>): IslandSession {
  return {
    sessionId: "s",
    projectId: "p",
    projectName: "Project",
    title: "Chat",
    status: "idle",
    ...overrides,
  }
}

function apiSession(id: string, activity: number, extra: { isArchived?: boolean } = {}) {
  return {
    id,
    name: "",
    inferredName: `Chat ${id}`,
    createdAt: 0,
    activity,
    isPinned: false,
    isArchived: extra.isArchived ?? false,
  }
}

describe("orderIslandSessions", () => {
  test("needs-you first, then running, then done, newest first within each", () => {
    const ordered = orderIslandSessions([
      session({ sessionId: "done", status: "done", lastActivityAt: 50 }),
      session({ sessionId: "run-old", status: "running", lastActivityAt: 10 }),
      session({ sessionId: "ask", status: "needs_answer", lastActivityAt: 1 }),
      session({ sessionId: "run-new", status: "running", lastActivityAt: 20 }),
    ])
    expect(ordered.map((s) => s.sessionId)).toEqual(["ask", "run-new", "run-old", "done"])
  })
})

describe("inboxSessions", () => {
  test("hides idle background tabs but keeps the focused chat", () => {
    const visible = inboxSessions(
      [
        session({ sessionId: "idle-background", status: "idle" }),
        session({ sessionId: "running", status: "running" }),
        session({ sessionId: "focused", status: "idle" }),
      ],
      "p:focused",
    )
    expect(visible.map((item) => item.sessionId)).toEqual(["running", "focused"])
  })
})

describe("mergeSessionRows", () => {
  test("overlays live status, skips archived chats, and keeps live chats the API hasn't returned", () => {
    const rows = mergeSessionRows(
      "p",
      [apiSession("a", 100), apiSession("b", 300), apiSession("gone", 999, { isArchived: true })],
      [
        session({
          sessionId: "a",
          status: "running",
          step: "Editing",
          lastActivityAt: 500,
        }),
        session({
          sessionId: "fresh",
          title: "Brand new",
          status: "running",
          lastActivityAt: 400,
        }),
        session({
          sessionId: "other",
          projectId: "q",
          status: "needs_approval",
        }),
      ],
      (s) => s.inferredName,
    )
    expect(rows.map((r) => r.sessionId)).toEqual(["a", "fresh", "b"])
    expect(rows[0]).toEqual(
      expect.objectContaining({
        title: "Chat",
        status: "running",
        step: "Editing",
        activity: 500,
        live: true,
      }),
    )
    expect(rows[2]).toEqual(expect.objectContaining({ title: "Chat b", status: "idle", live: false }))
  })
})

describe("sortIslandProjects", () => {
  const projects = [
    { id: "old", name: "Old site", updatedAt: 10 },
    { id: "new", name: "New app", lastMessageAt: 100 },
    { id: "busy", name: "Busy api", updatedAt: 1 },
  ]

  test("projects with live sessions lead, then most recent activity", () => {
    const sorted = sortIslandProjects(projects, [session({ projectId: "busy", status: "running" })])
    expect(sorted.map((p) => p.id)).toEqual(["busy", "new", "old"])
  })

  test("filters by name case-insensitively", () => {
    expect(sortIslandProjects(projects, [], "  SITE ").map((p) => p.id)).toEqual(["old"])
  })
})

describe("derivePendingPlan", () => {
  const assistant = (parts: unknown[]): UIMessage => ({ id: "m", role: "assistant", parts }) as unknown as UIMessage

  test("reads a completed dynamic create_plan call", () => {
    const plan = derivePendingPlan([
      assistant([
        { type: "text", text: "Here is the plan" },
        {
          type: "dynamic-tool",
          toolName: "create_plan",
          toolCallId: "call-1",
          state: "output-available",
          input: {
            name: "Auth",
            overview: "Add auth",
            plan: "1. Login",
            todos: [{ id: "t", content: "x" }],
          },
        },
      ]),
    ])
    expect(plan).toEqual(
      expect.objectContaining({
        name: "Auth",
        toolCallId: "call-1",
        isUpdate: false,
        todos: [{ id: "t", content: "x" }],
      }),
    )
  })

  test("reads a legacy update_plan invocation", () => {
    const plan = derivePendingPlan([
      assistant([
        {
          type: "tool-invocation",
          toolInvocation: {
            toolName: "update_plan",
            toolCallId: "call-2",
            state: "result",
            args: { overview: "Revised" },
          },
        },
      ]),
    ])
    expect(plan).toEqual(
      expect.objectContaining({
        name: "Plan",
        overview: "Revised",
        isUpdate: true,
      }),
    )
  })

  test("ignores plans that aren't in the last assistant message or are still streaming", () => {
    const planPart = {
      type: "dynamic-tool",
      toolName: "create_plan",
      state: "input-streaming",
      input: { plan: "partial" },
    }
    expect(derivePendingPlan([assistant([planPart])])).toBeNull()
    expect(
      derivePendingPlan([
        assistant([{ ...planPart, state: "output-available" }]),
        {
          id: "u",
          role: "user",
          parts: [{ type: "text", text: "ok" }],
        } as unknown as UIMessage,
      ]),
    ).toBeNull()
  })
})
