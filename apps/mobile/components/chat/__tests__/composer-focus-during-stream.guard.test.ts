// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Source guard for SHO-255: a scrolling transcript must not dismiss the
 * keyboard on web.
 *
 * react-native-web's ScrollView calls `dismissKeyboard()` on EVERY scroll event
 * when `keyboardDismissMode` is "on-drag", with no way to tell a finger drag
 * from the app's own auto-follow scroll. The project transcript and the
 * team-chat message list both scroll themselves while a turn streams, so a
 * literal `keyboardDismissMode="on-drag"` blurred their composer milliseconds
 * after it was focused — the typed text stayed on screen and the Enter that
 * followed went to `<body>`, so nothing was ever sent.
 *
 * Both surfaces must go through `transcriptKeyboardDismissMode()`, which opts
 * web out and keeps drag-to-dismiss natively.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "../../..")

const SCROLLING_TRANSCRIPTS = [
  "components/chat/ChatPanel.tsx",
  "components/team-chat/MessageList.tsx",
]

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

describe("composer focus during a streaming turn", () => {
  for (const file of SCROLLING_TRANSCRIPTS) {
    test(`${file} does not dismiss the keyboard on web scroll`, () => {
      const source = stripComments(readFileSync(resolve(root, file), "utf8"))
      if (/keyboardDismissMode\s*=\s*["']on-drag["']/.test(source)) {
        throw new Error(
          `${file} passes keyboardDismissMode="on-drag" to a transcript that scrolls ` +
            `itself while a turn streams. On web that blurs the composer on every ` +
            `scroll event, so Enter never reaches it (SHO-255). Use ` +
            `transcriptKeyboardDismissMode() from lib/composer-keyboard-dismiss.ts.`,
        )
      }
      expect(source).toContain("transcriptKeyboardDismissMode(")
    })
  }
})
