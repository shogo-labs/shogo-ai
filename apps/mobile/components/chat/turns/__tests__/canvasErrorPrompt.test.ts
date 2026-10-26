// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import {
  CANVAS_ERROR_MAX_LINE,
  buildCanvasErrorDebugPrompt,
  parseCanvasErrorDebugPrompt,
} from "../canvasErrorPrompt"

const ts = Date.UTC(2026, 0, 2, 3, 4, 5, 678)

describe("canvasErrorPrompt", () => {
  test("round-trips a runtime error with a route, actions, and logs", () => {
    const prompt = buildCanvasErrorDebugPrompt({
      phase: "runtime",
      error: "TypeError: Cannot read properties of undefined",
      route: "/settings?tab=billing",
      recentActions: [
        { ts, kind: "click", target: "Save", route: "/settings?tab=billing" },
        { ts: ts + 1000, kind: "navigate", route: "/home" },
      ],
      recentLogs: [
        { ts, source: "console", level: "error", text: "render failed" },
        { ts: ts + 50, source: "build", level: "info", text: "hmr update" },
      ],
    })

    expect(parseCanvasErrorDebugPrompt(prompt)).toEqual({
      phase: "runtime",
      route: "/settings?tab=billing",
      error: "TypeError: Cannot read properties of undefined",
      actions: [
        "03:04:05.678 click Save",
        "03:04:06.678 navigate @ /home",
      ],
      logs: [
        "03:04:05.678 [console] ERROR render failed",
        "03:04:05.728 [build] hmr update",
      ],
    })
    expect(prompt).toContain("Read the relevant files")
  })

  test("round-trips a compile error with no route, actions, or logs", () => {
    const prompt = buildCanvasErrorDebugPrompt({
      phase: "compile",
      error: "Failed to resolve import \"./missing\"",
      recentLogs: [],
    })

    expect(parseCanvasErrorDebugPrompt(prompt)).toEqual({
      phase: "compile",
      error: "Failed to resolve import \"./missing\"",
      actions: [],
      logs: [],
    })
  })

  test("keeps a multiline error inside the error block", () => {
    const prompt = buildCanvasErrorDebugPrompt({
      phase: "runtime",
      error: "ReferenceError: foo is not defined\n    at Page (page.tsx:12:3)",
      recentLogs: [],
    })

    expect(parseCanvasErrorDebugPrompt(prompt)?.error).toBe(
      "ReferenceError: foo is not defined\n    at Page (page.tsx:12:3)",
    )
  })

  test("truncates a single over-long line and still parses it", () => {
    const prompt = buildCanvasErrorDebugPrompt({
      phase: "runtime",
      error: "x".repeat(CANVAS_ERROR_MAX_LINE + 40),
      recentLogs: [],
    })
    const parsed = parseCanvasErrorDebugPrompt(prompt)
    expect(parsed?.error.endsWith("…")).toBe(true)
    expect(parsed?.error.length).toBe(CANVAS_ERROR_MAX_LINE)
  })

  test("returns null for ordinary chat text and a header without an error block", () => {
    expect(parseCanvasErrorDebugPrompt("please rename the button")).toBeNull()
    expect(
      parseCanvasErrorDebugPrompt(
        "🐞 The canvas just hit a runtime error. Please diagnose the root cause and propose / apply a minimal fix.",
      ),
    ).toBeNull()
  })
})
