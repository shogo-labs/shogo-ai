// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { jumboEmojiCodes } from "../useCustomEmoji"
import type { CustomEmoji } from "../../lib/team-chat-api"

const party = new Map<string, CustomEmoji>([
  ["party", { id: "e1", name: "party", url: "https://cdn.example.com/party.png" } as CustomEmoji],
])

describe("jumboEmojiCodes", () => {
  test("a unicode emoji message renders large", () => {
    expect(jumboEmojiCodes("🤗", new Map())).toEqual(["🤗"])
  })

  test("a workspace custom emoji message renders large", () => {
    expect(jumboEmojiCodes(":party:", party)).toEqual([":party:"])
  })

  test("text keeps the message at body size", () => {
    expect(jumboEmojiCodes("🤗 hello", new Map())).toBeNull()
  })
})
