// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { preserveUserLineBreaks } from "../user-markdown"

describe("preserveUserLineBreaks", () => {
  test("turns single newlines into markdown hard breaks", () => {
    expect(preserveUserLineBreaks("first line\nsecond line")).toBe(
      "first line  \nsecond line",
    )
  })

  test("keeps paragraph breaks unchanged", () => {
    expect(preserveUserLineBreaks("first paragraph\n\nsecond paragraph")).toBe(
      "first paragraph\n\nsecond paragraph",
    )
  })

  test("does not alter fenced code blocks", () => {
    const source = [
      "Example:",
      "```ts",
      "const value = 1",
      "return value",
      "```",
      "Done.",
    ].join("\n")

    expect(preserveUserLineBreaks(source)).toBe(
      [
        "Example:  ",
        "```ts",
        "const value = 1",
        "return value",
        "```",
        "Done.",
      ].join("\n"),
    )
  })

  test("leaves text without newlines unchanged", () => {
    expect(preserveUserLineBreaks("**bold** and `code`")).toBe(
      "**bold** and `code`",
    )
  })
})
