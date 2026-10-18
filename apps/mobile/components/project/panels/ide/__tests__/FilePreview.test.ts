// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The shared preview chooser decides which viewer a file gets in both the IDE
 * editor and the workspace file viewer. Pin the mapping here.
 */
import { describe, expect, test } from "bun:test"
import { isPreviewLanguage, previewLanguageFor, PREVIEW_LANGUAGES } from "../FilePreview"

describe("previewLanguageFor", () => {
  test.each([
    ["photo.png", "image"],
    ["logo.SVG", "image"],
    ["data.db", "sqlite"],
    ["data.sqlite3", "sqlite"],
    ["report.pdf", "pdf"],
    ["song.mp3", "audio"],
    ["clip.mp4", "video"],
    ["Inter.woff2", "font"],
  ])("%s is previewed as %s", (path, kind) => {
    expect(previewLanguageFor(path)).toBe(kind as "image")
  })

  test.each(["index.ts", "README.md", "config.json", "archive.zip"])("%s has no preview", (path) => {
    expect(previewLanguageFor(path)).toBeNull()
  })
})

describe("isPreviewLanguage", () => {
  test("accepts every preview kind", () => {
    for (const kind of PREVIEW_LANGUAGES) expect(isPreviewLanguage(kind)).toBe(true)
  })

  test("rejects editor languages and empty values", () => {
    expect(isPreviewLanguage("typescript")).toBe(false)
    expect(isPreviewLanguage("markdown")).toBe(false)
    expect(isPreviewLanguage("")).toBe(false)
    expect(isPreviewLanguage(null)).toBe(false)
    expect(isPreviewLanguage(undefined)).toBe(false)
  })
})
