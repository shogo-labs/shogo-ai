// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-483: Settings → Chat preferences crashed with
 * "Cannot read property 'join' of undefined" (Sentry SHOGO-ANDROID-13/20)
 * when the published settings had no `keywords` array.
 *
 * Run: cd apps/mobile && bun test hooks/__tests__/useChatPrefs.normalize.test.ts
 */
import { describe, expect, test } from "bun:test"
import type { ChatSettings } from "../../lib/team-chat-api"
import { normalizeChatSettings } from "../useChatPrefs"

describe("normalizeChatSettings", () => {
  test("an optimistic save made before the first load still has a keywords array", () => {
    // `update({ statusText })` before `chatSettings()` resolved merges onto `{}`.
    const optimistic = { statusText: "In a meeting" } as unknown as ChatSettings
    const settings = normalizeChatSettings(optimistic)
    expect(settings.keywords).toEqual([])
    expect(settings.keywords.join(", ")).toBe("")
    expect((settings as any).statusText).toBe("In a meeting")
  })

  test("a null keywords field from the server becomes an empty list", () => {
    const fromServer = { keywords: null } as unknown as ChatSettings
    expect(normalizeChatSettings(fromServer).keywords).toEqual([])
  })

  test("settings that already have keywords pass through unchanged", () => {
    const settings = { keywords: ["deploy", "outage"] } as unknown as ChatSettings
    expect(normalizeChatSettings(settings)).toBe(settings)
  })
})
