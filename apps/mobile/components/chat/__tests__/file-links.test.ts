// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import {
  fileHref,
  fileIndexHas,
  isMentionHref,
  linkifyBareUrls,
  linkifyFilePaths,
  mentionHref,
  mentionTargetFromHref,
  pathFromFileHref,
  resolveChatFilePath,
} from "../file-links"

const PROJECT = "6c2a5faf-9683-4cf1-b3d1-bfdab2e912a9"
const OTHER = "0b1c2d3e-4f50-4617-8899-aabbccddeeff"

describe("fileIndexHas", () => {
  const projectFiles = new Set(["src/app.tsx", "README.md"])
  const workspaceFiles = new Set([`${PROJECT}/src/app.tsx`, `${OTHER}/notes.md`])

  test("matches project-relative spellings against a project runtime's list", () => {
    expect(fileIndexHas(projectFiles, "src/app.tsx", PROJECT)).toBe(true)
    expect(fileIndexHas(projectFiles, "./src/app.tsx", PROJECT)).toBe(true)
    expect(fileIndexHas(projectFiles, `${PROJECT}/src/app.tsx`, PROJECT)).toBe(true)
    expect(fileIndexHas(projectFiles, "/app/workspace/src/app.tsx", PROJECT)).toBe(true)
    expect(fileIndexHas(projectFiles, "src/missing.tsx", PROJECT)).toBe(false)
  })

  test("does not match another project's path against this project's files", () => {
    expect(fileIndexHas(projectFiles, `${OTHER}/src/app.tsx`, PROJECT)).toBe(false)
  })

  test("matches against a workspace runtime's project-prefixed list", () => {
    expect(fileIndexHas(workspaceFiles, "src/app.tsx", PROJECT)).toBe(true)
    expect(fileIndexHas(workspaceFiles, `${OTHER}/notes.md`, PROJECT)).toBe(true)
    expect(fileIndexHas(workspaceFiles, "notes.md", PROJECT)).toBe(false)
  })

  test("is false for an empty index", () => {
    expect(fileIndexHas(new Set(), "src/app.tsx", PROJECT)).toBe(false)
  })
})

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

describe("linkifyBareUrls", () => {
  test("links common bare domains and keeps punctuation outside the link", () => {
    expect(linkifyBareUrls("Read example.com, then open www.shogo.ai/docs.")).toBe(
      "Read [example.com](https://example.com), then open [www.shogo.ai/docs](https://www.shogo.ai/docs).",
    )
  })

  test("does not turn emails, code, or workspace paths into web links", () => {
    const input = [
      "Email support@example.com.",
      "Use `example.com` in the fixture.",
      "See src/app.tsx and https://example.com/already-linked.",
    ].join("\n")
    const linked = linkifyBareUrls(input)
    expect(linked).toContain("support@example.com")
    expect(linked).toContain("`example.com`")
    expect(linked).toContain("src/app.tsx")
    expect(linked).toContain("https://example.com/already-linked")
    expect(linked).not.toContain("[support@example.com]")
    expect(linked).not.toContain("[`example.com`]")
  })

  test("keeps markdown emphasis and quotes outside the generated link", () => {
    expect(linkifyBareUrls('**example.com/docs** and "example.com/docs"')).toBe(
      '**[example.com/docs](https://example.com/docs)** and "[example.com/docs](https://example.com/docs)"',
    )
  })

  test("preserves balanced path delimiters and strips surrounding punctuation", () => {
    expect(linkifyBareUrls("Read example.com/wiki/Foo_(bar). (see example.com)")).toBe(
      "Read [example.com/wiki/Foo_(bar)](https://example.com/wiki/Foo_(bar)). (see [example.com](https://example.com))",
    )
  })

  test("does not link app bundle names or angle-bracket autolinks", () => {
    expect(linkifyBareUrls("Open Shogo.app or <example.com>.")).toBe(
      "Open Shogo.app or <example.com>.",
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

describe("mention targets", () => {
  test("round-trips every mention kind, escaping keys that hold punctuation", () => {
    expect(mentionHref("u", "user-1")).toBe("/shogo-mention/u/user-1")
    // The workspace agent's key is `ws`; a project agent's is `p:<projectId>`.
    expect(mentionHref("a", "ws")).toBe("/shogo-mention/a/ws")
    expect(mentionHref("a", "p:proj-1")).toBe("/shogo-mention/a/p%3Aproj-1")
    expect(mentionTargetFromHref("/shogo-mention/a/p%3Aproj-1")).toEqual({ kind: "a", id: "p:proj-1" })
    expect(mentionTargetFromHref(mentionHref("g", "g1"))).toEqual({ kind: "g", id: "g1" })
  })

  test("a bare prefix has no target, so old and target-less mentions stay plain", () => {
    // `@here`, `@channel`, `#channel` and every message stored before mentions
    // carried an id render with the prefix alone.
    expect(mentionTargetFromHref("/shogo-mention")).toBeNull()
    expect(mentionTargetFromHref("/shogo-mention/")).toBeNull()
    expect(mentionTargetFromHref("/shogo-mention/u")).toBeNull()
    expect(mentionTargetFromHref("/shogo-mention/u/u1/extra")).toBeNull()
    expect(mentionTargetFromHref("/shogo-mention/x/u1")).toBeNull()
    expect(mentionTargetFromHref("/shogo-mention/u/u1?q=1")).toBeNull()
  })

  test("is not confused by other hrefs or bad encoding", () => {
    expect(mentionTargetFromHref(undefined)).toBeNull()
    expect(mentionTargetFromHref(null)).toBeNull()
    expect(mentionTargetFromHref("https://example.com/u/u1")).toBeNull()
    expect(mentionTargetFromHref("/shogo-file?path=src%2Fapp.tsx")).toBeNull()
    expect(mentionTargetFromHref("/shogo-mention/u/%")).toBeNull()
    // A bare prefix is still recognised as a mention, which is what the
    // renderer keys the highlight off.
    expect(isMentionHref("/shogo-mention")).toBe(true)
    expect(isMentionHref("/shogo-mention/u/u1")).toBe(true)
  })
})
