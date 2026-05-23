// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for long-text detection, snippets, and paste extraction.
 */
import { describe, expect, test } from "bun:test"
import {
  analyzeContent,
  buildPastedAttachments,
  extractLongPaste,
  kindLabel,
  pastedEntryToAttachment,
  textSnippet,
  type PastedTextEntry,
} from "../long-text-utils"

describe("textSnippet", () => {
  test("returns short text unchanged", () => {
    expect(textSnippet("hello")).toBe("hello")
  })

  test("truncates at word boundary when possible", () => {
    const text = "one two three four five six seven eight nine ten"
    const snippet = textSnippet(text, 20)
    expect(snippet.endsWith("…")).toBe(true)
    expect(snippet.length).toBeLessThanOrEqual(21)
    expect(snippet).not.toContain("nine")
  })

  test("hard-cuts when no space in first maxLen chars", () => {
    const text = "x".repeat(50)
    expect(textSnippet(text, 10)).toBe("x".repeat(10) + "…")
  })
})

describe("kindLabel", () => {
  test("maps content kinds to display labels", () => {
    expect(kindLabel("json")).toBe("JSON")
    expect(kindLabel("code")).toBe("Code")
    expect(kindLabel("markdown")).toBe("Markdown")
    expect(kindLabel("plain")).toBe("Text")
  })
})

describe("analyzeContent", () => {
  test("short plain text is not long", () => {
    const info = analyzeContent("hello world")
    expect(info.kind).toBe("plain")
    expect(info.isLong).toBe(false)
    expect(info.chars).toBe(11)
    expect(info.lines).toBe(1)
  })

  test("detects code from import prefix", () => {
    expect(analyzeContent("import { foo } from 'bar'\nexport const x = 1").kind).toBe("code")
  })

  test("detects markdown from heading", () => {
    expect(analyzeContent("# Title\n\nSome body").kind).toBe("markdown")
  })

  test("detects JSON objects with lower long threshold", () => {
    const json = JSON.stringify({ alpha: "x".repeat(3_000) })
    const info = analyzeContent(json)
    expect(info.kind).toBe("json")
    expect(info.isLong).toBe(true)
  })

  test("marks plain text long by character count", () => {
    const info = analyzeContent("a".repeat(5_001))
    expect(info.isLong).toBe(true)
    expect(info.sizeLabel).toMatch(/KB|B/)
  })

  test("marks text long by line count", () => {
    const info = analyzeContent(Array.from({ length: 151 }, (_, i) => `line ${i}`).join("\n"))
    expect(info.isLong).toBe(true)
    expect(info.lines).toBeGreaterThan(150)
  })
})

describe("extractLongPaste", () => {
  test("returns null when text shrinks", () => {
    expect(extractLongPaste("hello world", "hello")).toBeNull()
  })

  test("returns null for small insertions", () => {
    expect(extractLongPaste("", "short paste")).toBeNull()
  })

  test("returns null when inserted chunk is large but not long-content", () => {
    const prev = ""
    const inserted = "a".repeat(2_500)
    expect(extractLongPaste(prev, inserted)).toBeNull()
  })

  test("detects select-all paste of long content", () => {
    const prev = "replace me"
    const block = "z".repeat(5_100)
    const next = block
    const result = extractLongPaste(prev, next)
    expect(result).not.toBeNull()
    expect(result!.inserted).toBe(block)
    expect(result!.restored).toBe("")
    expect(result!.info.isLong).toBe(true)
  })

  test("detects append paste after existing prefix", () => {
    const prev = "typing "
    const block = "x".repeat(5_100)
    const next = prev + block
    const result = extractLongPaste(prev, next)
    expect(result!.inserted).toBe(block)
    expect(result!.restored).toBe("typing ")
  })
})

describe("pasted attachments", () => {
  const entry = (kind: PastedTextEntry["info"]["kind"], content: string): PastedTextEntry => ({
    id: "1",
    content,
    info: { ...analyzeContent(content), kind },
  })

  test("pastedEntryToAttachment names and types by kind", () => {
    const att = pastedEntryToAttachment(entry("json", '{"a":1}'))
    expect(att.name).toBe("Pasted json.json")
    expect(att.type).toBe("application/json")
    expect(att.dataUrl.startsWith("data:")).toBe(true)
  })

  test("increments duplicate kind filenames", () => {
    const first = pastedEntryToAttachment(entry("markdown", "# Hi"), 0)
    const second = pastedEntryToAttachment(entry("markdown", "# Bye"), 1)
    expect(first.name).toBe("Pasted markdown.md")
    expect(second.name).toBe("Pasted markdown (2).md")
  })

  test("buildPastedAttachments numbers per kind independently", () => {
    const attachments = buildPastedAttachments([
      entry("json", '{"a":1}'),
      entry("json", '{"b":2}'),
      entry("plain", "hello"),
    ])
    expect(attachments.map((a) => a.name)).toEqual([
      "Pasted json.json",
      "Pasted json (2).json",
      "Pasted text.txt",
    ])
  })
})
