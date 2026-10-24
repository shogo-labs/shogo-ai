// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import { fileTypeIconFor } from "../file-type-icon"

function label(path: string): string {
  const spec = fileTypeIconFor(path)
  return spec.kind === "badge" ? `badge:${spec.text}` : `glyph:${spec.glyph}`
}

describe("fileTypeIconFor", () => {
  test("picks an icon that matches the file type", () => {
    expect(label("src/App.tsx")).toBe("glyph:atom")
    expect(label("src/index.ts")).toBe("badge:TS")
    expect(label("package.json")).toBe("glyph:braces")
    expect(label("README.md")).toBe("badge:M↓")
    expect(label("reports/Plan.DOCX")).toBe("badge:W")
    expect(label("q3.xlsx")).toBe("badge:X")
    expect(label("deck.pptx")).toBe("badge:P")
    expect(label("Q3-revenue.pdf")).toBe("badge:PDF")
    expect(label("brand/logo.png")).toBe("glyph:image")
    expect(label("scripts/deploy.sh")).toBe("glyph:terminal")
  })

  test("treats dotenv files as secrets and unknown types as a plain file", () => {
    expect(label(".env")).toBe("glyph:lock")
    expect(label("apps/api/.env.local")).toBe("glyph:lock")
    expect(label("Makefile")).toBe("glyph:file")
    expect(label("data.unknownext")).toBe("glyph:file")
  })
})
