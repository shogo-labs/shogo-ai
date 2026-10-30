// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import {
  CHAT_REFS_MIME,
  decodeChatDragPayload,
  encodeChatDragPayload,
  hasChatDragPayload,
  skippedReferencesMessage,
  toAgentReferences,
  type ChatDragItem,
} from "../chat-drag"

const dt = (data: Record<string, string>) => ({ getData: (type: string) => data[type] ?? "" })

const items: ChatDragItem[] = [
  { kind: "file", path: "src/a.ts", name: "a.ts", rootId: "agent", dirty: true },
  { kind: "folder", path: "src", name: "src", rootId: "agent" },
]

describe("chat drag payload", () => {
  test("round-trips", () => {
    expect(decodeChatDragPayload(dt({ [CHAT_REFS_MIME]: encodeChatDragPayload(items) }))).toEqual(items)
  })

  test("missing or malformed JSON -> null", () => {
    expect(decodeChatDragPayload(dt({}))).toBeNull()
    expect(decodeChatDragPayload(dt({ [CHAT_REFS_MIME]: "{nope" }))).toBeNull()
    expect(decodeChatDragPayload(dt({ [CHAT_REFS_MIME]: '{"items":5}' }))).toBeNull()
    expect(decodeChatDragPayload(null)).toBeNull()
  })

  test("drops malformed entries and duplicates (same root + path)", () => {
    const raw = JSON.stringify({
      items: [
        items[0],
        { kind: "file", path: "", name: "x", rootId: "agent" },
        { kind: "symlink", path: "a", name: "a", rootId: "agent" },
        { kind: "file", path: "src/a.ts", name: "a.ts", rootId: "agent" },
        { kind: "file", path: "src/a.ts", name: "a.ts", rootId: "local:x" },
        "junk",
      ],
    })
    expect(decodeChatDragPayload(dt({ [CHAT_REFS_MIME]: raw }))).toEqual([
      items[0],
      { kind: "file", path: "src/a.ts", name: "a.ts", rootId: "local:x" },
    ])
  })

  test("hasChatDragPayload", () => {
    expect(hasChatDragPayload(["text/plain", CHAT_REFS_MIME])).toBe(true)
    expect(hasChatDragPayload(["Files"])).toBe(false)
    expect(hasChatDragPayload(undefined)).toBe(false)
  })
})

describe("toAgentReferences", () => {
  test("only agent-root items become references; the rest are reported", () => {
    const r = toAgentReferences([...items, { kind: "file", path: "x.ts", name: "x.ts", rootId: "local:repo:1" }])
    expect(r.references).toEqual([
      { type: "file", path: "src/a.ts", name: "a.ts" },
      { type: "folder", path: "src", name: "src" },
    ])
    expect(r.skipped).toEqual(["x.ts"])
    expect(skippedReferencesMessage(r.skipped)).toBe(
      "Only files in the project workspace can be added as references — skipped: x.ts. Select code inside the file to add it as a snippet instead.",
    )
  })
})
