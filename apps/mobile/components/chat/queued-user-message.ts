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

/**
 * The bubbles for the messages the server has not saved yet, in send order —
 * still-queued rows and a dispatched head that has not been attached.
 *
 * They are derived from the queue, not copied into the transcript: the queue is
 * the only thing that knows whether a message is still going to be sent, so a
 * delete, an edit, a dispatch and a history reload all resolve themselves
 * instead of leaving a bubble behind (or dropping the ones still queued).
 */
export function appendQueuedUserMessages<T extends UIMessage>(
  messages: T[],
  pending: UIMessage[],
): T[] {
  if (pending.length === 0) return messages
  let next = messages
  for (const userMessage of pending) next = appendQueuedUserMessage(next, userMessage)
  return next
}

/**
 * Whether the reply to `queuedUserMessage` can be attached as-is: its message
 * is on screen *and* nothing landed after it, so the reply belongs at the end.
 * A message that is on screen but no longer last came from a reload of a
 * transcript that has moved on — attaching there would write the reply over a
 * later turn, so that path reloads history instead.
 */
export function canAttachQueuedTurn(messages: UIMessage[], queuedUserMessage: UIMessage): boolean {
  const index = messages.findIndex((m) => m.id === queuedUserMessage.id)
  return index !== -1 && index === messages.length - 1
}
