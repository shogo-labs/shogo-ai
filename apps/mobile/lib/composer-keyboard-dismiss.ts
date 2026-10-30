// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Platform } from "react-native"

/**
 * `keyboardDismissMode` for a transcript that scrolls itself while a turn
 * streams (SHO-255).
 *
 * Native wants `on-drag`: a finger dragging the transcript closes the keyboard.
 * Web must not opt in — react-native-web's `ScrollView` calls `dismissKeyboard()`
 * on EVERY scroll event when this is `"on-drag"`, with no way to tell a finger
 * drag from the app's own auto-follow scroll. A transcript following a streaming
 * turn scrolls every few milliseconds, so it blurred the composer immediately
 * after the user focused it; the Enter that followed landed on `<body>`, so the
 * message never left the composer and the text just stayed on screen.
 *
 * There is no keyboard to dismiss on web anyway.
 */
export function transcriptKeyboardDismissMode(
  platform: string = Platform.OS
): "on-drag" | undefined {
  return platform === "web" ? undefined : "on-drag"
}
