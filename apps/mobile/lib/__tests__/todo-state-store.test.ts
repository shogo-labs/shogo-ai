// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { createTodoStateStore } from "../todo-state-store"

describe("createTodoStateStore", () => {
  test("cancelInProgress marks only active todos as cancelled", () => {
    const store = createTodoStateStore()
    store.registerWrite("todo-call-1", [
      { id: "done", content: "completed work", status: "completed" },
      { id: "active", content: "active work", status: "in_progress" },
      { id: "pending", content: "future work", status: "pending" },
    ])

    store.cancelInProgress()

    expect(store.getLatest()).toEqual([
      { id: "done", content: "completed work", status: "completed" },
      { id: "active", content: "active work", status: "cancelled" },
      { id: "pending", content: "future work", status: "pending" },
    ])
    expect(store.getFirstId()).toBe("todo-call-1")
  })

  test("cancelInProgress is a no-op when no todos are active", () => {
    const store = createTodoStateStore()
    let notifications = 0
    store.subscribe(() => { notifications++ })
    store.registerWrite("todo-call-1", [
      { id: "done", content: "completed work", status: "completed" },
      { id: "pending", content: "future work", status: "pending" },
    ])
    notifications = 0

    store.cancelInProgress()

    expect(notifications).toBe(0)
    expect(store.getLatest()).toEqual([
      { id: "done", content: "completed work", status: "completed" },
      { id: "pending", content: "future work", status: "pending" },
    ])
  })
})
