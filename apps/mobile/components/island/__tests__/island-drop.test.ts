// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { isTextFile, planAddToProject, projectPathForDrop, saveAttachmentsPrompt } from "../island-drop"

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64")

describe("isTextFile", () => {
  test("uses the MIME type, falling back to the extension", () => {
    expect(isTextFile({ name: "notes", type: "text/plain" })).toBe(true)
    expect(isTextFile({ name: "config.yaml", type: "" })).toBe(true)
    expect(isTextFile({ name: "logo.svg", type: "image/svg+xml" })).toBe(true)
    expect(isTextFile({ name: "photo.png", type: "image/png" })).toBe(false)
  })
})

describe("projectPathForDrop", () => {
  test("keeps only a safe base name", () => {
    expect(projectPathForDrop("/Users/me/My Notes (v2).md")).toBe("My_Notes_v2_.md")
    expect(projectPathForDrop("C:\\temp\\report.csv")).toBe("report.csv")
    expect(projectPathForDrop("..env")).toBe("env")
    expect(projectPathForDrop("   ")).toBeNull()
  })
})

describe("planAddToProject", () => {
  test("writes UTF-8 text files and leaves binaries for the agent", () => {
    const plan = planAddToProject([
      { name: "README.md", type: "text/markdown", dataUrl: `data:text/markdown;base64,${base64("# Hi ✨")}` },
      { name: "pic.png", type: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
      { name: "latin1.txt", type: "text/plain", dataUrl: "data:text/plain;base64,/w==" },
    ])
    expect(plan.writes).toEqual([{ path: "README.md", content: "# Hi ✨" }])
    expect(plan.attach.map((file) => file.name)).toEqual(["pic.png", "latin1.txt"])
  })
})

describe("saveAttachmentsPrompt", () => {
  test("names every file", () => {
    expect(saveAttachmentsPrompt([{ name: "a.png" }])).toContain("(a.png)")
    expect(saveAttachmentsPrompt([{ name: "a.png" }, { name: "b.pdf" }])).toContain("a.png, b.pdf")
  })
})
