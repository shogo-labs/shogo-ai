// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The side window a pressed background task opens (SHO-27). One pane, chosen
 * by the task's `link`: a channel/card thread, another project's session, a
 * live sub-agent, or the task's own log. Whatever the destination, it is never
 * an empty box — with nowhere to go it still shows the task and its output.
 */

import { resolve } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"
import type { TaskThreadTarget } from "../../../../lib/task-thread-pane-store"

mock.module("react-native", () => createReactNativeMock())
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
mock.module("lucide-react-native", () => ({ X: () => createElement("span") }))

const conversation = { id: "conv-1", name: "shogo-dev" }
mock.module(resolve(import.meta.dir, "../../../../lib/team-chat-api"), () => ({
  teamChatApi: () => ({ get: async () => conversation }),
}))
mock.module(resolve(import.meta.dir, "../../../../hooks/useActiveWorkspace"), () => ({
  useActiveWorkspace: () => ({ id: "ws-1" }),
}))
mock.module(resolve(import.meta.dir, "../../../../hooks/useTeamChat"), () => ({
  useMentionables: () => [],
}))
mock.module(resolve(import.meta.dir, "../../../../hooks/useWorkspaceUser"), () => ({
  useWorkspaceUser: () => ({ id: "user-1" }),
}))
mock.module(resolve(import.meta.dir, "../../../../lib/subagent-stream-store"), () => ({
  subagentStreamStore: { get: () => undefined },
}))
mock.module(resolve(import.meta.dir, "../../../team-chat/TimelinePane"), () => ({
  TimelinePane: ({ threadRootId }: { threadRootId: string }) =>
    createElement("div", { "data-testid": "timeline-pane" }, `thread:${threadRootId}`),
}))
mock.module(resolve(import.meta.dir, "../../../project/ProjectChatView"), () => ({
  ProjectChatView: ({ projectId, chatSessionId }: { projectId: string; chatSessionId?: string }) =>
    createElement("div", { "data-testid": "project-chat-view" }, `${projectId}/${chatSessionId ?? ""}`),
}))

const { TaskThreadPane } = await import("../TaskThreadPane")

const target = (overrides: Partial<TaskThreadTarget> = {}): TaskThreadTarget => ({
  taskId: "t_1",
  title: "Billing Bot: reconcile invoices",
  source: "project_call",
  status: "running",
  output: "",
  ...overrides,
})

const renderPane = (t: TaskThreadTarget) =>
  render(createElement(TaskThreadPane, { target: t, onClose: () => {} }))

describe("TaskThreadPane", () => {
  test("a log link shows the command's own output", async () => {
    renderPane(target({ source: "shell", link: { kind: "log", path: ".shogo/tasks/t_1.log" }, output: "hello from the log" }))
    expect(await screen.findByText("Command output")).toBeTruthy()
    expect(screen.getByText("hello from the log")).toBeTruthy()
  })

  test("a log with nothing written yet says No output yet instead of staying blank", async () => {
    renderPane(target({ source: "shell", link: { kind: "log", path: ".shogo/tasks/t_1.log" } }))
    expect(await screen.findByText("No output yet")).toBeTruthy()
  })

  test("a card link opens the card's thread, headed by its key", async () => {
    renderPane(
      target({
        source: "work_item",
        link: {
          kind: "card",
          conversationId: "conv-1",
          threadRootId: "msg-9",
          itemId: "item-1",
          itemKey: "SUP-12",
          board: "Support",
        },
      }),
    )
    expect(await screen.findByTestId("timeline-pane")).toBeTruthy()
    expect(screen.getByTestId("timeline-pane").textContent).toContain("thread:msg-9")
    expect(screen.getByText("SUP-12")).toBeTruthy()
  })

  test("a channel thread link opens that thread", async () => {
    renderPane(
      target({
        source: "agent_reply",
        link: { kind: "channel_thread", conversationId: "conv-1", threadRootId: "msg-7", workspaceId: "ws-1" },
      }),
    )
    expect(await screen.findByTestId("timeline-pane")).toBeTruthy()
    expect(screen.getByTestId("timeline-pane").textContent).toContain("thread:msg-7")
    expect(screen.getByText("#shogo-dev")).toBeTruthy()
  })

  test("a project session link opens the callee project's chat session", async () => {
    renderPane(
      target({
        link: { kind: "project_session", projectId: "proj-2", chatSessionId: "run:abc", name: "Analyst" },
      }),
    )
    expect(await screen.findByTestId("project-chat-view")).toBeTruthy()
    expect(screen.getByTestId("project-chat-view").textContent).toBe("proj-2/run:abc")
    expect(screen.getByText("Analyst")).toBeTruthy()
  })

  test("a task with no destination still shows what it is and why", async () => {
    renderPane(target({ link: null, output: "partial text", error: "This task is no longer tracked." }))
    expect(await screen.findByText("Task output")).toBeTruthy()
    expect(screen.getByText("Billing Bot: reconcile invoices")).toBeTruthy()
    expect(screen.getByText("This task is no longer tracked.")).toBeTruthy()
    expect(screen.getByText("partial text")).toBeTruthy()
  })
})
