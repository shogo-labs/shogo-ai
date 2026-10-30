// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A turn that wrote a file in another project quotes that project's own
 * relative path. The map puts the path back in the project it was written in,
 * so the reply's path can be looked up and opened (SHO-247).
 */
import { describe, expect, test } from "bun:test"
import type { MessagePart } from "../turns/types"
import { filePaneTarget, remoteProjectPathMap, resolveTurnFilePath } from "../remote-project-paths"

const PLANNER = "d80288dd-aac3-41ed-bc9d-6ee251c44374"
const OTHER = "0b1c2d3e-4f50-4617-8899-aabbccddeeff"

function toolPart(
  toolName: string,
  args: Record<string, unknown> | undefined,
  result?: unknown,
  state: "streaming" | "success" | "error" = "success",
): MessagePart {
  return {
    type: "tool",
    id: `${toolName}-1`,
    tool: {
      id: `${toolName}-1`,
      toolName,
      category: "file",
      state,
      args,
      result,
      timestamp: 0,
    },
  }
}

function textPart(text: string): MessagePart {
  return { type: "text", id: "text-1", text }
}

describe("remoteProjectPathMap", () => {
  test("places a remote write in the project its result names", () => {
    const parts = [
      toolPart(
        "write_file",
        { path: "plans/sealed.md", project: "Shogo Planner" },
        { path: "plans/sealed.md", project: { id: PLANNER, name: "Shogo Planner" }, chatPath: `${PLANNER}/plans/sealed.md` },
      ),
    ]
    const map = remoteProjectPathMap(parts)
    expect(map.get("plans/sealed.md")).toBe(PLANNER)
  })

  test("resolves the project name for a message recorded before results named it", () => {
    const parts = [toolPart("write_file", { path: "plans/sealed.md", project: "Shogo Planner" }, { path: "plans/sealed.md" })]
    const seen: string[] = []
    const map = remoteProjectPathMap(parts, (ref) => {
      seen.push(ref)
      return ref === "Shogo Planner" ? PLANNER : null
    })
    expect(seen).toEqual(["Shogo Planner"])
    expect(map.get("plans/sealed.md")).toBe(PLANNER)
  })

  test("an unresolvable name maps nothing rather than guessing", () => {
    const parts = [toolPart("write_file", { path: "plans/sealed.md", project: "Nope" }, undefined)]
    expect(remoteProjectPathMap(parts, () => null).size).toBe(0)
  })

  test("a local write (no project) is not in the map", () => {
    const parts = [toolPart("write_file", { path: "plans/local.md" }, { path: "plans/local.md" })]
    expect(remoteProjectPathMap(parts).size).toBe(0)
  })

  test("a failed call is not in the map", () => {
    const parts = [
      toolPart("write_file", { path: "plans/sealed.md", project: "Shogo Planner" }, { error: "nope" }, "error"),
    ]
    expect(remoteProjectPathMap(parts).size).toBe(0)
  })

  test("takes the path from the result's chatPath when the call has none", () => {
    const parts = [
      toolPart("read_file", { project: "Shogo Planner" }, { project: { id: PLANNER, name: "Shogo Planner" }, chatPath: `${PLANNER}/plans/sealed.md` }),
    ]
    expect(remoteProjectPathMap(parts).get("plans/sealed.md")).toBe(PLANNER)
  })

  test("non-file tools are ignored", () => {
    const parts = [toolPart("exec", { command: "ls", project: "Shogo Planner" }, { stdout: "" })]
    expect(remoteProjectPathMap(parts).size).toBe(0)
  })
})

describe("resolveTurnFilePath", () => {
  const map = new Map([["plans/sealed.md", PLANNER]])

  test("rewrites a bare path the turn wrote in another project", () => {
    expect(resolveTurnFilePath("plans/sealed.md", map)).toBe(`${PLANNER}/plans/sealed.md`)
  })

  test("normalizes the spelling before matching", () => {
    expect(resolveTurnFilePath("./plans/sealed.md", map)).toBe(`${PLANNER}/plans/sealed.md`)
  })

  test("leaves a path that already names its project alone", () => {
    expect(resolveTurnFilePath(`${OTHER}/plans/sealed.md`, map)).toBe(`${OTHER}/plans/sealed.md`)
    expect(resolveTurnFilePath(`${PLANNER}/plans/sealed.md`, map)).toBe(`${PLANNER}/plans/sealed.md`)
  })

  test("leaves a path the turn did not write alone", () => {
    expect(resolveTurnFilePath("plans/other.md", map)).toBe("plans/other.md")
    expect(resolveTurnFilePath("plans/other.md", new Map())).toBe("plans/other.md")
  })
})

describe("turn text and tools", () => {
  test("a bare path in the reply resolves through the turn's own tool calls", () => {
    const parts = [
      toolPart(
        "write_file",
        { path: "plans/sealed.md", project: "Shogo Planner" },
        { project: { id: PLANNER, name: "Shogo Planner" }, chatPath: `${PLANNER}/plans/sealed.md` },
      ),
      textPart("Written to `plans/sealed.md`."),
    ]
    const map = remoteProjectPathMap(parts)
    expect(resolveTurnFilePath("plans/sealed.md", map)).toBe(`${PLANNER}/plans/sealed.md`)
  })
})

describe("filePaneTarget", () => {
  test("opens a project-prefixed path from that project's own runtime", () => {
    expect(filePaneTarget(`${PLANNER}/plans/sealed.md`)).toEqual({
      path: "plans/sealed.md",
      projectId: PLANNER,
    })
  })

  test("opens a bare path from the workspace root", () => {
    expect(filePaneTarget("plans/sealed.md")).toEqual({
      path: "plans/sealed.md",
      projectId: null,
    })
  })
})
