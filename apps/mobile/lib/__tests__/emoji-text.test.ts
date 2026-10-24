// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { emojiOnlyCodes, isEmoji, splitGraphemes } from "../emoji-text"

const noCustom = () => false
const customParty = (code: string) => code === ":party:"

describe("splitGraphemes", () => {
  test("keeps a zero-width-joiner family together as one character", () => {
    expect(splitGraphemes("👨‍👩‍👧‍👦")).toEqual(["👨‍👩‍👧‍👦"])
  })

  test("keeps a flag together rather than two regional indicators", () => {
    expect(splitGraphemes("🇮🇳")).toEqual(["🇮🇳"])
  })

  test("keeps a keycap digit and its modifiers together", () => {
    expect(splitGraphemes("1️⃣")).toEqual(["1️⃣"])
  })

  test("keeps a skin-tone modifier with its base", () => {
    expect(splitGraphemes("👍🏽")).toEqual(["👍🏽"])
  })

  test("splits adjacent emoji that have no space between them", () => {
    expect(splitGraphemes("😂😂😂")).toEqual(["😂", "😂", "😂"])
  })

  test("leaves ordinary text alone", () => {
    expect(splitGraphemes("hi")).toEqual(["h", "i"])
  })
})

describe("isEmoji", () => {
  test("recognises pictographs, symbols and dingbats", () => {
    for (const emoji of ["🤗", "😊", "✅", "⚡", "❤️", "⭐", "🎉"]) {
      expect(isEmoji(emoji)).toBe(true)
    }
  })

  test("recognises the sequences that are one emoji, not several", () => {
    for (const emoji of ["👨‍👩‍👧‍👦", "🇮🇳", "1️⃣", "👍🏽"]) {
      expect(isEmoji(emoji)).toBe(true)
    }
  })

  test("rejects letters, digits and punctuation", () => {
    for (const text of ["a", "7", "!", ".", ""]) {
      expect(isEmoji(text)).toBe(false)
    }
  })

  test("rejects a lone regional indicator, which is not a flag", () => {
    expect(isEmoji("🇮")).toBe(false)
  })

  test("rejects typography that merely lives in an emoji block", () => {
    // Arrows are typed as punctuation; blowing one up to 30px looks like a bug.
    expect(isEmoji("→")).toBe(false)
  })

  test("honours the text-presentation selector", () => {
    expect(isEmoji("❤︎")).toBe(false)
    expect(isEmoji("❤️")).toBe(true)
  })
})

describe("emojiOnlyCodes", () => {
  test("a message of one unicode emoji is jumbo", () => {
    // The regression this file exists for: only custom `:name:` codes used to
    // qualify, so every unicode emoji message rendered at body size.
    expect(emojiOnlyCodes("🤗", noCustom)).toEqual(["🤗"])
  })

  test("counts each emoji in a run with no spaces", () => {
    expect(emojiOnlyCodes("😂😂😂", noCustom)).toEqual(["😂", "😂", "😂"])
  })

  test("counts a family, a flag and a keycap as one emoji each", () => {
    expect(emojiOnlyCodes("👨‍👩‍👧‍👦 🇮🇳 1️⃣", noCustom)).toEqual(["👨‍👩‍👧‍👦", "🇮🇳", "1️⃣"])
  })

  test("ignores surrounding whitespace", () => {
    expect(emojiOnlyCodes("  🤗\n", noCustom)).toEqual(["🤗"])
  })

  test("is not jumbo once there is any text", () => {
    expect(emojiOnlyCodes("🤗 hello", noCustom)).toBeNull()
    expect(emojiOnlyCodes("hello 🤗", noCustom)).toBeNull()
  })

  test("is not jumbo for a message that only looks like symbols", () => {
    expect(emojiOnlyCodes("123", noCustom)).toBeNull()
    expect(emojiOnlyCodes("→", noCustom)).toBeNull()
    expect(emojiOnlyCodes("--", noCustom)).toBeNull()
  })

  test("is not jumbo for an empty message", () => {
    expect(emojiOnlyCodes("", noCustom)).toBeNull()
    expect(emojiOnlyCodes("   \n ", noCustom)).toBeNull()
  })

  test("treats a workspace custom emoji as one emoji", () => {
    expect(emojiOnlyCodes(":party:", customParty)).toEqual([":party:"])
  })

  test("mixes custom and unicode emoji", () => {
    expect(emojiOnlyCodes(":party: 🤗", customParty)).toEqual([":party:", "🤗"])
  })

  test("does not treat an unknown :name: as an emoji", () => {
    expect(emojiOnlyCodes(":not-a-real-emoji:", customParty)).toBeNull()
  })

  test("stops being jumbo past the cap", () => {
    expect(emojiOnlyCodes("🤗🤗🤗🤗🤗🤗", noCustom)).toHaveLength(6)
    expect(emojiOnlyCodes("🤗🤗🤗🤗🤗🤗🤗", noCustom)).toBeNull()
  })
})
