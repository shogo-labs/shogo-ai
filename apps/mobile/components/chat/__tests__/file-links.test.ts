// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import {
  fileHref,
  linkifyFilePaths,
  pathFromFileHref,
  resolveChatFilePath,
} from "../file-links"

const PROJECT = "6c2a5faf-9683-4cf1-b3d1-bfdab2e912a9"

describe("linkifyFilePaths", () => {
  test("links a bare workspace path and leaves the trailing note alone", () => {
    const input = `Done — report written to the project folder:\n\n${PROJECT}/BILLING-AUDIT-2026-09-25.md (515 lines)`
    const linked = linkifyFilePaths(input)
    expect(linked).toContain(
      `[${PROJECT}/BILLING-AUDIT-2026-09-25.md](${fileHref(`${PROJECT}/BILLING-AUDIT-2026-09-25.md`)})`,
    )
    expect(linked).toContain("(515 lines)")
    expect(pathFromFileHref(fileHref(`${PROJECT}/BILLING-AUDIT-2026-09-25.md`))).toBe(
      `${PROJECT}/BILLING-AUDIT-2026-09-25.md`,
    )
  })

  test("links a backticked path, including one without a directory", () => {
    const linked = linkifyFilePaths("Updated `src/app.tsx` and `README.md`.")
    expect(linked).toContain("[`src/app.tsx`](")
    expect(linked).toContain("[`README.md`](")
  })

  test("leaves fenced code, existing links, and urls alone", () => {
    const input = [
      "Use and/or here, see https://example.com/a.md, and [docs](https://example.com/b.md).",
      "",
      "```",
      "foo/bar.md",
      "```",
    ].join("\n")
    const linked = linkifyFilePaths(input)
    expect(linked).not.toContain("/shogo-file?path=")
    expect(linked).toContain("https://example.com/a.md")
    expect(linked).toContain("[docs](https://example.com/b.md)")
    expect(linked).toContain("foo/bar.md")
  })

  test("does not link a bare filename with no directory", () => {
    expect(linkifyFilePaths("See README.md for details.")).toBe(
      "See README.md for details.",
    )
  })
})

describe("resolveChatFilePath", () => {
  test("treats a leading uuid as the project id", () => {
    expect(resolveChatFilePath(`${PROJECT}/notes/BILLING.md`, "other")).toEqual({
      projectId: PROJECT,
      relPath: "notes/BILLING.md",
    })
  })

  test("finds the uuid inside an absolute path", () => {
    expect(
      resolveChatFilePath(
        `/Users/me/.workspace-roots/ws/${PROJECT}/src/app.tsx`,
        null,
      ),
    ).toEqual({ projectId: PROJECT, relPath: "src/app.tsx" })
  })

  test("falls back to the current project when there is no uuid", () => {
    expect(resolveChatFilePath("src/app.tsx", "proj-1")).toEqual({
      projectId: "proj-1",
      relPath: "src/app.tsx",
    })
    expect(resolveChatFilePath("src/app.tsx", null)).toBeNull()
  })
})
