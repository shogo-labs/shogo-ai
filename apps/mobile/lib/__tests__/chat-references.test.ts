// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import {
  baseMentionLabel,
  clampSelectionText,
  MAX_SELECTION_CHARS,
  referenceKey,
  uniqueMentionLabel,
  type ChatReference,
  type ChatReferenceInput,
} from "../chat-references"

const selection = (path: string, startLine: number, endLine: number): ChatReferenceInput => ({
  type: "selection",
  path,
  name: path.split("/").pop()!,
  startLine,
  endLine,
  text: "x",
})

describe("referenceKey", () => {
  test("covers every variant", () => {
    expect(referenceKey({ type: "file", path: "a/b.ts", name: "b.ts" })).toBe("file:a/b.ts")
    expect(referenceKey({ type: "folder", path: "a", name: "a" })).toBe("folder:a")
    expect(referenceKey(selection("a/b.ts", 3, 9))).toBe("selection:a/b.ts:3-9")
    expect(
      referenceKey({ type: "selection", path: "a/b.ts", name: "b.ts", startLine: 3, endLine: 9, text: "x", rootId: "mounted-1" }),
    ).toBe("selection:mounted-1/a/b.ts:3-9")
    expect(referenceKey({ type: "project", id: "p1", name: "P" })).toBe("project:p1")
    expect(referenceKey({ type: "chat", id: "c1", name: "C" })).toBe("chat:c1")
    expect(referenceKey({ type: "plan", planId: "pl1", filename: "x.plan.md", name: "X" })).toBe("plan:pl1")
    expect(referenceKey({ type: "workspace", id: "w1", name: "W", slug: "w" })).toBe("workspace:w1")
    expect(referenceKey({ type: "mention", id: "u1", name: "Ann" })).toBe("mention:u1")
  })
  test("different ranges of the same file are different references", () => {
    expect(referenceKey(selection("a.ts", 1, 2))).not.toBe(referenceKey(selection("a.ts", 1, 3)))
  })
})

describe("baseMentionLabel", () => {
  test("selection: range vs single line", () => {
    expect(baseMentionLabel(selection("src/ide/CodeEditor.tsx", 10, 20))).toBe("@CodeEditor.tsx:10-20")
    expect(baseMentionLabel(selection("src/ide/CodeEditor.tsx", 7, 7))).toBe("@CodeEditor.tsx:7")
  })
  test("keeps the existing @ menu labels", () => {
    expect(baseMentionLabel({ type: "file", path: "a/b.ts", name: "b.ts" })).toBe("@b.ts")
    expect(baseMentionLabel({ type: "project", id: "p", name: "My App" })).toBe("@my-app")
    expect(baseMentionLabel({ type: "chat", id: "c1", name: "Fix  <the> bug" })).toBe("@Fix the bug")
    expect(baseMentionLabel({ type: "plan", planId: "p", filename: "f.plan.md", name: "Fix Auth" })).toBe("@plan:fix-auth")
  })
})

describe("uniqueMentionLabel", () => {
  const existing = (refs: ChatReferenceInput[]): ChatReference[] =>
    refs.map((r) => ({ ...r, label: baseMentionLabel(r) }) as ChatReference)

  test("no collision -> base label", () => {
    expect(uniqueMentionLabel(selection("a/b.ts", 1, 2), [])).toBe("@b.ts:1-2")
  })

  test("collision with a different reference prefixes parent directories", () => {
    const refs = existing([{ type: "file", path: "src/ide/CodeEditor.tsx", name: "CodeEditor.tsx" }])
    expect(uniqueMentionLabel({ type: "file", path: "src/chat/CodeEditor.tsx", name: "CodeEditor.tsx" }, refs)).toBe(
      "@chat/CodeEditor.tsx",
    )
  })

  test("repeated collisions go deeper", () => {
    const refs: ChatReference[] = [
      { type: "file", path: "a/x/ide/f.ts", name: "f.ts", label: "@f.ts" },
      { type: "file", path: "b/y/ide/f.ts", name: "f.ts", label: "@ide/f.ts" },
    ]
    expect(uniqueMentionLabel({ type: "file", path: "c/z/ide/f.ts", name: "f.ts" }, refs)).toBe("@z/ide/f.ts")
  })

  test("selections disambiguate the same way", () => {
    const refs = existing([selection("src/ide/CodeEditor.tsx", 10, 20)])
    expect(uniqueMentionLabel(selection("src/chat/CodeEditor.tsx", 10, 20), refs)).toBe("@chat/CodeEditor.tsx:10-20")
  })

  test("the same reference keeps its label", () => {
    const refs: ChatReference[] = [{ type: "file", path: "a/b.ts", name: "b.ts", label: "@a/b.ts" }]
    expect(uniqueMentionLabel({ type: "file", path: "a/b.ts", name: "b.ts" }, refs)).toBe("@a/b.ts")
  })

  test("non-path references fall back to a numeric suffix", () => {
    const refs: ChatReference[] = [{ type: "project", id: "p1", name: "App", label: "@app" }]
    expect(uniqueMentionLabel({ type: "project", id: "p2", name: "App" }, refs)).toBe("@app~2")
  })
})

describe("clampSelectionText", () => {
  test("at the limit is untouched", () => {
    const text = "a".repeat(MAX_SELECTION_CHARS)
    expect(clampSelectionText(text)).toEqual({ text, truncated: false })
  })
  test("over the limit is cut and flagged", () => {
    const r = clampSelectionText("a".repeat(MAX_SELECTION_CHARS + 5))
    expect(r.text.length).toBe(MAX_SELECTION_CHARS)
    expect(r.truncated).toBe(true)
  })
})
