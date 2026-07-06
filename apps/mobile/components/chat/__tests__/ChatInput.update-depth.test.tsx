// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

// @ts-ignore Bun resolves this module at test runtime; app tsconfig does not include Bun ambient types.
import { describe, expect, test } from "bun:test"

import { resolveChatInputTextChange } from "../chat-input-text-change"

describe("ChatInput text-change state transitions", () => {
  test("ignores same-value mobile-web controlled TextInput echo events", () => {
    let current = ""
    let stateWrites = 0

    for (const next of ["@", "@", "@a", "@a", "@al", "@al"]) {
      const change = resolveChatInputTextChange(current, next, false)
      if (change.type === "text") {
        current = change.text
        stateWrites += 1
      }
    }

    expect(current).toBe("@al")
    expect(stateWrites).toBe(3)
  })

  test("demonstrates the pre-fix echo loop would write state for every echoed event", () => {
    const events = ["hello", ...Array.from({ length: 80 }, () => "hello")]
    let legacyStateWrites = 0
    let fixedStateWrites = 0
    let current = ""

    for (const next of events) {
      legacyStateWrites += 1
      const change = resolveChatInputTextChange(current, next, false)
      if (change.type === "text") {
        current = change.text
        fixedStateWrites += 1
      }
    }

    expect(legacyStateWrites).toBe(81)
    expect(fixedStateWrites).toBe(1)
  })

  test("preserves slash command skill-picker transitions", () => {
    expect(resolveChatInputTextChange("", "/dep", false)).toEqual({
      type: "text",
      text: "/dep",
      resetHeight: false,
      skillPicker: { open: true, filterText: "dep" },
      mentionCaret: 4,
    })

    expect(resolveChatInputTextChange("/dep", "/dep now", false)).toEqual({
      type: "text",
      text: "/dep now",
      resetHeight: false,
      skillPicker: { open: false },
      mentionCaret: 8,
    })
  })

  test("preserves long-paste extraction", () => {
    const pasted = "x".repeat(5_100)
    expect(resolveChatInputTextChange("prefix ", `prefix ${pasted}`, false)).toMatchObject({
      type: "long-paste",
      inserted: pasted,
      restored: "prefix ",
    })
  })
})
