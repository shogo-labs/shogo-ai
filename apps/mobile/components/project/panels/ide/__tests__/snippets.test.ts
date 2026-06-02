// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FEAT-SNIPPETS — unit tests for the pure snippet engine.
 *
 * Pure module, no fs / Monaco / DOM — runs under `bun test`.
 * Pins: snippet-file parsing (prefix/body/scope shapes, JSONC, per-language
 * default scope); source-precedence merge; language filter; prefix match
 * + ordering; the body tokeniser (tabstops/placeholders/choices/variables/
 * transforms/escapes/nesting); variable resolution; and validation.
 */
import { describe, expect, test } from "bun:test"
import {
  matchSnippets,
  mergeSnippets,
  parseSnippetBody,
  parseSnippetsFile,
  resolveSnippetVariable,
  resolveSnippetVariables,
  snippetTabstops,
  snippetsForLanguage,
  validateSnippet,
  type SnippetDefinition,
} from "../snippets"

describe("parseSnippetsFile", () => {
  test("parses prefix string + body array (joined with \\n)", () => {
    const defs = parseSnippetsFile({ "For Loop": { prefix: "for", body: ["for (const x of xs) {", "\t$0", "}"], description: "loop" } }, { language: "javascript" })
    expect(defs).toHaveLength(1)
    expect(defs[0]).toMatchObject({ name: "For Loop", prefixes: ["for"], body: "for (const x of xs) {\n\t$0\n}", description: "loop", scopes: ["javascript"], source: "user" })
  })
  test("prefix array supported", () => {
    expect(parseSnippetsFile({ Log: { prefix: ["log", "clg"], body: "console.log($1)" } })[0].prefixes).toEqual(["log", "clg"])
  })
  test("body as a plain string", () => {
    expect(parseSnippetsFile({ X: { prefix: "x", body: "single" } })[0].body).toBe("single")
  })
  test("scope string is comma-split; overrides the per-language default", () => {
    const defs = parseSnippetsFile({ S: { prefix: "s", body: "b", scope: "javascript, typescriptreact" } }, { language: "python" })
    expect(defs[0].scopes).toEqual(["javascript", "typescriptreact"])
  })
  test("no scope + no language → null (applies everywhere)", () => {
    expect(parseSnippetsFile({ S: { prefix: "s", body: "b" } })[0].scopes).toBeNull()
  })
  test("JSONC comments tolerated", () => {
    const json = `{
      // user snippets
      "Hi": { "prefix": "hi", "body": "hello" } /* greet */
    }`
    expect(parseSnippetsFile(json).map((d) => d.name)).toEqual(["Hi"])
  })
  test("drops entries with no prefix or empty body; junk → []", () => {
    const defs = parseSnippetsFile({
      Good: { prefix: "g", body: "x" },
      NoPrefix: { body: "x" },
      EmptyBody: { prefix: "e", body: "" },
      NotObj: 42,
    })
    expect(defs.map((d) => d.name)).toEqual(["Good"])
    expect(parseSnippetsFile(null)).toEqual([])
    expect(parseSnippetsFile("not json")).toEqual([])
    expect(parseSnippetsFile([1, 2])).toEqual([])
  })
  test("source tag is carried", () => {
    expect(parseSnippetsFile({ X: { prefix: "x", body: "b" } }, { source: "extension" })[0].source).toBe("extension")
  })
})

const def = (over: Partial<SnippetDefinition>): SnippetDefinition => ({
  name: "n", prefixes: ["p"], body: "b", description: "", scopes: null, source: "user", ...over,
})

describe("mergeSnippets + precedence", () => {
  test("orders user > project > extension > builtin, stable within source", () => {
    const merged = mergeSnippets(
      [def({ name: "ext1", source: "extension" })],
      [def({ name: "user1", source: "user" }), def({ name: "user2", source: "user" })],
      [def({ name: "builtin1", source: "builtin" })],
      [def({ name: "proj1", source: "project" })],
    )
    expect(merged.map((d) => d.name)).toEqual(["user1", "user2", "proj1", "ext1", "builtin1"])
  })
})

describe("snippetsForLanguage", () => {
  const defs = [
    def({ name: "all", scopes: null }),
    def({ name: "js", scopes: ["javascript"] }),
    def({ name: "py", scopes: ["python"] }),
    def({ name: "jsts", scopes: ["javascript", "typescript"] }),
  ]
  test("null scope applies to all; scoped only to matching", () => {
    expect(snippetsForLanguage(defs, "javascript").map((d) => d.name)).toEqual(["all", "js", "jsts"])
    expect(snippetsForLanguage(defs, "python").map((d) => d.name)).toEqual(["all", "py"])
    expect(snippetsForLanguage(defs, "rust").map((d) => d.name)).toEqual(["all"])
  })
})

describe("matchSnippets", () => {
  const defs = [
    def({ name: "for", prefixes: ["for"], scopes: ["javascript"] }),
    def({ name: "forEach", prefixes: ["forEach"], scopes: ["javascript"] }),
    def({ name: "log", prefixes: ["log", "clg"], scopes: ["javascript"] }),
    def({ name: "pyonly", prefixes: ["for"], scopes: ["python"] }),
  ]
  test("prefix startsWith, case-insensitive, language-filtered", () => {
    expect(matchSnippets(defs, "fo", "javascript").map((d) => d.name)).toEqual(["for", "forEach"])
    expect(matchSnippets(defs, "FO", "javascript").map((d) => d.name)).toEqual(["for", "forEach"])
  })
  test("exact prefix ranks first", () => {
    expect(matchSnippets(defs, "for", "javascript")[0].name).toBe("for")
  })
  test("matches against any of multiple prefixes", () => {
    expect(matchSnippets(defs, "clg", "javascript").map((d) => d.name)).toEqual(["log"])
  })
  test("empty word returns all in-language", () => {
    expect(matchSnippets(defs, "", "javascript").length).toBe(3)
  })
  test("language scoping excludes other-language same-prefix", () => {
    expect(matchSnippets(defs, "for", "python").map((d) => d.name)).toEqual(["pyonly"])
  })
})

describe("parseSnippetBody tokeniser", () => {
  test("plain text", () => {
    expect(parseSnippetBody("hello world")).toEqual([{ type: "text", value: "hello world" }])
  })
  test("tabstops $1 and ${2}", () => {
    expect(parseSnippetBody("a$1b${2}c")).toEqual([
      { type: "text", value: "a" }, { type: "tabstop", index: 1 },
      { type: "text", value: "b" }, { type: "tabstop", index: 2 },
      { type: "text", value: "c" },
    ])
  })
  test("placeholder ${1:default}", () => {
    expect(parseSnippetBody("x${1:foo}y")).toEqual([
      { type: "text", value: "x" }, { type: "placeholder", index: 1, value: "foo" }, { type: "text", value: "y" },
    ])
  })
  test("nested placeholder keeps inner text", () => {
    const toks = parseSnippetBody("${1:${2:inner}}")
    expect(toks).toEqual([{ type: "placeholder", index: 1, value: "${2:inner}" }])
  })
  test("choice ${1|a,b,c|}", () => {
    expect(parseSnippetBody("${1|a,b,c|}")).toEqual([{ type: "choice", index: 1, choices: ["a", "b", "c"] }])
  })
  test("variables $VAR and ${VAR:default}", () => {
    expect(parseSnippetBody("$TM_FILENAME")).toEqual([{ type: "variable", name: "TM_FILENAME" }])
    expect(parseSnippetBody("${FOO:bar}")).toEqual([{ type: "variable", name: "FOO", default: "bar" }])
  })
  test("transform detected (kept raw, not executed)", () => {
    expect(parseSnippetBody("${1/(.*)/\\U$1/}")).toEqual([{ type: "transform", index: 1, raw: "1/(.*)/\\U$1/" }])
  })
  test("escapes: \\$ \\} \\\\", () => {
    expect(parseSnippetBody("cost: \\$5")).toEqual([{ type: "text", value: "cost: $5" }])
    expect(parseSnippetBody("a\\}b")).toEqual([{ type: "text", value: "a}b" }])
  })
  test("unterminated ${ is literal text", () => {
    expect(parseSnippetBody("${1:oops")).toEqual([{ type: "text", value: "${1:oops" }])
  })
})

describe("snippetTabstops", () => {
  test("collects distinct indices + detects final $0", () => {
    expect(snippetTabstops("${1:a} $2 then $0")).toEqual({ indices: [0, 1, 2], hasFinal: true })
    expect(snippetTabstops("$1 $1 $2")).toEqual({ indices: [1, 2], hasFinal: false })
  })
})

describe("resolveSnippetVariable / resolveSnippetVariables", () => {
  const ctx = {
    fileName: "App.tsx",
    filePath: "/home/u/proj/src/App.tsx",
    selectedText: "SELECTED",
    lineIndex: 9,
    clipboard: "CLIP",
    workspaceName: "proj",
    now: new Date("2026-06-02T13:05:09"),
    pathSeparator: "/",
  }
  test("file + selection + line vars", () => {
    expect(resolveSnippetVariable("TM_FILENAME", ctx)).toBe("App.tsx")
    expect(resolveSnippetVariable("TM_FILENAME_BASE", ctx)).toBe("App")
    expect(resolveSnippetVariable("TM_DIRECTORY", ctx)).toBe("/home/u/proj/src")
    expect(resolveSnippetVariable("TM_SELECTED_TEXT", ctx)).toBe("SELECTED")
    expect(resolveSnippetVariable("TM_LINE_INDEX", ctx)).toBe("9")
    expect(resolveSnippetVariable("TM_LINE_NUMBER", ctx)).toBe("10")
    expect(resolveSnippetVariable("CLIPBOARD", ctx)).toBe("CLIP")
    expect(resolveSnippetVariable("WORKSPACE_NAME", ctx)).toBe("proj")
  })
  test("date vars zero-padded", () => {
    expect(resolveSnippetVariable("CURRENT_YEAR", ctx)).toBe("2026")
    expect(resolveSnippetVariable("CURRENT_MONTH", ctx)).toBe("06")
    expect(resolveSnippetVariable("CURRENT_SECOND", ctx)).toBe("09")
  })
  test("unknown variable → null", () => {
    expect(resolveSnippetVariable("NOPE", ctx)).toBeNull()
  })
  test("resolves vars but leaves tabstops/placeholders/choices intact", () => {
    const body = "// ${TM_FILENAME}\nconst $1 = ${2:value} // ${CURRENT_YEAR}\n${3|a,b|}"
    expect(resolveSnippetVariables(body, ctx)).toBe("// App.tsx\nconst $1 = ${2:value} // 2026\n${3|a,b|}")
  })
  test("unknown var with default uses default; bare unknown → empty", () => {
    expect(resolveSnippetVariables("${FOO:fallback}", ctx)).toBe("fallback")
    expect(resolveSnippetVariables("$FOO", ctx)).toBe("")
  })
  test("escaped dollar preserved through resolution", () => {
    expect(resolveSnippetVariables("price \\$5", ctx)).toBe("price $5")
  })
})

describe("validateSnippet", () => {
  test("clean snippet → no problems", () => {
    expect(validateSnippet(def({ prefixes: ["x"], body: "console.log($1)" }))).toEqual([])
  })
  test("flags empty prefix + empty body", () => {
    const problems = validateSnippet(def({ prefixes: [], body: "   " }))
    expect(problems).toContain("Snippet has no prefix.")
    expect(problems).toContain("Snippet has an empty body.")
  })
  test("flags unbalanced ${", () => {
    expect(validateSnippet(def({ prefixes: ["x"], body: "const ${1 = 2" }))).toContain("Unbalanced '${' in body.")
  })
  test("flags empty scope array", () => {
    expect(validateSnippet(def({ prefixes: ["x"], body: "ok", scopes: [] }))).toContain("Empty scope.")
  })
})
