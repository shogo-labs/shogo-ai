// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { extractTextContent } from "@shogo/shared-app/chat"

/**
 * Convert persisted chat-message rows (whose `parts` is a JSON string) into
 * the message shape `useChat` renders.
 */
export function toAiMessages(loaded: readonly any[]): any[] {
  return loaded.map((msg) => {
    let parts: any[] | undefined
    if (msg.parts) {
      try {
        parts = JSON.parse(msg.parts)
      } catch (err) {
        // Keep the text content when a message has malformed parts.
        console.warn("[ChatPanel] Failed to parse message parts:", err)
      }
    }
    const next: any = {
      id: msg.id,
      role: msg.role as "user" | "assistant",
      content: msg.content ?? extractTextContent({ parts }),
      // `extractTurnTiming`'s createdAt fallback and the `TurnFooter`
      // relative-time label need it for messages without `data-turn-timing`.
      createdAt: msg.createdAt,
    }
    if (parts) next.parts = parts
    return next
  })
}
