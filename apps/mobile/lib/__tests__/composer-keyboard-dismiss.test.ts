// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-255: react-native-web's ScrollView calls `dismissKeyboard()` on every
 * scroll event when `keyboardDismissMode` is "on-drag" — it cannot tell a
 * finger drag from the app's own auto-follow scroll. A transcript that follows
 * a streaming turn therefore blurred the composer milliseconds after the user
 * focused it, and the Enter that followed landed on `<body>`: the message
 * never left the composer.
 */
import { describe, expect, test } from "bun:test"
import { transcriptKeyboardDismissMode } from "../composer-keyboard-dismiss"

describe("transcriptKeyboardDismissMode", () => {
  test("web does not dismiss the keyboard on scroll", () => {
    expect(transcriptKeyboardDismissMode("web")).toBeUndefined()
  })

  test("native keeps drag-to-dismiss", () => {
    expect(transcriptKeyboardDismissMode("ios")).toBe("on-drag")
    expect(transcriptKeyboardDismissMode("android")).toBe("on-drag")
  })
})
