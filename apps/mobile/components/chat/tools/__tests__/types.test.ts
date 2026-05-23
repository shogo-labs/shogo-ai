// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for chat tool type helpers (category, display name, key arg).
 */
import { describe, expect, test } from "bun:test"
import {
  GRADIENT_CONFIG,
  formatToolName,
  getGradientOpacity,
  getToolCategory,
  getToolKeyArg,
  getToolNamespace,
} from "../types"

describe("getToolCategory", () => {
  test("mcp prefix", () => {
    expect(getToolCategory("mcp__shogo__query")).toBe("mcp")
  })

  test("file tools (PascalCase and snake_case)", () => {
    for (const name of [
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "read_file",
      "write_file",
      "edit_file",
      "glob",
      "grep",
      "search",
    ]) {
      expect(getToolCategory(name)).toBe("file")
    }
  })

  test("skill tools", () => {
    for (const name of ["Skill", "Task", "task", "skill"]) {
      expect(getToolCategory(name)).toBe("skill")
    }
  })

  test("bash tools", () => {
    expect(getToolCategory("Bash")).toBe("bash")
    expect(getToolCategory("exec")).toBe("bash")
  })

  test("unknown tools", () => {
    expect(getToolCategory("WebSearch")).toBe("other")
    expect(getToolCategory("custom_tool")).toBe("other")
  })
})

describe("formatToolName", () => {
  test("joins MCP namespace segments with dots", () => {
    expect(formatToolName("mcp__shogo__store_query")).toBe("shogo.store_query")
  })

  test("single MCP segment after prefix", () => {
    expect(formatToolName("mcp__toolname")).toBe("toolname")
  })

  test("non-MCP names unchanged", () => {
    expect(formatToolName("Read")).toBe("Read")
    expect(formatToolName("Bash")).toBe("Bash")
  })
})

describe("getToolNamespace", () => {
  test("returns first MCP segment", () => {
    expect(getToolNamespace("mcp__shogo__store_query")).toBe("shogo")
    expect(getToolNamespace("mcp__github__pr")).toBe("github")
  })

  test("returns null for non-MCP tools", () => {
    expect(getToolNamespace("Read")).toBeNull()
    expect(getToolNamespace("Bash")).toBeNull()
  })

  test("returns null when MCP name has no namespace segment", () => {
    expect(getToolNamespace("mcp__")).toBeNull()
  })
})

describe("getGradientOpacity", () => {
  test("uses configured opacities by index", () => {
    expect(getGradientOpacity(0)).toBe(1)
    expect(getGradientOpacity(1)).toBe(0.85)
    expect(getGradientOpacity(4)).toBe(0.4)
  })

  test("clamps to last opacity for large indices", () => {
    expect(getGradientOpacity(99)).toBe(GRADIENT_CONFIG.opacities[GRADIENT_CONFIG.opacities.length - 1])
  })
})

describe("getToolKeyArg", () => {
  test("returns null when args missing", () => {
    expect(getToolKeyArg("Read")).toBeNull()
    expect(getToolKeyArg("Read", undefined)).toBeNull()
  })

  test("ask_user uses first question header", () => {
    expect(
      getToolKeyArg("ask_user", {
        questions: [{ header: "Deploy?", question: "Q", options: [], multiSelect: false }],
      }),
    ).toBe("Deploy?")
  })

  test("ask_user without header falls through", () => {
    expect(getToolKeyArg("ask_user", { questions: [{ question: "Q", options: [], multiSelect: false }] })).toBeNull()
  })

  test("file tools use basename from file_path or path", () => {
    expect(getToolKeyArg("Read", { file_path: "/a/b/c.ts" })).toBe("c.ts")
    expect(getToolKeyArg("write_file", { path: "src/index.ts" })).toBe("index.ts")
    expect(getToolKeyArg("Edit", { path: "only-name" })).toBe("only-name")
    expect(getToolKeyArg("Read", { file_path: "/a/b/" })).toBe("/a/b/")
  })

  test("grep/glob/search truncate long patterns", () => {
    const long = "a".repeat(50)
    expect(getToolKeyArg("Grep", { pattern: "short" })).toBe("short")
    expect(getToolKeyArg("glob", { pattern: long })).toBe("a".repeat(27) + "...")
  })

  test("bash/exec use first line, truncated when long", () => {
    expect(getToolKeyArg("Bash", { command: "bun test\nbun lint" })).toBe("bun test")
    const longLine = "x".repeat(50)
    expect(getToolKeyArg("exec", { command: longLine })).toBe("x".repeat(37) + "...")
  })

  test("browser navigate truncates URL; other actions return action", () => {
    expect(getToolKeyArg("browser", { action: "click" })).toBe("click")
    const longUrl = "https://" + "x".repeat(40)
    expect(getToolKeyArg("browser", { action: "navigate", url: longUrl })).toBe(longUrl.slice(0, 27) + "...")
    expect(getToolKeyArg("browser", { action: "navigate", url: "https://example.com" })).toBe(
      "https://example.com",
    )
  })

  test("Task and Skill", () => {
    expect(getToolKeyArg("Task", { description: "a".repeat(40) })).toBe("a".repeat(27) + "...")
    expect(getToolKeyArg("Task", { description: "short task" })).toBe("short task")
    expect(getToolKeyArg("Task", {})).toBeNull()
    expect(getToolKeyArg("Skill", { skill: "babysit" })).toBe("babysit")
  })

  test("grep and bash without matching args fall through", () => {
    expect(getToolKeyArg("Grep", {})).toBeNull()
    expect(getToolKeyArg("Bash", {})).toBeNull()
  })

  test("mcp__shogo__ schema, store, and view helpers", () => {
    expect(getToolKeyArg("mcp__shogo__schema_create", { name: "User" })).toBe("User")
    expect(getToolKeyArg("mcp__shogo__schema_list", { schemaName: "core" })).toBe("core")
    expect(getToolKeyArg("mcp__shogo__store_query", { model: "User", schema: "app" })).toBe("app.User")
    expect(getToolKeyArg("mcp__shogo__store_query", { model: "User" })).toBe("User")
    expect(getToolKeyArg("mcp__shogo__view_render", { view: "dashboard" })).toBe("dashboard")
    expect(getToolKeyArg("mcp__shogo__view_list", { name: "home" })).toBe("home")
  })

  test("mcp__obsidian prefers filename, query, directory", () => {
    expect(getToolKeyArg("mcp__obsidian__search", { query: "notes" })).toBe("notes")
    expect(getToolKeyArg("mcp__obsidian__open", { filename: "daily.md" })).toBe("daily.md")
    expect(getToolKeyArg("mcp__obsidian__list", { directory: "vault/inbox" })).toBe("vault/inbox")
  })

  test("mcp__chrome-devtools__ actions", () => {
    expect(getToolKeyArg("mcp__chrome-devtools__navigate_page", { url: "https://a.com" })).toBe(
      "https://a.com",
    )
    expect(getToolKeyArg("mcp__chrome-devtools__click", { uid: "btn-1" })).toBe("btn-1")
    expect(getToolKeyArg("mcp__chrome-devtools__evaluate_script", {})).toBe("script")
    expect(getToolKeyArg("mcp__chrome-devtools__take_screenshot", { fullPage: true })).toBe("full page")
    expect(getToolKeyArg("mcp__chrome-devtools__take_screenshot", {})).toBe("viewport")
  })

  test("fallback string keys with truncation", () => {
    expect(getToolKeyArg("custom_tool", { name: "widget" })).toBe("widget")
    const long = "z".repeat(40)
    expect(getToolKeyArg("custom_tool", { url: long })).toBe("z".repeat(27) + "...")
  })

  test("returns null when no matching arg keys", () => {
    expect(getToolKeyArg("Read", {})).toBeNull()
    expect(getToolKeyArg("custom_tool", { count: 3 })).toBeNull()
  })
})
