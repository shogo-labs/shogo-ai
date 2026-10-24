// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Paths a workspace-agent chat hands to `ChatPanel.openFile` must reduce to the
 * workspace-relative path the file viewer reads through the agent proxy.
 */
import { describe, expect, test } from "bun:test"
import { normalizeWorkspaceMediaPath } from "../file-links"

describe("normalizeWorkspaceMediaPath", () => {
  test("keeps a plain workspace-relative path", () => {
    expect(normalizeWorkspaceMediaPath("notes/plan.md")).toBe("notes/plan.md")
  })

  test("strips a leading ./", () => {
    expect(normalizeWorkspaceMediaPath("./src/app.ts")).toBe("src/app.ts")
  })

  test("reduces an absolute sandbox path to what follows the workspace root", () => {
    expect(normalizeWorkspaceMediaPath("/app/workspace/reports/q3.pdf")).toBe("reports/q3.pdf")
    expect(normalizeWorkspaceMediaPath("/workspace/reports/q3.pdf")).toBe("reports/q3.pdf")
  })

  test("keeps a project-prefixed path intact", () => {
    expect(normalizeWorkspaceMediaPath("8f1c2a7e-0000-4000-8000-000000000000/index.html")).toBe(
      "8f1c2a7e-0000-4000-8000-000000000000/index.html",
    )
  })

  test("normalizes Windows separators", () => {
    expect(normalizeWorkspaceMediaPath("docs\\readme.md")).toBe("docs/readme.md")
  })

  test("drops leading slashes on an unrooted absolute path", () => {
    expect(normalizeWorkspaceMediaPath("/data/users.json")).toBe("data/users.json")
  })
})
