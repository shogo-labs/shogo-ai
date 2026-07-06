// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { extractLongPaste } from "./long-text-utils"

export type ChatInputTextChange =
  | { type: "paste-handled" }
  | { type: "unchanged" }
  | { type: "long-paste"; inserted: string; restored: string }
  | {
      type: "text"
      text: string
      resetHeight: boolean
      skillPicker: { open: boolean; filterText?: string }
      mentionCaret: number
    }

export function resolveChatInputTextChange(
  previousText: string,
  nextText: string,
  pasteAlreadyHandled: boolean,
): ChatInputTextChange {
  if (pasteAlreadyHandled) return { type: "paste-handled" }

  if (nextText === previousText) return { type: "unchanged" }

  const paste = extractLongPaste(previousText, nextText)
  if (paste) {
    return {
      type: "long-paste",
      inserted: paste.inserted,
      restored: paste.restored,
    }
  }

  if (nextText.startsWith("/") && !nextText.includes(" ")) {
    return {
      type: "text",
      text: nextText,
      resetHeight: nextText.length === 0,
      skillPicker: { open: true, filterText: nextText.slice(1).toLowerCase() },
      mentionCaret: nextText.length,
    }
  }

  return {
    type: "text",
    text: nextText,
    resetHeight: nextText.length === 0,
    skillPicker: { open: false },
    mentionCaret: nextText.length,
  }
}
