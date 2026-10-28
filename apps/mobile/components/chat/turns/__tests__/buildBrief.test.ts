// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import {
  buildBuildBriefMessage,
  parseBuildBriefMessage,
  stripBuildBriefMarker,
} from "../buildBrief"

describe("buildBrief", () => {
  test("round-trips the idea and sends the research-and-plan instructions", () => {
    const message = buildBuildBriefMessage("  A CRM for my bakery  ")
    expect(message).toContain("research this and put a plan together")
    expect(parseBuildBriefMessage(message)).toBe("A CRM for my bakery")
  })

  test("keeps a multi-line idea intact", () => {
    const idea = "A support agent\nthat answers emails\n\nand escalates refunds"
    expect(parseBuildBriefMessage(buildBuildBriefMessage(idea))).toBe(idea)
  })

  test("ignores ordinary messages and a marker that is not on the first line", () => {
    expect(parseBuildBriefMessage("please rename the button")).toBeNull()
    expect(parseBuildBriefMessage("hello\n::Build Brief::\nidea")).toBeNull()
    expect(parseBuildBriefMessage("::Build Brief::\n   ")).toBeNull()
  })

  test("strips a brief down to its idea and leaves other text unchanged", () => {
    expect(stripBuildBriefMarker(buildBuildBriefMessage("A CRM"))).toBe("A CRM")
    expect(stripBuildBriefMarker("plain text")).toBe("plain text")
  })
})
