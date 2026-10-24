// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import type { UIMessage } from "ai"
import {
  hasStoppedMarker,
  markStoppedTail,
  mergeStoppedSnapshot,
  stampStopped,
  stoppedTurnIdOf,
} from "../stopped-turn"

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage
}

function assistant(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] } as UIMessage
}

describe("markStoppedTail", () => {
  test("stamps the reply Stop cancelled, with the turn it cancelled", () => {
    const history = [user("u1", "go"), assistant("a1", "partial")]
    const marked = markStoppedTail(history, "turn-1")

    expect(hasStoppedMarker(marked[1])).toBe(true)
    expect(stoppedTurnIdOf(marked[1])).toBe("turn-1")
    // The reply itself is untouched.
    expect((marked[1]!.parts[0] as { text: string }).text).toBe("partial")
  })

  test("leaves a transcript whose tail is not a reply alone", () => {
    const history = [user("u1", "go")]
    expect(markStoppedTail(history, "turn-1")).toBe(history)
  })

  test("is idempotent — a second Stop on the same tail adds no part", () => {
    const once = markStoppedTail([user("u1", "go"), assistant("a1", "x")], "turn-1")
    expect(markStoppedTail(once, "turn-1")).toBe(once)
  })
})

describe("mergeStoppedSnapshot", () => {
  const before = [user("u1", "go"), assistant("a1", "partial")]
  const snapshot = markStoppedTail(before, "turn-1")

  test("keeps messages appended after the stop, in order", () => {
    const live = [...before, user("u2", "next"), assistant("a2", "reply")]
    expect(mergeStoppedSnapshot(live, snapshot).map((m) => m.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
    ])
  })

  test("keeps the stop marker on the reply that is in both arrays", () => {
    const live = [user("u1", "go"), assistant("a1", "partial plus a token")]
    const merged = mergeStoppedSnapshot(live, snapshot)

    expect(hasStoppedMarker(merged[1])).toBe(true)
    // The live copy is the fresher one — it carries the last tokens.
    expect((merged[1]!.parts[0] as { text: string }).text).toBe(
      "partial plus a token",
    )
  })

  test("shows the snapshot when the live array was emptied by the stop", () => {
    expect(mergeStoppedSnapshot([], snapshot)).toBe(snapshot)
  })

  test("stampStopped never doubles the marker", () => {
    const stamped = stampStopped(assistant("a1", "x"), "turn-1")
    expect(stampStopped(stamped, "turn-1")).toBe(stamped)
  })
})
