// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FEAT-TASKS — unit tests for the pure problem-matcher engine.
 *
 * Pure module, no fs / process / DOM — runs under `bun test`.
 * Pins: severity normalisation; single-line matchers ($tsc/$gcc/$eslint-
 * compact); multi-line loop matcher ($eslint-stylish incl. multiple file
 * blocks + stray lines); custom matchers; fileLocation resolution; ref
 * resolution; and defensive empty/garbage handling.
 */
import { describe, expect, test } from "bun:test"
import {
  applyMatcher,
  applyMatchers,
  builtInMatcherNames,
  getBuiltInMatcher,
  normalizeSeverity,
  resolveFileLocation,
  resolveMatchers,
  type ProblemMatcher,
} from "../problem-matcher"

describe("normalizeSeverity", () => {
  test("maps common tokens", () => {
    expect(normalizeSeverity("error")).toBe("error")
    expect(normalizeSeverity("Error")).toBe("error")
    expect(normalizeSeverity("fatal")).toBe("error")
    expect(normalizeSeverity("warning")).toBe("warning")
    expect(normalizeSeverity("Warn")).toBe("warning")
    expect(normalizeSeverity("info")).toBe("info")
    expect(normalizeSeverity("note")).toBe("info")
  })
  test("unknown / non-string → fallback", () => {
    expect(normalizeSeverity("bogus")).toBe("error")
    expect(normalizeSeverity("bogus", "warning")).toBe("warning")
    expect(normalizeSeverity(undefined, "info")).toBe("info")
  })
})

describe("$tsc (single-line)", () => {
  const m = getBuiltInMatcher("$tsc")!
  test("parses tsc diagnostics", () => {
    const out = applyMatcher(m, [
      "src/app.ts(12,5): error TS2304: Cannot find name 'foo'.",
      "src/util.ts(3,1): warning TS6133: 'x' is declared but never used.",
    ])
    expect(out).toEqual([
      { file: "src/app.ts", line: 12, column: 5, severity: "error", code: "TS2304", message: "Cannot find name 'foo'.", source: "ts" },
      { file: "src/util.ts", line: 3, column: 1, severity: "warning", code: "TS6133", message: "'x' is declared but never used.", source: "ts" },
    ])
  })
  test("ignores non-matching lines", () => {
    expect(applyMatcher(m, ["Compilation complete.", ""])).toEqual([])
  })
})

describe("$gcc (single-line, absolute paths)", () => {
  const m = getBuiltInMatcher("$gcc")!
  test("parses gcc diagnostics incl. note", () => {
    const out = applyMatcher(m, [
      "/proj/main.c:10:5: error: 'x' undeclared (first use in this function)",
      "/proj/main.c:8:1: note: each undeclared identifier is reported only once",
    ])
    expect(out[0]).toMatchObject({ file: "/proj/main.c", line: 10, column: 5, severity: "error" })
    expect(out[1]).toMatchObject({ severity: "info", message: expect.stringContaining("each undeclared") })
  })
})

describe("$eslint-compact (single-line with optional code)", () => {
  const m = getBuiltInMatcher("$eslint-compact")!
  test("parses compact output with rule code", () => {
    const out = applyMatcher(m, ["/p/file.js: line 1, col 1, Error - 'x' is not defined. (no-undef)"])
    expect(out[0]).toMatchObject({ file: "/p/file.js", line: 1, column: 1, severity: "error", message: "'x' is not defined.", code: "no-undef" })
  })
})

describe("$eslint-stylish (multi-line loop matcher)", () => {
  const m = getBuiltInMatcher("$eslint-stylish")!
  test("one file header + multiple message lines", () => {
    const out = applyMatcher(m, [
      "/p/file.js",
      "  1:5  error  'x' is not defined  no-undef",
      "  2:1  warning  Missing semicolon  semi",
      "",
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ file: "/p/file.js", line: 1, column: 5, severity: "error", message: "'x' is not defined", code: "no-undef" })
    expect(out[1]).toMatchObject({ file: "/p/file.js", line: 2, column: 1, severity: "warning", message: "Missing semicolon", code: "semi" })
  })
  test("multiple file blocks", () => {
    const out = applyMatcher(m, [
      "/p/a.js",
      "  1:1  error  A  rule-a",
      "/p/b.js",
      "  2:2  warning  B  rule-b",
    ])
    expect(out.map((d) => d.file)).toEqual(["/p/a.js", "/p/b.js"])
    expect(out[1]).toMatchObject({ line: 2, column: 2, severity: "warning", code: "rule-b" })
  })
  test("message without a trailing rule code", () => {
    const out = applyMatcher(m, ["/p/c.js", "  3:4  error  Parsing error: Unexpected token"])
    expect(out[0]).toMatchObject({ file: "/p/c.js", line: 3, column: 4, message: "Parsing error: Unexpected token" })
    expect(out[0].code).toBeUndefined()
  })
  test("stray message line before any file header is ignored", () => {
    const out = applyMatcher(m, ["  1:1  error  orphan  rule"])
    // the orphan line matches the header pattern (file=that line) but has no
    // following loop matches → no diagnostics emitted
    expect(out).toEqual([])
  })
})

describe("custom matcher", () => {
  const custom: ProblemMatcher = {
    name: "pylint",
    source: "pylint",
    severity: "warning",
    fileLocation: "relative",
    pattern: { regexp: /^(.+?):(\d+):(\d+):\s+(\w\d+):\s+(.+)$/, file: 1, line: 2, column: 3, code: 4, message: 5 },
  }
  test("uses matcher default severity when pattern has no severity capture", () => {
    const out = applyMatcher(custom, ["mod.py:5:0: W0612: Unused variable 'x'"])
    expect(out[0]).toMatchObject({ file: "mod.py", line: 5, column: 0, severity: "warning", code: "W0612", source: "pylint" })
  })
})

describe("applyMatcher edge cases", () => {
  test("accepts a raw string blob (splits on newlines)", () => {
    const m = getBuiltInMatcher("$tsc")!
    expect(applyMatcher(m, "a.ts(1,1): error TS1: boom").length).toBe(1)
  })
  test("empty input / missing pattern → []", () => {
    expect(applyMatcher(getBuiltInMatcher("$tsc")!, [])).toEqual([])
    expect(applyMatcher({ name: "x", pattern: undefined as never }, ["whatever"])).toEqual([])
  })
})

describe("resolveFileLocation", () => {
  const rel: ProblemMatcher = { name: "r", fileLocation: "relative", pattern: { regexp: /x/ } }
  const relBase: ProblemMatcher = { name: "rb", fileLocation: ["relative", "/base/dir"], pattern: { regexp: /x/ } }
  const abs: ProblemMatcher = { name: "a", fileLocation: "absolute", pattern: { regexp: /x/ } }
  test("relative joins workspaceFolder", () => {
    expect(resolveFileLocation(rel, "src/a.ts", "/w")).toBe("/w/src/a.ts")
  })
  test("relative with explicit base array", () => {
    expect(resolveFileLocation(relBase, "a.ts")).toBe("/base/dir/a.ts")
  })
  test("absolute returned untouched", () => {
    expect(resolveFileLocation(abs, "/x/a.ts", "/w")).toBe("/x/a.ts")
  })
  test("already-absolute file not double-joined", () => {
    expect(resolveFileLocation(rel, "/abs/a.ts", "/w")).toBe("/abs/a.ts")
  })
  test("no base → file as-is", () => {
    expect(resolveFileLocation(rel, "a.ts", "")).toBe("a.ts")
  })
})

describe("resolveMatchers + builtins + applyMatchers", () => {
  test("resolves built-in refs, skips unknown", () => {
    const ms = resolveMatchers(["$tsc", "$nope", "$gcc"])
    expect(ms.map((m) => m.name)).toEqual(["$tsc", "$gcc"])
  })
  test("custom takes precedence over built-in name", () => {
    const custom = { $tsc: { name: "override", pattern: { regexp: /z/ } } as ProblemMatcher }
    expect(resolveMatchers(["$tsc"], custom)[0].name).toBe("override")
  })
  test("builtInMatcherNames lists all four", () => {
    expect(builtInMatcherNames().sort()).toEqual(["$eslint-compact", "$eslint-stylish", "$gcc", "$tsc"])
  })
  test("applyMatchers concatenates across matchers", () => {
    const out = applyMatchers([getBuiltInMatcher("$tsc")!, getBuiltInMatcher("$gcc")!], [
      "a.ts(1,2): error TS1: x",
      "/m.c:3:4: warning: y",
    ])
    expect(out).toHaveLength(2)
    expect(out[0].source).toBe("ts")
    expect(out[1].source).toBe("gcc")
  })
})
