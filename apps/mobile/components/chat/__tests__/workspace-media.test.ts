// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import {
  imageSrcHref,
  isVideoSrc,
  normalizeWorkspaceMediaPath,
  pathFromImageSrc,
  rewriteWorkspaceMedia,
} from "../file-links"

describe("rewriteWorkspaceMedia", () => {
  test("points bare, ./ and file:// image paths at the workspace", () => {
    expect(rewriteWorkspaceMedia("![](brand/buddy.png)")).toBe(`![](${imageSrcHref("brand/buddy.png")})`)
    expect(rewriteWorkspaceMedia("![Logo](./logo.png)")).toBe(`![Logo](${imageSrcHref("./logo.png")})`)
    expect(rewriteWorkspaceMedia("![x](file:///app/workspace/a%20b.png)")).toBe(
      `![x](${imageSrcHref("/app/workspace/a b.png")})`,
    )
  })

  test("keeps the title and handles angle-bracket targets", () => {
    expect(rewriteWorkspaceMedia('![A](<my renders/a.png> "Hero")')).toBe(
      `![A](${imageSrcHref("my renders/a.png")} "Hero")`,
    )
  })

  test("leaves URLs, data, blob and stored attachments alone", () => {
    const inputs = [
      "![a](https://example.com/a.png)",
      "![a](data:image/png;base64,AAAA)",
      "![a](blob:https://studio/123)",
      "![a](/api/chat-attachments/artifacts/chat-attachments/s/x.png?t=abc)",
      "![a](/api/conversation-files/abc?t=def)",
    ]
    for (const input of inputs) expect(rewriteWorkspaceMedia(input)).toBe(input)
  })

  test("does not touch images inside code", () => {
    const input = "```md\n![](brand/a.png)\n```\nand `![](b.png)`"
    expect(rewriteWorkspaceMedia(input)).toBe(input)
  })

  test("is idempotent", () => {
    const once = rewriteWorkspaceMedia("![](a/b.mp4)")
    expect(rewriteWorkspaceMedia(once)).toBe(once)
  })
})

describe("workspace media paths", () => {
  test("round-trips through the image src", () => {
    expect(pathFromImageSrc(imageSrcHref("brand/a b.png"))).toBe("brand/a b.png")
    expect(pathFromImageSrc("https://example.com/a.png")).toBeNull()
  })

  test("normalizes ./ and absolute sandbox paths", () => {
    expect(normalizeWorkspaceMediaPath("./brand/a.png")).toBe("brand/a.png")
    expect(normalizeWorkspaceMediaPath("/app/workspace/brand/a.png")).toBe("brand/a.png")
    expect(normalizeWorkspaceMediaPath("6c2a5faf-9683-4cf1-b3d1-bfdab2e912a9/a.png")).toBe(
      "6c2a5faf-9683-4cf1-b3d1-bfdab2e912a9/a.png",
    )
  })

  test("detects video by extension", () => {
    expect(isVideoSrc("clips/demo.mp4")).toBe(true)
    expect(isVideoSrc("/api/conversation-files/abc?t=1#demo.webm")).toBe(true)
    expect(isVideoSrc("/api/chat-attachments/artifacts/chat-attachments/s/ff.mp4?t=1")).toBe(true)
    expect(isVideoSrc("brand/a.png")).toBe(false)
  })
})
