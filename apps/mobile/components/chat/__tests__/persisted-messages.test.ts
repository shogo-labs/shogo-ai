// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import { toAiMessages } from "../persisted-messages"

describe("toAiMessages", () => {
  test("parses parts and keeps id, role, content and createdAt", () => {
    const parts = [{ type: "text", text: "hello" }]
    expect(
      toAiMessages([{ id: "m1", role: "assistant", content: "hello", createdAt: 5, parts: JSON.stringify(parts) }]),
    ).toEqual([{ id: "m1", role: "assistant", content: "hello", createdAt: 5, parts }])
  })

  test("falls back to the text in parts when content is missing", () => {
    const [m] = toAiMessages([
      { id: "m1", role: "assistant", createdAt: 1, parts: JSON.stringify([{ type: "text", text: "from parts" }]) },
    ])
    expect(m.content).toBe("from parts")
  })

  test("keeps the message when its parts are malformed", () => {
    const warn = console.warn
    console.warn = () => {}
    try {
      const [m] = toAiMessages([{ id: "m1", role: "user", content: "hi", createdAt: 1, parts: "{not json" }])
      expect(m).toEqual({ id: "m1", role: "user", content: "hi", createdAt: 1 })
    } finally {
      console.warn = warn
    }
  })
})
