// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for turnShaping.ts — groupWorkParts / partitionTurn /
 * extractTurnTiming / formatWorkedDuration / shouldShowPlanningStatus.
 */
import { describe, expect, test } from "bun:test"
import type { UIMessage } from "@ai-sdk/react"
import {
  groupWorkParts,
  partitionTurn,
  extractTurnTiming,
  formatWorkedDuration,
  formatRelativeTime,
  shouldShowPlanningStatus,
} from "../turnShaping"
import type { MessagePart } from "../types"
import type { ToolCallData } from "../../tools/types"

let uid = 0
function nextId(prefix: string): string {
  uid++
  return `${prefix}-${uid}`
}

function tool(
  toolName: string,
  args: Record<string, unknown> = {},
  state: ToolCallData["state"] = "success",
): MessagePart {
  const id = nextId("tool")
  return {
    type: "tool",
    id,
    tool: {
      id,
      toolName,
      category: "other",
      state,
      args,
      timestamp: Date.now(),
    },
  }
}

function text(t: string): MessagePart {
  return { type: "text", id: nextId("text"), text: t }
}

function reasoning(t: string, isStreaming = false): MessagePart {
  return { type: "reasoning", id: nextId("reasoning"), text: t, isStreaming }
}

describe("groupWorkParts", () => {
  test("collapses a single read tool into a work-group (MIN_WORK_GROUP_SIZE = 1)", () => {
    const parts = [tool("Read", { path: "/a.ts" })]
    const grouped = groupWorkParts(parts)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].type).toBe("work-group")
  })

  test("collapses a mix of reads, edits, and shell commands into one work-group", () => {
    const parts = [
      tool("Read", { path: "/a.ts" }),
      tool("Grep", { pattern: "foo" }),
      tool("edit_file", { path: "/b.ts", old_string: "x", new_string: "y" }),
      tool("exec", { command: "bun test" }),
    ]
    const grouped = groupWorkParts(parts)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].type).toBe("work-group")
    if (grouped[0].type === "work-group") {
      expect(grouped[0].items).toHaveLength(4)
    }
  })

  test("reasoning rides along transparently inside a work run", () => {
    const parts = [
      tool("Read", { path: "/a.ts" }),
      reasoning("thinking about it"),
      tool("Read", { path: "/b.ts" }),
    ]
    const grouped = groupWorkParts(parts)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].type).toBe("work-group")
    if (grouped[0].type === "work-group") {
      expect(grouped[0].items).toHaveLength(3)
    }
  })

  test("trailing reasoning after the last matching tool is excluded from the group", () => {
    const r = reasoning("still thinking")
    const parts = [tool("Read", { path: "/a.ts" }), r]
    const grouped = groupWorkParts(parts)
    // The work-group only contains the tool; the trailing reasoning
    // passes through as its own part afterward.
    expect(grouped).toHaveLength(2)
    expect(grouped[0].type).toBe("work-group")
    expect(grouped[1]).toBe(r)
  })

  test("text parts break a work run into separate groups", () => {
    const parts = [
      tool("Read", { path: "/a.ts" }),
      text("Here's what I found"),
      tool("Read", { path: "/b.ts" }),
    ]
    const grouped = groupWorkParts(parts)
    expect(grouped.map((p) => p.type)).toEqual(["work-group", "text", "work-group"])
  })

  test("ungroupable tools (ask_user, TodoWrite) pass through unchanged even in runs", () => {
    const parts = [tool("ask_user", { questions: [] }), tool("ask_user", { questions: [] })]
    const grouped = groupWorkParts(parts)
    expect(grouped).toHaveLength(2)
    expect(grouped[0].type).toBe("tool")
    expect(grouped[1].type).toBe("tool")
  })

  test("repeated same-name non-work tool calls collapse into a tool-group", () => {
    const parts = [
      tool("mcp__shogo__store_get", { model: "a" }),
      tool("mcp__shogo__store_get", { model: "b" }),
    ]
    const grouped = groupWorkParts(parts)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].type).toBe("tool-group")
    if (grouped[0].type === "tool-group") {
      expect(grouped[0].tools).toHaveLength(2)
    }
  })

  test("a lone non-work tool call (below MIN_GROUP_SIZE) passes through as a single tool part", () => {
    const parts = [tool("mcp__shogo__store_get", { model: "a" })]
    const grouped = groupWorkParts(parts)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].type).toBe("tool")
  })

  test("different-name non-work tools don't merge into the same tool-group", () => {
    const parts = [tool("mcp__a__x", {}), tool("mcp__b__y", {})]
    const grouped = groupWorkParts(parts)
    expect(grouped).toHaveLength(2)
    expect(grouped[0].type).toBe("tool")
    expect(grouped[1].type).toBe("tool")
  })
})

describe("partitionTurn", () => {
  test("everything before the LAST text part is the work log; the rest is the final segment", () => {
    const parts = [
      tool("Read", { path: "/a.ts" }),
      text("first response"),
      tool("edit_file", { path: "/b.ts" }),
      text("final response"),
    ]
    const grouped = groupWorkParts(parts)
    const { workLog, finalSegment } = partitionTurn(grouped)
    // Work log = everything before the LAST text part.
    expect(workLog.map((p) => p.type)).toEqual(["work-group", "text", "work-group"])
    // Final segment = the last text part + everything after.
    expect(finalSegment).toHaveLength(1)
    expect(finalSegment[0].type).toBe("text")
  })

  test("a trailing work-group or plan card after the last text part stays in the final segment", () => {
    const parts = [
      tool("Read", { path: "/a.ts" }),
      text("final response"),
      tool("update_plan", { plan: "..." }),
    ]
    const grouped = groupWorkParts(parts)
    const { workLog, finalSegment } = partitionTurn(grouped)
    expect(workLog).toHaveLength(1)
    expect(workLog[0].type).toBe("work-group")
    expect(finalSegment).toHaveLength(2)
    expect(finalSegment[0].type).toBe("text")
    expect(finalSegment[1].type).toBe("tool")
  })

  test("no text part at all: everything is the final segment, work log is empty", () => {
    const parts = [tool("Read", { path: "/a.ts" }), tool("exec", { command: "ls" }, "streaming")]
    const grouped = groupWorkParts(parts)
    const { workLog, finalSegment } = partitionTurn(grouped)
    expect(workLog).toHaveLength(0)
    expect(finalSegment).toEqual(grouped)
  })

  test("the very first part being the last text part means hasBody would be false (empty work log)", () => {
    const parts = [text("just a reply, no tools at all")]
    const grouped = groupWorkParts(parts)
    const { workLog, finalSegment } = partitionTurn(grouped)
    expect(workLog).toHaveLength(0)
    expect(finalSegment).toHaveLength(1)
  })
})

describe("extractTurnTiming", () => {
  function msg(parts: unknown[], createdAt?: Date | number): UIMessage {
    return { id: "m1", role: "assistant", parts, createdAt } as unknown as UIMessage
  }

  test("reads live data-turn-start / data-turn-complete SSE frames", () => {
    const message = msg([
      { type: "data-turn-start", data: { startedAt: 1000 } },
      { type: "text", text: "hi" },
      { type: "data-turn-complete", data: { completedAt: 5000 } },
    ])
    const timing = extractTurnTiming(message)
    expect(timing.startedAt).toBe(1000)
    expect(timing.completedAt).toBe(5000)
  })

  test("reads a persisted data-turn-timing part for historical messages", () => {
    const message = msg([{ type: "data-turn-timing", data: { startedAt: 2000, completedAt: 8000 } }])
    const timing = extractTurnTiming(message)
    expect(timing.startedAt).toBe(2000)
    expect(timing.completedAt).toBe(8000)
  })

  test("falls back to message.createdAt (Date) for completedAt when no turn timing was recorded", () => {
    const createdAt = new Date(12345)
    const message = msg([{ type: "text", text: "hi" }], createdAt)
    const timing = extractTurnTiming(message)
    expect(timing.startedAt).toBeUndefined()
    expect(timing.completedAt).toBe(12345)
  })

  test("falls back to message.createdAt (number) for completedAt", () => {
    const message = msg([{ type: "text", text: "hi" }], 54321)
    const timing = extractTurnTiming(message)
    expect(timing.completedAt).toBe(54321)
  })

  test("no parts array and no createdAt yields an empty timing object", () => {
    const message = { id: "m1", role: "assistant" } as unknown as UIMessage
    const timing = extractTurnTiming(message)
    expect(timing.startedAt).toBeUndefined()
    expect(timing.completedAt).toBeUndefined()
  })
})

describe("formatWorkedDuration", () => {
  test("formats sub-minute durations as seconds", () => {
    expect(formatWorkedDuration(8000)).toBe("8s")
    expect(formatWorkedDuration(0)).toBe("0s")
    expect(formatWorkedDuration(59000)).toBe("59s")
  })

  test("formats minute-scale durations as Xm SSs", () => {
    expect(formatWorkedDuration(65000)).toBe("1m 05s")
    expect(formatWorkedDuration(60000)).toBe("1m 00s")
  })

  test("formats hour-scale durations as Xh Ym", () => {
    expect(formatWorkedDuration(60 * 60 * 1000 + 2 * 60 * 1000)).toBe("1h 2m")
  })

  test("clamps negative durations to 0s", () => {
    expect(formatWorkedDuration(-500)).toBe("0s")
  })
})

describe("shouldShowPlanningStatus", () => {
  test("false when not streaming, regardless of parts", () => {
    expect(shouldShowPlanningStatus([], false)).toBe(false)
    expect(shouldShowPlanningStatus([text("hi")], false)).toBe(false)
  })

  test("true when streaming with no parts yet", () => {
    expect(shouldShowPlanningStatus([], true)).toBe(true)
  })

  test("false while a tool is actively streaming", () => {
    const parts = [tool("exec", { command: "ls" }, "streaming")]
    expect(shouldShowPlanningStatus(parts, true)).toBe(false)
  })

  test("false while text is currently streaming (growing prose)", () => {
    const parts = [text("growing...")]
    expect(shouldShowPlanningStatus(parts, true)).toBe(false)
  })

  test("true right after a finished tool call, waiting for the next step", () => {
    const parts = [tool("Read", { path: "/a.ts" }, "success")]
    expect(shouldShowPlanningStatus(parts, true)).toBe(true)
  })

  test("true during a live reasoning burst (renders as status line, not ThinkingWidget)", () => {
    const parts = [reasoning("thinking...", true)]
    expect(shouldShowPlanningStatus(parts, true)).toBe(true)
  })
})

describe("formatRelativeTime", () => {
  const now = 1_000_000_000

  test("sub-minute deltas read as 'just now'", () => {
    expect(formatRelativeTime(now - 5000, now)).toBe("just now")
    expect(formatRelativeTime(now, now)).toBe("just now")
  })

  test("minute-scale deltas read as 'Xm ago'", () => {
    expect(formatRelativeTime(now - 2 * 60_000, now)).toBe("2m ago")
    expect(formatRelativeTime(now - 59 * 60_000, now)).toBe("59m ago")
  })

  test("hour-scale deltas read as 'Xh ago'", () => {
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago")
    expect(formatRelativeTime(now - 23 * 3_600_000, now)).toBe("23h ago")
  })

  test("day-scale deltas read as 'Xd ago'", () => {
    expect(formatRelativeTime(now - 5 * 86_400_000, now)).toBe("5d ago")
    expect(formatRelativeTime(now - 29 * 86_400_000, now)).toBe("29d ago")
  })

  test("month-scale deltas read as 'Xmo ago'", () => {
    expect(formatRelativeTime(now - 60 * 86_400_000, now)).toBe("2mo ago")
  })

  test("year-scale deltas read as 'Xy ago'", () => {
    expect(formatRelativeTime(now - 400 * 86_400_000, now)).toBe("1y ago")
  })

  test("clamps a future timestamp (clock skew) to 'just now' instead of a negative duration", () => {
    expect(formatRelativeTime(now + 10_000, now)).toBe("just now")
  })

  test("defaults nowMs to Date.now() when omitted", () => {
    const recent = Date.now() - 1000
    expect(formatRelativeTime(recent)).toBe("just now")
  })
})
