// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The in-memory per-session transcript cache behind `ChatPanel`.
 *
 * It lives in its own module so sign-out can drop it without importing the
 * 9k-line panel (and the whole chat UI tree) into the auth bootstrap. Its
 * lifetime is one JS session; the durable copy is `chat-history-store`.
 */

const sessionMessageCache = new Map<string, any[]>()

/**
 * The caller's own thumbs up/down per session, keyed by `messageId`. Same
 * lifetime as the transcript cache: switching back to a session paints the
 * thumbs immediately instead of waiting on a round-trip.
 */
const sessionFeedbackCache = new Map<string, Record<string, "up" | "down">>()

export function readSessionMessageCache(sessionId: string): any[] | undefined {
  return sessionMessageCache.get(sessionId)
}

export function writeSessionMessageCache(sessionId: string, messages: any[]): void {
  sessionMessageCache.set(sessionId, messages)
}

export function readSessionFeedbackCache(
  sessionId: string,
): Record<string, "up" | "down"> | undefined {
  return sessionFeedbackCache.get(sessionId)
}

export function writeSessionFeedbackCache(
  sessionId: string,
  feedback: Record<string, "up" | "down">,
): void {
  sessionFeedbackCache.set(sessionId, feedback)
}

/**
 * Mirror one optimistic thumbs change so the cache never contradicts what the
 * panel is showing when the session is re-entered.
 */
export function patchSessionFeedbackCache(
  sessionId: string,
  messageId: string,
  thumbs: "up" | "down" | null,
): void {
  const current = sessionFeedbackCache.get(sessionId)
  if (!current) return
  const next = { ...current }
  if (thumbs) next[messageId] = thumbs
  else delete next[messageId]
  sessionFeedbackCache.set(sessionId, next)
}

/** Clear the in-memory per-session caches (e.g. on logout). */
export function clearChatPanelMessageCache(): void {
  sessionMessageCache.clear()
  sessionFeedbackCache.clear()
}
