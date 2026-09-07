// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for workSummary.ts — tallyWork / classifyWorkKind /
 * buildWorkLabel / summarizeWork / summarizeTurn /
 * buildFallbackWorkedLabel / formatThoughtLabel.
 */
import { describe, expect, test } from "bun:test"
import {
  tallyWork,
  classifyWorkKind,
  buildWorkLabel,
  summarizeWork,
  summarizeTurn,
  buildFallbackWorkedLabel,
  formatThoughtLabel,
  THOUGHT_BRIEFLY_THRESHOLD_S,
  type WorkCounts,
} from "../workSummary"
import type { GroupedMessagePart, MessagePart } from "../types"
import type { ToolCallData } from "../../tools/types"

let uid = 0
function nextId(prefix: string): string {
  uid++
  return `${prefix}-${uid}`
}

function tool(toolName: string, args: Record<string, unknown> = {}): MessagePart {
  const id = nextId("tool")
  return {
    type: "tool",
    id,
    tool: {
      id,
      toolName,
      category: "other",
      state: "success",
      args,
      timestamp: Date.now(),
    } as ToolCallData,
  }
}

const emptyCounts: WorkCounts = { editedFiles: 0, readFiles: 0, searches: 0, fetches: 0, commands: 0 }

describe("tallyWork", () => {
  test("counts a write_file as an edited file with added lines from content", () => {
    const parts = [tool("write_file", { path: "/a.ts", content: "line1\nline2\nline3" })]
    const { counts, added, removed } = tallyWork(parts)
    expect(counts.editedFiles).toBe(1)
    expect(added).toBe(3)
    expect(removed).toBe(0)
  })

  test("dedupes multiple edits to the same path into one editedFiles count", () => {
    const parts = [
      tool("edit_file", { path: "/a.ts", old_string: "x", new_string: "y" }),
      tool("edit_file", { path: "/a.ts", old_string: "y", new_string: "z" }),
    ]
    const { counts } = tallyWork(parts)
    expect(counts.editedFiles).toBe(1)
  })

  test("computes added/removed line diff for edit_file from old_string/new_string", () => {
    const parts = [tool("edit_file", { path: "/a.ts", old_string: "a\nb\nc", new_string: "a\nx\nc" })]
    const { added, removed } = tallyWork(parts)
    expect(added).toBe(1)
    expect(removed).toBe(1)
  })

  test("counts Read as readFiles", () => {
    const parts = [tool("Read", { path: "/a.ts" })]
    const { counts } = tallyWork(parts)
    expect(counts.readFiles).toBe(1)
  })

  test("counts Grep/Glob/web-search verbs as searches", () => {
    const parts = [tool("Grep", { pattern: "foo" }), tool("Glob", { pattern: "*.ts" })]
    const { counts } = tallyWork(parts)
    expect(counts.searches).toBe(2)
  })

  test("counts Fetch as fetches", () => {
    const parts = [tool("WebFetch", { url: "https://example.com" })]
    const { counts } = tallyWork(parts)
    expect(counts.fetches).toBe(1)
  })

  test("counts a generic shell command (exec) as commands", () => {
    const parts = [tool("exec", { command: "bun test" })]
    const { counts } = tallyWork(parts)
    expect(counts.commands).toBe(1)
  })

  test("an exploration-verb exec (e.g. cat/reading via shell) does not double-count as a command", () => {
    const parts = [tool("exec", { command: "cat foo.txt" })]
    const { counts } = tallyWork(parts)
    // `cat` resolves to a Read verb, so it should NOT land in `commands`.
    expect(counts.commands).toBe(0)
  })

  test("reasoning parts are ignored (transparent)", () => {
    const parts: MessagePart[] = [
      tool("Read", { path: "/a.ts" }),
      { type: "reasoning", id: nextId("r"), text: "thinking", isStreaming: false },
    ]
    const { counts } = tallyWork(parts)
    expect(counts.readFiles).toBe(1)
  })

  test("empty input yields all-zero counts", () => {
    const { counts, added, removed } = tallyWork([])
    expect(counts).toEqual(emptyCounts)
    expect(added).toBe(0)
    expect(removed).toBe(0)
  })
})

describe("classifyWorkKind", () => {
  test("edited takes priority when any files were edited", () => {
    expect(classifyWorkKind({ ...emptyCounts, editedFiles: 1, readFiles: 5, commands: 3 })).toBe("edited")
  })

  test("explored when there's no edit but reads/searches/fetches exist", () => {
    expect(classifyWorkKind({ ...emptyCounts, readFiles: 1 })).toBe("explored")
    expect(classifyWorkKind({ ...emptyCounts, searches: 1 })).toBe("explored")
    expect(classifyWorkKind({ ...emptyCounts, fetches: 1 })).toBe("explored")
  })

  test("ran when only commands (or nothing) is present", () => {
    expect(classifyWorkKind({ ...emptyCounts, commands: 3 })).toBe("ran")
    expect(classifyWorkKind(emptyCounts)).toBe("ran")
  })
})

describe("buildWorkLabel", () => {
  test("edited + past tense: 'Edited N files, explored ..., ran N commands'", () => {
    const counts: WorkCounts = { editedFiles: 11, readFiles: 0, searches: 3, fetches: 1, commands: 13 }
    expect(buildWorkLabel(counts, "edited", "past")).toBe(
      "Edited 11 files, explored 3 searches, 1 fetch, ran 13 commands",
    )
  })

  test("edited + present tense uses 'Editing' but keeps trailing segments past tense", () => {
    const counts: WorkCounts = { editedFiles: 32, readFiles: 0, searches: 1, fetches: 0, commands: 23 }
    expect(buildWorkLabel(counts, "edited", "present")).toBe(
      "Editing 32 files, explored 1 search, ran 23 commands",
    )
  })

  test("edited with singular file count uses singular noun", () => {
    const counts: WorkCounts = { editedFiles: 1, readFiles: 0, searches: 0, fetches: 0, commands: 0 }
    expect(buildWorkLabel(counts, "edited", "past")).toBe("Edited 1 file")
  })

  test("explored + past tense: 'Explored N files, N searches, ran N commands'", () => {
    const counts: WorkCounts = { editedFiles: 0, readFiles: 14, searches: 9, fetches: 0, commands: 4 }
    expect(buildWorkLabel(counts, "explored", "past")).toBe("Explored 14 files, 9 searches, ran 4 commands")
  })

  test("explored + present tense uses 'Exploring'", () => {
    const counts: WorkCounts = { editedFiles: 0, readFiles: 2, searches: 0, fetches: 0, commands: 0 }
    expect(buildWorkLabel(counts, "explored", "present")).toBe("Exploring 2 files")
  })

  test("ran: 'Ran N commands' / 'Running N commands'", () => {
    const counts: WorkCounts = { editedFiles: 0, readFiles: 0, searches: 0, fetches: 0, commands: 3 }
    expect(buildWorkLabel(counts, "ran", "past")).toBe("Ran 3 commands")
    expect(buildWorkLabel(counts, "ran", "present")).toBe("Running 3 commands")
  })

  test("ran with a single command uses singular noun", () => {
    const counts: WorkCounts = { editedFiles: 0, readFiles: 0, searches: 0, fetches: 0, commands: 1 }
    expect(buildWorkLabel(counts, "ran", "past")).toBe("Ran 1 command")
  })
})

describe("summarizeWork", () => {
  test("end-to-end: mixed edit run produces the correct kind, label, and diff counts", () => {
    const parts = [
      tool("Read", { path: "/a.ts" }),
      tool("edit_file", { path: "/b.ts", old_string: "a\nb", new_string: "a\nc\nd" }),
      tool("exec", { command: "bun test" }),
    ]
    const summary = summarizeWork(parts, "past")
    expect(summary.kind).toBe("edited")
    expect(summary.label).toContain("Edited 1 file")
    expect(summary.added).toBe(2)
    expect(summary.removed).toBe(1)
  })

  test("a pure read/search run without edits classifies as explored", () => {
    const parts = [tool("Read", { path: "/a.ts" }), tool("Grep", { pattern: "x" })]
    const summary = summarizeWork(parts, "past")
    expect(summary.kind).toBe("explored")
    expect(summary.added).toBe(0)
    expect(summary.removed).toBe(0)
  })
})

describe("summarizeTurn / buildFallbackWorkedLabel", () => {
  function workGroup(items: MessagePart[]): GroupedMessagePart {
    return { type: "work-group", id: nextId("wg"), items }
  }

  test("flattens all work-groups in the work log into one aggregate summary", () => {
    const workLog: GroupedMessagePart[] = [
      workGroup([tool("edit_file", { path: "/a.ts", old_string: "x", new_string: "y" })]),
      { type: "text", id: nextId("t"), text: "interim note" },
      workGroup([tool("exec", { command: "bun test" })]),
    ]
    const summary = summarizeTurn(workLog)
    expect(summary.kind).toBe("edited")
    expect(summary.counts.editedFiles).toBe(1)
    expect(summary.counts.commands).toBe(1)
  })

  test("buildFallbackWorkedLabel lowercases the leading verb after 'Worked · '", () => {
    const workLog: GroupedMessagePart[] = [
      workGroup([
        tool("edit_file", { path: "/a.ts", old_string: "x", new_string: "y" }),
        tool("exec", { command: "bun test" }),
      ]),
    ]
    const label = buildFallbackWorkedLabel(workLog)
    expect(label.startsWith("Worked · edited")).toBe(true)
  })

  test("buildFallbackWorkedLabel with an empty work log still produces a 'Worked · ran 0 commands' label", () => {
    // classifyWorkKind falls back to "ran" with zero counts when there's
    // nothing to tally, so the label is never truly empty — the bare
    // "Worked" fallback only guards a hypothetical empty-label case.
    expect(buildFallbackWorkedLabel([])).toBe("Worked · ran 0 commands")
  })
})

describe("formatThoughtLabel", () => {
  test("streaming always renders 'Thinking…' regardless of duration", () => {
    expect(formatThoughtLabel(30, true)).toBe("Thinking…")
    expect(formatThoughtLabel(undefined, true)).toBe("Thinking…")
  })

  test("undefined duration (not streaming) renders bare 'Thought'", () => {
    expect(formatThoughtLabel(undefined, false)).toBe("Thought")
  })

  test("durations below the brief threshold render 'Thought briefly'", () => {
    expect(formatThoughtLabel(THOUGHT_BRIEFLY_THRESHOLD_S - 1, false)).toBe("Thought briefly")
    expect(formatThoughtLabel(0, false)).toBe("Thought briefly")
  })

  test("durations at/above the brief threshold render 'Thought for Ns'", () => {
    expect(formatThoughtLabel(THOUGHT_BRIEFLY_THRESHOLD_S, false)).toBe(`Thought for ${THOUGHT_BRIEFLY_THRESHOLD_S}s`)
    expect(formatThoughtLabel(42, false)).toBe("Thought for 42s")
  })
})
