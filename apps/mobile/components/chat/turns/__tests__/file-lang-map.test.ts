// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for file path → language helpers used in diff/file turn UI.
 */
import { describe, expect, test } from "bun:test"
import { getBasename, getLanguageFromPath, getLanguageLabel } from "../file-lang-map"

describe("getLanguageFromPath", () => {
  test("maps common extensions", () => {
    expect(getLanguageFromPath("src/App.tsx")).toBe("tsx")
    expect(getLanguageFromPath("lib/util.ts")).toBe("typescript")
    expect(getLanguageFromPath("main.py")).toBe("python")
    expect(getLanguageFromPath("schema.prisma")).toBe("prisma")
  })

  test("dockerfile names", () => {
    expect(getLanguageFromPath("Dockerfile")).toBe("dockerfile")
    expect(getLanguageFromPath("docker/Dockerfile.prod")).toBe("dockerfile")
  })

  test("makefile names", () => {
    expect(getLanguageFromPath("Makefile")).toBe("makefile")
    expect(getLanguageFromPath("GNUmakefile")).toBe("makefile")
  })

  test("returns text for unknown or extensionless paths", () => {
    expect(getLanguageFromPath("README")).toBe("text")
    expect(getLanguageFromPath("LICENSE")).toBe("text")
    expect(getLanguageFromPath("notes.xyz")).toBe("text")
  })
})

describe("getLanguageLabel", () => {
  test("returns friendly labels for known languages", () => {
    expect(getLanguageLabel("App.tsx")).toBe("TSX")
    expect(getLanguageLabel("main.py")).toBe("Python")
    expect(getLanguageLabel("deploy.yml")).toBe("YAML")
  })

  test("capitalizes unknown language ids", () => {
    expect(getLanguageLabel("README")).toBe("Text")
  })
})

describe("getBasename", () => {
  test("returns last path segment", () => {
    expect(getBasename("src/components/App.tsx")).toBe("App.tsx")
    expect(getBasename("package.json")).toBe("package.json")
  })

  test("returns original string when no slash", () => {
    expect(getBasename("App.tsx")).toBe("App.tsx")
  })
})
