// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import { countLines, streamingArgsKey } from "../streaming-tool-args"

describe("countLines", () => {
  test("counts lines like split('\\n').length for non-empty text", () => {
    for (const text of ["a", "a\n", "a\nb", "\n\n", "x\ny\nz\n"]) {
      expect(countLines(text)).toBe(text.split("\n").length)
    }
  })
  test("empty text has no lines", () => {
    expect(countLines("")).toBe(0)
  })
})

describe("streamingArgsKey", () => {
  test("changes when a streamed string grows", () => {
    expect(streamingArgsKey({ path: "a.ts", content: "abc" })).not.toBe(
      streamingArgsKey({ path: "a.ts", content: "abcd" }),
    )
  })
  test("is stable for equal-length strings and equal primitives", () => {
    expect(streamingArgsKey({ path: "a.ts", content: "abc", append: false })).toBe(
      streamingArgsKey({ path: "a.ts", content: "abc", append: false }),
    )
  })
  test("reflects new keys and primitive changes", () => {
    expect(streamingArgsKey({ path: "a.ts" })).not.toBe(streamingArgsKey({ path: "a.ts", content: "" }))
    expect(streamingArgsKey({ append: false })).not.toBe(streamingArgsKey({ append: true }))
  })
  test("handles missing args", () => {
    expect(streamingArgsKey(undefined)).toBe("")
    expect(streamingArgsKey(null)).toBe("")
  })
  test("does not walk large strings (cost is independent of length)", () => {
    const big = "x".repeat(2_000_000)
    const start = performance.now()
    for (let i = 0; i < 1000; i++) streamingArgsKey({ path: "a.ts", content: big })
    expect(performance.now() - start).toBeLessThan(200)
  })
})
