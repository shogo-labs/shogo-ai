// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import { buildMentionSegments, labelPresent } from "../mention-labels"

describe("labelPresent", () => {
  test("present at a mention boundary on both sides", () => {
    expect(labelPresent("see @a.ts now", "@a.ts")).toBe(true)
    expect(labelPresent("@a.ts", "@a.ts")).toBe(true)
    expect(labelPresent("@a.ts,", "@a.ts")).toBe(true)
    expect(labelPresent("look at @a.ts.", "@a.ts")).toBe(true)
    expect(labelPresent("(@a.ts)", "@a.ts")).toBe(false) // left boundary is whitespace only
    expect(labelPresent("x @a.ts)", "@a.ts")).toBe(true)
  })

  test("absent when the label is only a prefix of a longer token", () => {
    expect(labelPresent("@a.ts:10-20", "@a.ts")).toBe(false)
    expect(labelPresent("@a.tsx", "@a.ts")).toBe(false)
    expect(labelPresent("x@a.ts", "@a.ts")).toBe(false)
    expect(labelPresent("@a.ts.bak", "@a.ts")).toBe(false)
  })

  test("found on a later occurrence", () => {
    expect(labelPresent("@a.tsx and @a.ts", "@a.ts")).toBe(true)
  })

  test("empty label is never present", () => {
    expect(labelPresent("anything", "")).toBe(false)
  })
})

describe("buildMentionSegments", () => {
  test("overlapping file and selection labels each pill only their own token", () => {
    const segments = buildMentionSegments("fix @a.ts and @a.ts:10-20 please", ["@a.ts", "@a.ts:10-20"])
    expect(segments).toEqual([
      { text: "fix ", mention: false },
      { text: "@a.ts", mention: true },
      { text: " and ", mention: false },
      { text: "@a.ts:10-20", mention: true },
      { text: " please", mention: false },
    ])
  })

  test("after deleting the file pill, the selection label does not resurrect it", () => {
    const segments = buildMentionSegments("@a.ts:10-20", ["@a.ts"])
    expect(segments).toEqual([{ text: "@a.ts:10-20", mention: false }])
  })

  test("no labels -> one plain run", () => {
    expect(buildMentionSegments("hello", [])).toEqual([{ text: "hello", mention: false }])
  })
})
