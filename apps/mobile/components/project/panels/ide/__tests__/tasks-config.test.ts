// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FEAT-TASKS — unit tests for the pure tasks.json / launch.json model.
 *
 * Pure module, no fs / process / DOM — runs under `bun test`.
 * Pins: JSONC parsing + normalisation + defaults; group/presentation/
 * problemMatcher coercion; launch.json parsing; the full variable-
 * substitution matrix; shell quoting + command resolution (shell vs
 * process); lookups; and dependsOn ordering with cycle + missing handling.
 */
import { describe, expect, test } from "bun:test"
import {
  DEFAULT_PRESENTATION,
  defaultTaskForGroup,
  findLaunchConfiguration,
  findTask,
  parseLaunchConfig,
  parseTasksConfig,
  resolveDependsOrder,
  resolveTaskCommand,
  resolveVariables,
  shellQuote,
  tasksInGroup,
} from "../tasks-config"

describe("parseTasksConfig", () => {
  test("empty / junk → empty config with default version", () => {
    expect(parseTasksConfig(null)).toEqual({ version: "2.0.0", tasks: [] })
    expect(parseTasksConfig("not json")).toEqual({ version: "2.0.0", tasks: [] })
    expect(parseTasksConfig(42)).toEqual({ version: "2.0.0", tasks: [] })
  })

  test("parses a JSONC string with comments", () => {
    const json = `{
      // build config
      "version": "2.0.0",
      "tasks": [
        { "label": "build", "type": "shell", "command": "tsc", "args": ["-p", "."] } /* the build */
      ]
    }`
    const cfg = parseTasksConfig(json)
    expect(cfg.tasks).toHaveLength(1)
    expect(cfg.tasks[0]).toMatchObject({ label: "build", type: "shell", command: "tsc", args: ["-p", "."] })
  })

  test("fills defaults: type=shell, empty args, none group, default presentation, parallel order", () => {
    const cfg = parseTasksConfig({ tasks: [{ label: "x", command: "echo hi" }] })
    const t = cfg.tasks[0]
    expect(t.type).toBe("shell")
    expect(t.args).toEqual([])
    expect(t.group).toEqual({ kind: "none", isDefault: false })
    expect(t.presentation).toEqual(DEFAULT_PRESENTATION)
    expect(t.dependsOrder).toBe("parallel")
    expect(t.isBackground).toBe(false)
  })

  test("label defaults to command when omitted; entry with neither is dropped", () => {
    const cfg = parseTasksConfig({ tasks: [
      { command: "npm test" },
      { type: "shell" }, // no label, no command → dropped
      "garbage",
    ] })
    expect(cfg.tasks).toHaveLength(1)
    expect(cfg.tasks[0].label).toBe("npm test")
  })

  test("group: string and object forms", () => {
    const cfg = parseTasksConfig({ tasks: [
      { label: "b", command: "x", group: "build" },
      { label: "t", command: "y", group: { kind: "test", isDefault: true } },
      { label: "n", command: "z", group: "bogus" },
    ] })
    expect(findTask(cfg, "b")!.group).toEqual({ kind: "build", isDefault: false })
    expect(findTask(cfg, "t")!.group).toEqual({ kind: "test", isDefault: true })
    expect(findTask(cfg, "n")!.group).toEqual({ kind: "none", isDefault: false })
  })

  test("presentation overrides merge with defaults", () => {
    const cfg = parseTasksConfig({ tasks: [{ label: "x", command: "c", presentation: { reveal: "silent", panel: "dedicated", clear: true } }] })
    expect(cfg.tasks[0].presentation).toEqual({ ...DEFAULT_PRESENTATION, reveal: "silent", panel: "dedicated", clear: true })
  })

  test("problemMatcher: string, array, and object forms normalise to refs", () => {
    const cfg = parseTasksConfig({ tasks: [
      { label: "a", command: "c", problemMatcher: "$tsc" },
      { label: "b", command: "c", problemMatcher: ["$eslint-stylish", "$tsc"] },
      { label: "c", command: "c", problemMatcher: { base: "$tsc", owner: "ts" } },
      { label: "d", command: "c", problemMatcher: { owner: "custom" } },
      { label: "e", command: "c", problemMatcher: { pattern: {} } },
    ] })
    expect(findTask(cfg, "a")!.problemMatchers).toEqual(["$tsc"])
    expect(findTask(cfg, "b")!.problemMatchers).toEqual(["$eslint-stylish", "$tsc"])
    expect(findTask(cfg, "c")!.problemMatchers).toEqual(["$tsc"])
    expect(findTask(cfg, "d")!.problemMatchers).toEqual(["custom"])
    expect(findTask(cfg, "e")!.problemMatchers).toEqual(["$inline"])
  })

  test("options.cwd + env coerced; env numbers/bools stringified", () => {
    const cfg = parseTasksConfig({ tasks: [{ label: "x", command: "c", options: { cwd: "/w", env: { A: "1", B: 2, C: true, D: null } } }] })
    expect(cfg.tasks[0].options).toEqual({ cwd: "/w", env: { A: "1", B: "2", C: "true" } })
  })
})

describe("parseLaunchConfig", () => {
  test("parses configurations, drops entries missing name/type", () => {
    const cfg = parseLaunchConfig({ version: "0.2.0", configurations: [
      { name: "Launch", type: "node", request: "launch", program: "${workspaceFolder}/app.js", args: ["--watch"] },
      { type: "node" }, // no name → dropped
      { name: "x" }, // no type → dropped
    ] })
    expect(cfg.configurations).toHaveLength(1)
    expect(cfg.configurations[0]).toMatchObject({ name: "Launch", type: "node", request: "launch", program: "${workspaceFolder}/app.js", args: ["--watch"], env: {} })
  })
  test("request defaults to launch; attach honoured", () => {
    expect(parseLaunchConfig({ configurations: [{ name: "a", type: "node" }] }).configurations[0].request).toBe("launch")
    expect(parseLaunchConfig({ configurations: [{ name: "a", type: "node", request: "attach" }] }).configurations[0].request).toBe("attach")
  })
  test("findLaunchConfiguration", () => {
    const cfg = parseLaunchConfig({ configurations: [{ name: "Run", type: "node" }] })
    expect(findLaunchConfiguration(cfg, "Run")?.type).toBe("node")
    expect(findLaunchConfiguration(cfg, "Nope")).toBeUndefined()
  })
})

describe("resolveVariables", () => {
  const ctx = {
    workspaceFolder: "/home/u/proj",
    file: "/home/u/proj/src/app.ts",
    env: { API_KEY: "secret", EMPTY: "" },
    lineNumber: 42,
    selectedText: "foo",
  }
  test("no placeholder → returned as-is (same ref)", () => {
    const s = "plain string"
    expect(resolveVariables(s, ctx)).toBe(s)
  })
  test("workspaceFolder + basename", () => {
    expect(resolveVariables("${workspaceFolder}/x", ctx)).toBe("/home/u/proj/x")
    expect(resolveVariables("${workspaceFolderBasename}", ctx)).toBe("proj")
  })
  test("file family", () => {
    expect(resolveVariables("${file}", ctx)).toBe("/home/u/proj/src/app.ts")
    expect(resolveVariables("${fileBasename}", ctx)).toBe("app.ts")
    expect(resolveVariables("${fileBasenameNoExtension}", ctx)).toBe("app")
    expect(resolveVariables("${fileDirname}", ctx)).toBe("/home/u/proj/src")
    expect(resolveVariables("${fileExtname}", ctx)).toBe(".ts")
    expect(resolveVariables("${relativeFile}", ctx)).toBe("src/app.ts")
    expect(resolveVariables("${relativeFileDirname}", ctx)).toBe("src")
  })
  test("env:NAME (present, empty, missing)", () => {
    expect(resolveVariables("${env:API_KEY}", ctx)).toBe("secret")
    expect(resolveVariables("${env:EMPTY}", ctx)).toBe("")
    expect(resolveVariables("${env:NOPE}", ctx)).toBe("")
  })
  test("cwd falls back to workspaceFolder; pathSeparator", () => {
    expect(resolveVariables("${cwd}", ctx)).toBe("/home/u/proj")
    expect(resolveVariables("a${pathSeparator}b", ctx)).toBe("a/b")
    expect(resolveVariables("a${/}b", { pathSeparator: "\\" })).toBe("a\\b")
  })
  test("lineNumber + selectedText", () => {
    expect(resolveVariables("line ${lineNumber}", ctx)).toBe("line 42")
    expect(resolveVariables("${selectedText}", ctx)).toBe("foo")
  })
  test("unknown variable is left untouched", () => {
    expect(resolveVariables("${command:foo.bar} ${unknownThing}", ctx)).toBe("${command:foo.bar} ${unknownThing}")
  })
  test("multiple substitutions in one string", () => {
    expect(resolveVariables("${workspaceFolder}/${fileBasename}", ctx)).toBe("/home/u/proj/app.ts")
  })
  test("missing lineNumber leaves the token", () => {
    expect(resolveVariables("${lineNumber}", {})).toBe("${lineNumber}")
  })
})

describe("shellQuote", () => {
  test("safe tokens pass through", () => {
    expect(shellQuote("tsc")).toBe("tsc")
    expect(shellQuote("./node_modules/.bin/eslint")).toBe("./node_modules/.bin/eslint")
    expect(shellQuote("--max-warnings=0")).toBe("--max-warnings=0")
  })
  test("whitespace / metachars get single-quoted", () => {
    expect(shellQuote("hello world")).toBe("'hello world'")
    expect(shellQuote("a&&b")).toBe("'a&&b'")
    expect(shellQuote("$HOME")).toBe("'$HOME'")
  })
  test("embedded single quote is escaped", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })
  test("empty string", () => {
    expect(shellQuote("")).toBe("''")
  })
})

describe("resolveTaskCommand", () => {
  const ctx = { workspaceFolder: "/w", file: "/w/src/a.ts" }
  test("shell task → quoted single command line", () => {
    const cfg = parseTasksConfig({ tasks: [{ label: "b", type: "shell", command: "eslint", args: ["${relativeFile}", "--max-warnings", "0"] }] })
    const r = resolveTaskCommand(cfg.tasks[0], ctx)
    expect(r.shell).toBe(true)
    expect(r.args).toEqual(["src/a.ts", "--max-warnings", "0"])
    expect(r.commandLine).toBe("eslint src/a.ts --max-warnings 0")
  })
  test("shell task quotes args with spaces", () => {
    const cfg = parseTasksConfig({ tasks: [{ label: "b", type: "shell", command: "echo", args: ["hello world"] }] })
    expect(resolveTaskCommand(cfg.tasks[0]).commandLine).toBe("echo 'hello world'")
  })
  test("process task → program + raw args (no quoting)", () => {
    const cfg = parseTasksConfig({ tasks: [{ label: "b", type: "process", command: "node", args: ["script with space.js"] }] })
    const r = resolveTaskCommand(cfg.tasks[0])
    expect(r.shell).toBe(false)
    expect(r.commandLine).toBe("node script with space.js")
    expect(r.args).toEqual(["script with space.js"])
  })
  test("resolves cwd + env variables", () => {
    const cfg = parseTasksConfig({ tasks: [{ label: "b", command: "c", options: { cwd: "${workspaceFolder}/sub", env: { OUT: "${workspaceFolder}/dist" } } }] })
    const r = resolveTaskCommand(cfg.tasks[0], ctx)
    expect(r.cwd).toBe("/w/sub")
    expect(r.env).toEqual({ OUT: "/w/dist" })
  })
})

describe("lookups", () => {
  const cfg = parseTasksConfig({ tasks: [
    { label: "build", command: "c", group: { kind: "build", isDefault: true } },
    { label: "build:fast", command: "c", group: "build" },
    { label: "test", command: "c", group: { kind: "test", isDefault: false } },
  ] })
  test("findTask + tasksInGroup + defaultTaskForGroup", () => {
    expect(findTask(cfg, "test")?.label).toBe("test")
    expect(tasksInGroup(cfg, "build").map((t) => t.label)).toEqual(["build", "build:fast"])
    expect(defaultTaskForGroup(cfg, "build")?.label).toBe("build")
    expect(defaultTaskForGroup(cfg, "test")).toBeUndefined()
  })
})

describe("resolveDependsOrder", () => {
  const cfg = parseTasksConfig({ tasks: [
    { label: "a", command: "c", dependsOn: ["b", "c"] },
    { label: "b", command: "c", dependsOn: ["c"] },
    { label: "c", command: "c" },
    { label: "loopX", command: "c", dependsOn: ["loopY"] },
    { label: "loopY", command: "c", dependsOn: ["loopX"] },
    { label: "withMissing", command: "c", dependsOn: ["ghost"] },
  ] })
  test("dependencies come before dependents, requested task last", () => {
    const r = resolveDependsOrder(cfg, "a")
    expect(r.order).toEqual(["c", "b", "a"])
    expect(r.hasCycle).toBe(false)
    expect(r.missing).toEqual([])
  })
  test("leaf task → just itself", () => {
    expect(resolveDependsOrder(cfg, "c").order).toEqual(["c"])
  })
  test("cycle is detected, does not infinite-loop", () => {
    const r = resolveDependsOrder(cfg, "loopX")
    expect(r.hasCycle).toBe(true)
  })
  test("missing dependsOn ref is collected", () => {
    const r = resolveDependsOrder(cfg, "withMissing")
    expect(r.missing).toEqual(["ghost"])
    expect(r.order).toEqual(["withMissing"])
  })
  test("unknown task → empty order", () => {
    expect(resolveDependsOrder(cfg, "nope")).toEqual({ order: [], hasCycle: false, missing: [] })
  })
})
