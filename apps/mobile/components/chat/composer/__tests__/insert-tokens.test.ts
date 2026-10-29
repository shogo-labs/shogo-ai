// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import { insertAtCaret } from "../insert-tokens"

describe("insertAtCaret", () => {
  test("into an empty draft", () => {
    expect(insertAtCaret("", null, "@a.ts")).toEqual({ next: "@a.ts ", caret: 6 })
  })

  test("null caret appends with a single separating space", () => {
    expect(insertAtCaret("hello", null, "@a.ts")).toEqual({ next: "hello @a.ts ", caret: 12 })
    expect(insertAtCaret("hello ", null, "@a.ts")).toEqual({ next: "hello @a.ts ", caret: 12 })
  })

  test("at the start", () => {
    expect(insertAtCaret("world", 0, "@a.ts")).toEqual({ next: "@a.ts world", caret: 6 })
  })

  test("in the middle of a word adds spaces on both sides", () => {
    expect(insertAtCaret("abcdef", 3, "@x")).toEqual({ next: "abc @x def", caret: 7 })
  })

  test("next to existing whitespace reuses it", () => {
    expect(insertAtCaret("fix  this", 4, "@x")).toEqual({ next: "fix @x this", caret: 7 })
  })

  test("clamps an out-of-range caret", () => {
    expect(insertAtCaret("ab", 99, "@x")).toEqual({ next: "ab @x ", caret: 6 })
    expect(insertAtCaret("ab", -5, "@x")).toEqual({ next: "@x ab", caret: 3 })
  })
})
