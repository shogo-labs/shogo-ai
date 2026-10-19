// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The pane's destination parsing and store (SHO-27): a link the client cannot
 * render is dropped (so the pane falls back to the log rather than blanking),
 * and a late runtime answer only patches the task the user actually pressed.
 */

import { describe, expect, test } from "bun:test"
import { asTaskLink, linkLabel, linkOpensThread } from "../task-link"
import { taskThreadPane } from "../task-thread-pane-store"

describe("asTaskLink", () => {
  test("keeps the destinations the pane can render", () => {
    expect(asTaskLink({ kind: "card", conversationId: "c", threadRootId: "m", itemId: "i", itemKey: "SUP-1", board: "Support" }))
      .toMatchObject({ kind: "card", itemKey: "SUP-1" })
    expect(asTaskLink({ kind: "channel_thread", conversationId: "c", threadRootId: "m" }))
      .toMatchObject({ kind: "channel_thread", conversationId: "c" })
    expect(asTaskLink({ kind: "project_session", projectId: "p" })).toMatchObject({ kind: "project_session", projectId: "p" })
    expect(asTaskLink({ kind: "subagent", toolCallId: "tc-1" })).toMatchObject({ kind: "subagent", toolCallId: "tc-1" })
    expect(asTaskLink({ kind: "log", path: ".shogo/tasks/s/t_1.log" })).toMatchObject({ kind: "log" })
  })

  test("drops links that are incomplete or unknown", () => {
    expect(asTaskLink(null)).toBeNull()
    expect(asTaskLink({ kind: "card", conversationId: "c" })).toBeNull()
    expect(asTaskLink({ kind: "channel_thread", conversationId: "c" })).toBeNull()
    expect(asTaskLink({ kind: "project_session" })).toBeNull()
    expect(asTaskLink({ kind: "mystery", conversationId: "c" })).toBeNull()
  })

  test("only non-log links count as opening a thread", () => {
    expect(linkOpensThread({ kind: "log" })).toBe(false)
    expect(linkOpensThread({ kind: "channel_thread", conversationId: "c", threadRootId: "m" })).toBe(true)
    expect(linkOpensThread(null)).toBe(false)
    expect(linkLabel({ kind: "card", conversationId: "c", threadRootId: "m", itemId: "i", itemKey: "SUP-7", board: "S" }))
      .toBe("SUP-7")
  })
})

describe("taskThreadPane", () => {
  test("opens with what the row knows, then merges the runtime's answer", () => {
    taskThreadPane.open({ taskId: "t_a", title: "Analyst", loading: true })
    expect(taskThreadPane.get()).toMatchObject({ taskId: "t_a", loading: true })

    taskThreadPane.patch("t_a", { loading: false, output: "the report", link: { kind: "log", path: "x.log" } })
    expect(taskThreadPane.get()).toMatchObject({ taskId: "t_a", loading: false, output: "the report" })

    taskThreadPane.close()
    expect(taskThreadPane.get()).toBeNull()
  })

  test("a late answer for a task the user already left does not hijack the pane", () => {
    taskThreadPane.open({ taskId: "t_first", loading: true })
    taskThreadPane.open({ taskId: "t_second", loading: true })
    taskThreadPane.patch("t_first", { output: "stale" })
    expect(taskThreadPane.get()).toMatchObject({ taskId: "t_second" })
    expect(taskThreadPane.get()?.output).toBeUndefined()
    taskThreadPane.close()
  })
})
