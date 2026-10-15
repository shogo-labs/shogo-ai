// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, mock, test } from "bun:test"
import React from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"
import type { ToolCallData } from "../../tools/types"

mock.module("react-native", () => createReactNativeMock())
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
let diffCalls = 0
mock.module(require.resolve("../diff-utils"), () => ({
  computeLineDiff: (...args: unknown[]) => {
    diffCalls++
    const [oldString, newString] = args as [string, string]
    return [
      ...oldString.split("\n").map((text) => ({ type: "removed", text })),
      ...newString.split("\n").map((text) => ({ type: "added", text })),
    ]
  },
}))

const { render, screen } = await import("@testing-library/react")
const { WriteFileWidget } = await import("../WriteFileWidget")
const { EditFileWidget } = await import("../EditFileWidget")

const content = Array.from({ length: 120 }, (_, i) => `const line${i} = ${i}`).join("\n")

const writeTool = (state: ToolCallData["state"]): ToolCallData => ({
  id: "w1",
  toolName: "write_file",
  category: "file",
  state,
  args: { path: "src/big.ts", content },
  timestamp: 0,
}) as ToolCallData

describe("WriteFileWidget while streaming", () => {
  test("shows a line/size summary and none of the streamed code", () => {
    render(<WriteFileWidget tool={writeTool("streaming")} isExpanded />)
    expect(screen.getByText(/Writing… 120 lines · /)).toBeTruthy()
    expect(screen.queryByText("const line5 = 5")).toBeNull()
  })

  test("shows the code once the call finishes", () => {
    render(<WriteFileWidget tool={writeTool("success")} isExpanded />)
    expect(screen.getByText("const line5 = 5")).toBeTruthy()
    expect(screen.queryByText(/Writing…/)).toBeNull()
  })
})

describe("EditFileWidget while streaming", () => {
  const editTool = (state: ToolCallData["state"]): ToolCallData => ({
    id: "e1",
    toolName: "edit_file",
    category: "file",
    state,
    args: { path: "src/big.ts", old_string: "a\nb", new_string: "a\nb\nc" },
    timestamp: 0,
  }) as ToolCallData

  test("skips the line diff and shows line counts", () => {
    diffCalls = 0
    render(<EditFileWidget tool={editTool("streaming")} isExpanded />)
    expect(diffCalls).toBe(0)
    expect(screen.getByText("Editing…")).toBeTruthy()
    expect(screen.getByText("+3")).toBeTruthy()
    expect(screen.getByText("-2")).toBeTruthy()
  })

  test("computes the diff once finished", () => {
    diffCalls = 0
    render(<EditFileWidget tool={editTool("success")} isExpanded />)
    expect(diffCalls).toBe(1)
    expect(screen.queryByText("Editing…")).toBeNull()
  })
})
