// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import type { UIMessage } from "@ai-sdk/react"
import { extractOrderedParts } from "../messageParts"
import { credentialLabel } from "../CredentialChip"

const message = (parts: unknown[]) => ({ id: "m1", role: "assistant", parts }) as unknown as UIMessage
const toolOf = (parts: unknown[]) => (extractOrderedParts(message(parts))[0] as any).tool

describe("which account a tool call used", () => {
  test("comes from the live tool output", () => {
    const tool = toolOf([
      {
        type: "dynamic-tool",
        toolCallId: "c1",
        toolName: "exec",
        state: "output-available",
        input: { command: "gh issue create" },
        output: { stdout: "ok", credential: { source: "personal", actingAs: "@bob-gh" } },
      },
    ])
    expect(tool.credential).toEqual({ source: "personal", actingAs: "@bob-gh" })
  })

  test("comes from the part itself in a channel's trimmed work log, where output is a string", () => {
    const tool = toolOf([
      {
        type: "dynamic-tool",
        toolCallId: "c1",
        toolName: "github_create_pr",
        state: "output-available",
        input: {},
        output: '{"ok":true,"author":"acme-shared"…',
        credential: { source: "shared", actingAs: "project account (@acme-shared)", onBehalfOf: "Gina" },
      },
    ])
    expect(tool.credential).toEqual({ source: "shared", actingAs: "project account (@acme-shared)", onBehalfOf: "Gina" })
  })

  test("is absent for tools that touched no integration, and for malformed values", () => {
    const parts = [
      { type: "dynamic-tool", toolCallId: "c1", toolName: "read_file", state: "output-available", input: {}, output: { content: "x" } },
      { type: "dynamic-tool", toolCallId: "c2", toolName: "exec", state: "output-available", input: {}, output: { credential: { source: "root", actingAs: "x" } } },
    ]
    const [plain, forged] = extractOrderedParts(message(parts)) as any[]
    expect("credential" in plain.tool).toBe(false)
    expect("credential" in forged.tool).toBe(false)
  })

  test("reads as a short label", () => {
    expect(credentialLabel({ source: "personal", actingAs: "@bob-gh" })).toBe("as @bob-gh")
    expect(credentialLabel({ source: "approved", actingAs: "@frank-gh" })).toBe("as @frank-gh · approved")
    expect(credentialLabel({ source: "delegate", actingAs: "@frank-gh" })).toBe("as @frank-gh · delegate")
    expect(credentialLabel({ source: "shared", actingAs: "project account" })).toBe("project account")
    expect(credentialLabel({ source: "shared", actingAs: "project account", onBehalfOf: "Gina" })).toBe("project account · for Gina")
  })
})
