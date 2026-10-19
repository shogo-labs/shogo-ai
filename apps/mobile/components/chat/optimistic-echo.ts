// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The user's own bubble, painted before the message is sent. The composer
 * clears synchronously on send, so anything awaited first (the live-turn
 * probe) leaves the transcript frozen for that whole round trip.
 *
 * Two rules live here, away from React so they can be tested directly:
 *  - the echo goes at the END of the list, so it renders as the newest turn
 *    rather than the first one;
 *  - it is dropped only once a user message NEWER than the one on screen at
 *    send time has arrived, so re-sending the same text ("continue", "yes")
 *    still paints a new bubble instead of matching the earlier one.
 */
import type { UIMessage } from "ai"
import { extractTextContent } from "@shogo/shared-app/chat"

export type OptimisticEchoFile = {
  dataUrl: string
  name?: string
  type?: string
}

export type OptimisticEchoInput = {
  sessionId: string
  content: string
  files?: OptimisticEchoFile[]
  /**
   * Id of the newest user message already on screen when the echo was painted.
   * While that message is still the newest, nothing new has landed yet.
   */
  baselineUserId?: string | null
}

export const OPTIMISTIC_ECHO_ID = "optimistic-user-pending"

export function buildOptimisticUserMessage(
  input: OptimisticEchoInput,
  id = OPTIMISTIC_ECHO_ID,
): UIMessage {
  const parts: any[] = []
  const text = input.content.trim()

  if (text) {
    parts.push({ type: "text", text })
  }

  for (const file of input.files ?? []) {
    parts.push({
      type: "file",
      mediaType: file.type || "application/octet-stream",
      url: file.dataUrl,
      ...(file.name ? { name: file.name } : {}),
    })
  }

  return {
    id,
    role: "user",
    parts,
    // The send time, so time-windowed reads anchored on this bubble have
    // something to anchor to before the server's row arrives — the chat tag's
    // delivery state (`since`) is the one that goes blank without it.
    createdAt: Date.now(),
  } as unknown as UIMessage
}

function newestUserMessage(messages: UIMessage[]): UIMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i]
  }
  return null
}

/** Id of the last user message in the list — the baseline a new echo is keyed to. */
export function newestUserId(messages: UIMessage[]): string | null {
  return newestUserMessage(messages)?.id ?? null
}

/**
 * True once this echo's real message is on screen: only the newest user
 * message can satisfy it, and only if it is not the one that was already
 * there when the echo was painted.
 */
export function hasMatchingUserMessage(
  messages: UIMessage[],
  input: OptimisticEchoInput,
): boolean {
  const newest = newestUserMessage(messages)
  if (!newest) return false
  if (input.baselineUserId && newest.id === input.baselineUserId) return false

  const text = input.content.trim()
  if (text) return extractTextContent(newest).trim() === text
  return (input.files?.length ?? 0) > 0
}

/** `messages` with the echo appended as the newest turn, until its real message lands. */
export function appendOptimisticEcho<T extends UIMessage>(
  messages: T[],
  input: OptimisticEchoInput | null | undefined,
): T[] {
  if (!input) return messages
  if (!input.content.trim() && (input.files?.length ?? 0) === 0) return messages
  if (hasMatchingUserMessage(messages, input)) return messages
  return [...messages, buildOptimisticUserMessage(input) as T]
}
