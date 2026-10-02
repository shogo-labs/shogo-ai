// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Queued messages are sent by the server, not the client: when a turn ends the
 * server takes the next queue row, saves it as a user message (using the row's
 * id), and runs the turn. The window then attaches to that turn's stream, which
 * carries the assistant's reply only. So the user message never reaches the
 * window's message list, and consecutive assistant messages with no user
 * message between them collapse into one turn, leaving only the last reply on
 * screen until a reload. These helpers add the missing user message.
 */
import type { UIMessage } from "ai"

type QueueRowLike = { id: string; content: string; parts?: string | null }

/** The user message the server saved for a queue row, built from the row itself. */
export function queuedRowToUserMessage(row: QueueRowLike): UIMessage {
  let parts: UIMessage["parts"] | undefined
  if (row.parts) {
    try {
      const parsed = JSON.parse(row.parts)
      if (Array.isArray(parsed) && parsed.length > 0) parts = parsed as UIMessage["parts"]
    } catch {
      /* fall back to the plain text below */
    }
  }
  return {
    id: row.id,
    role: "user",
    parts: parts ?? [{ type: "text", text: row.content }],
  } as UIMessage
}

/** Appends `userMessage` unless a message with that id is already there (e.g. after a reload). */
export function appendQueuedUserMessage<T extends UIMessage>(messages: T[], userMessage: UIMessage): T[] {
  if (messages.some((m) => m.id === userMessage.id)) return messages
  return [...messages, userMessage as T]
}
