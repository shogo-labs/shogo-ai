// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the tool-summary helper that powers the minimal text-only
 * tool rows in the chat thread.
 */
import { describe, expect, test } from "bun:test"
import { getToolSummary, parseShellCommand } from "../summary"

describe("getToolSummary — built-in tools", () => {
  test("read_file returns Read + basename", () => {
    expect(getToolSummary("read_file", { path: "/Users/me/proj/package.json" })).toEqual({
      verb: "Read",
      target: "package.json",
    })
    expect(getToolSummary("Read", { file_path: "/a/b/c.ts" })).toEqual({
      verb: "Read",
      target: "c.ts",
    })
  })

  test("Delete returns Delete + basename", () => {
    expect(getToolSummary("Delete", { file_path: "/tmp/foo.txt" })).toEqual({
      verb: "Delete",
      target: "foo.txt",
    })
  })

  test("Grep returns Search for + truncated pattern", () => {
    expect(getToolSummary("Grep", { pattern: "useShogoVoice" })).toEqual({
      verb: "Search for",
      target: "useShogoVoice",
    })
    const long = "a".repeat(50)
    const summary = getToolSummary("Grep", { pattern: long })
    expect(summary.verb).toBe("Search for")
    expect(summary.target?.length).toBeLessThanOrEqual(30)
    expect(summary.target?.endsWith("…")).toBe(true)
  })

  test("Glob returns Find files matching + pattern", () => {
    expect(getToolSummary("Glob", { glob_pattern: "**/*.ts" })).toEqual({
      verb: "Find files matching",
      target: "**/*.ts",
    })
  })

  test("read_lints with paths returns basename target", () => {
    expect(getToolSummary("read_lints", { paths: ["a/b/c.ts"] })).toEqual({
      verb: "Read lints",
      target: "c.ts",
    })
  })

  test("read_lints with no args returns no target", () => {
    expect(getToolSummary("read_lints", {})).toEqual({ verb: "Read lints" })
    expect(getToolSummary("ReadLints")).toEqual({ verb: "Read lints" })
  })

  test("WebSearch returns Search the web for + term", () => {
    expect(getToolSummary("WebSearch", { search_term: "foo" })).toEqual({
      verb: "Search the web for",
      target: "foo",
    })
  })

  test("WebFetch returns Fetch + URL host", () => {
    expect(getToolSummary("WebFetch", { url: "https://example.com/x/y" })).toEqual({
      verb: "Fetch",
      target: "example.com",
    })
  })
})

describe("getToolSummary — Bash/exec dispatch", () => {
  test("Bash with command defers to parseShellCommand", () => {
    expect(getToolSummary("Bash", { command: "cat /a/b/package.json" })).toEqual({
      verb: "Read",
      target: "package.json",
    })
  })

  test("exec with command defers to parseShellCommand", () => {
    expect(getToolSummary("exec", { command: "ls" })).toEqual({ verb: "List" })
  })

  test("Bash with no command falls back to Run", () => {
    expect(getToolSummary("Bash", {})).toEqual({ verb: "Run" })
  })
})

describe("parseShellCommand — file readers", () => {
  test("cat resolves to Read + basename", () => {
    expect(parseShellCommand("cat /a/b/package.json")).toEqual({
      verb: "Read",
      target: "package.json",
    })
  })

  test("head/tail/less/more all resolve to Read", () => {
    expect(parseShellCommand("head -n 20 foo.txt").verb).toBe("Read")
    expect(parseShellCommand("tail -f log.txt").verb).toBe("Read")
    expect(parseShellCommand("less foo.txt").verb).toBe("Read")
    expect(parseShellCommand("more foo.txt").verb).toBe("Read")
  })
})

describe("parseShellCommand — navigation", () => {
  test("cd resolves to cd + basename", () => {
    expect(parseShellCommand("cd /Users/foo")).toEqual({ verb: "cd", target: "foo" })
  })

  test("ls with path", () => {
    expect(parseShellCommand("ls /tmp/foo")).toEqual({ verb: "List", target: "foo" })
  })

  test("ls without args", () => {
    expect(parseShellCommand("ls")).toEqual({ verb: "List" })
  })

  test("pwd is bare", () => {
    expect(parseShellCommand("pwd")).toEqual({ verb: "pwd" })
  })
})

describe("parseShellCommand — search", () => {
  test("grep with quoted pattern keeps the pattern", () => {
    expect(parseShellCommand("grep -n 'useShogo' src")).toEqual({
      verb: "Search for",
      target: "useShogo",
    })
  })

  test("rg with pattern", () => {
    expect(parseShellCommand("rg -i 'foo bar' .")).toEqual({
      verb: "Search for",
      target: "foo bar",
    })
  })

  test("find returns first non-flag arg", () => {
    expect(parseShellCommand("find /tmp -name foo")).toEqual({
      verb: "Find in",
      target: "tmp",
    })
  })
})

describe("parseShellCommand — git", () => {
  test("git status", () => {
    expect(parseShellCommand("git status")).toEqual({ verb: "git status" })
  })

  test("git commit -m 'foo'", () => {
    expect(parseShellCommand("git commit -m 'foo'")).toEqual({ verb: "git commit" })
  })

  test("bare git", () => {
    expect(parseShellCommand("git")).toEqual({ verb: "git" })
  })
})

describe("parseShellCommand — package managers", () => {
  test("bun run dev", () => {
    expect(parseShellCommand("bun run dev")).toEqual({ verb: "Run", target: "dev" })
  })

  test("npm install foo", () => {
    expect(parseShellCommand("npm install foo")).toEqual({ verb: "Install", target: "foo" })
  })

  test("pnpm add bar", () => {
    expect(parseShellCommand("pnpm add bar")).toEqual({ verb: "Install", target: "bar" })
  })

  test("npm install (bare)", () => {
    expect(parseShellCommand("npm install")).toEqual({ verb: "Install" })
  })
})

describe("parseShellCommand — runners", () => {
  test("node script.js", () => {
    expect(parseShellCommand("node /a/b/script.js")).toEqual({
      verb: "Run",
      target: "script.js",
    })
  })

  test("python file.py", () => {
    expect(parseShellCommand("python foo.py")).toEqual({ verb: "Run", target: "foo.py" })
  })
})

describe("parseShellCommand — fetch", () => {
  test("curl URL", () => {
    expect(parseShellCommand("curl https://api.example.com/x")).toEqual({
      verb: "Fetch",
      target: "api.example.com",
    })
  })

  test("wget URL", () => {
    expect(parseShellCommand("wget -O - https://example.com")).toEqual({
      verb: "Fetch",
      target: "example.com",
    })
  })
})

describe("parseShellCommand — pipelines", () => {
  test("first segment of pipe wins", () => {
    expect(parseShellCommand("ls | grep foo")).toEqual({ verb: "List" })
  })

  test("first segment of ; wins", () => {
    expect(parseShellCommand("echo a; echo b")).toEqual({ verb: "echo", target: "a" })
  })

  test("multi-line uses first line", () => {
    expect(parseShellCommand("cd foo\nbun test")).toEqual({ verb: "cd", target: "foo" })
  })

  test("leading cd in a chain is skipped", () => {
    expect(parseShellCommand("cd foo && bun test")).toEqual({ verb: "Run", target: "test" })
  })

  test("multiple leading cds are skipped", () => {
    expect(parseShellCommand("cd foo && cd bar && bun run dev")).toEqual({
      verb: "Run",
      target: "dev",
    })
  })

  test("standalone cd is preserved", () => {
    expect(parseShellCommand("cd /Users/foo")).toEqual({ verb: "cd", target: "foo" })
  })

  test("cd followed by ; is also skipped", () => {
    expect(parseShellCommand("cd foo; ls")).toEqual({ verb: "List" })
  })

  test("all-cd chain falls back to last cd", () => {
    expect(parseShellCommand("cd foo && cd bar")).toEqual({ verb: "cd", target: "bar" })
  })
})

describe("parseShellCommand — && chains", () => {
  test("two &&-joined commands produce a rest entry", () => {
    expect(parseShellCommand("bun test && bun lint")).toEqual({
      verb: "Run",
      target: "test",
      rest: [{ verb: "Run", target: "lint" }],
    })
  })

  test("three &&-joined commands produce two rest entries", () => {
    expect(parseShellCommand("git add . && git commit -m foo && git push")).toEqual({
      verb: "git add",
      rest: [{ verb: "git commit" }, { verb: "git push" }],
    })
  })

  test("leading cd is skipped, remaining && segments chain", () => {
    expect(parseShellCommand("cd foo && bun test && bun lint")).toEqual({
      verb: "Run",
      target: "test",
      rest: [{ verb: "Run", target: "lint" }],
    })
  })

  test("mid-chain cd is skipped while still chaining", () => {
    expect(parseShellCommand("bun test && cd foo && bun lint")).toEqual({
      verb: "Run",
      target: "test",
      rest: [{ verb: "Run", target: "lint" }],
    })
  })

  test("; terminates the chain", () => {
    const result = parseShellCommand("bun test; bun lint")
    expect(result).toEqual({ verb: "Run", target: "test" })
    expect(result.rest).toBeUndefined()
  })

  test("| terminates the chain", () => {
    const result = parseShellCommand("ls && grep foo | wc -l")
    expect(result).toEqual({
      verb: "List",
      rest: [{ verb: "Search for", target: "foo" }],
    })
  })

  test("single segment has no rest", () => {
    const result = parseShellCommand("bun test")
    expect(result).toEqual({ verb: "Run", target: "test" })
    expect(result.rest).toBeUndefined()
  })
})

describe("parseShellCommand — fallback", () => {
  test("unknown verb keeps command name", () => {
    expect(parseShellCommand("xyzzy --do-it")).toEqual({ verb: "Run", target: "xyzzy" })
  })

  test("empty command", () => {
    expect(parseShellCommand("")).toEqual({ verb: "Run" })
  })
})

describe("getToolSummary — fallback", () => {
  test("unknown tool falls back to tool name + key arg", () => {
    const summary = getToolSummary("mcp__foo__bar", { name: "baz" })
    expect(summary.verb).toBe("mcp__foo__bar")
    expect(summary.target).toBe("baz")
  })

  test("unknown tool with no useful args", () => {
    expect(getToolSummary("custom_tool")).toEqual({ verb: "custom_tool" })
  })
})
