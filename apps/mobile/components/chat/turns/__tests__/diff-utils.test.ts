// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for LCS-based line diff used in edit file widgets.
 */
import { describe, expect, test } from "bun:test"
import { computeLineDiff, type DiffLine } from "../diff-utils"

function lines(diff: DiffLine[]): string[] {
  return diff.map((d) => `${d.type}:${d.text}`)
}

describe("computeLineDiff", () => {
  test("identical content yields only context lines", () => {
    const diff = computeLineDiff("alpha\nbeta\ngamma", "alpha\nbeta\ngamma")
    expect(diff).toEqual([
      { type: "context", text: "alpha" },
      { type: "context", text: "beta" },
      { type: "context", text: "gamma" },
    ])
  })

  test("empty old string treats split('') as one empty line then additions", () => {
    expect(computeLineDiff("", "one\ntwo")).toEqual([
      { type: "removed", text: "" },
      { type: "added", text: "one" },
      { type: "added", text: "two" },
    ])
  })

  test("empty new string removes content and adds trailing empty line", () => {
    expect(computeLineDiff("one\ntwo", "")).toEqual([
      { type: "removed", text: "one" },
      { type: "removed", text: "two" },
      { type: "added", text: "" },
    ])
  })

  test("both empty strings match on the single empty line", () => {
    expect(computeLineDiff("", "")).toEqual([{ type: "context", text: "" }])
  })

  test("single line replacement", () => {
    expect(computeLineDiff("old", "new")).toEqual([
      { type: "removed", text: "old" },
      { type: "added", text: "new" },
    ])
  })

  test("insertion in the middle keeps surrounding context", () => {
    const diff = computeLineDiff("a\nc", "a\nb\nc")
    expect(lines(diff)).toEqual(["context:a", "added:b", "context:c"])
  })

  test("deletion in the middle", () => {
    const diff = computeLineDiff("a\nb\nc", "a\nc")
    expect(lines(diff)).toEqual(["context:a", "removed:b", "context:c"])
  })

  test("multiple scattered edits", () => {
    const diff = computeLineDiff("keep\nold-one\nshared\nold-two\ntail", "keep\nnew-one\nshared\nnew-two\ntail")
    expect(diff.filter((d) => d.type === "context").map((d) => d.text)).toEqual(["keep", "shared", "tail"])
    expect(diff.filter((d) => d.type === "removed").map((d) => d.text)).toEqual(["old-one", "old-two"])
    expect(diff.filter((d) => d.type === "added").map((d) => d.text)).toEqual(["new-one", "new-two"])
  })

  test("complete replacement has no context", () => {
    expect(computeLineDiff("x\ny", "p\nq")).toEqual([
      { type: "removed", text: "x" },
      { type: "removed", text: "y" },
      { type: "added", text: "p" },
      { type: "added", text: "q" },
    ])
  })

  test("append-only change at end", () => {
    const diff = computeLineDiff("line1", "line1\nline2")
    expect(lines(diff)).toEqual(["context:line1", "added:line2"])
  })
})
