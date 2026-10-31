// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reconcile a live session's message ids with the persisted rows (SHO-263).
 *
 * `useChat` stamps every message it creates with its own nanoid, but the row
 * that `/api/chat-messages` persisted for it has a cuid. Every server-side
 * action the transcript exposes — `truncate-from`, `preceding-checkpoint`,
 * feedback — addresses the ROW, so a message sent in the current page session
 * 404s until the transcript is reloaded. (That is how editing a just-sent
 * message silently rolled back: `POST /api/chat-messages/<nanoid>/truncate-from`
 * → "Message not found".)
 *
 * The fix is to adopt the row id as soon as `actions.addMessage` resolves, so
 * the UIMessage and the row agree for the rest of the session. The adoption
 * can complete before `sendMessage` has appended its bubble, so unmatched
 * entries wait for the next transcript change instead of being dropped.
 */
import type { UIMessage } from "ai"
import { extractTextContent } from "@shogo/shared-app/chat"
import { OPTIMISTIC_ECHO_ID } from "./optimistic-echo"

/** A persisted row whose UIMessage hasn't been found yet. */
export interface PendingIdAdoption {
  /** `ChatMessage.id` returned by the create call. */
  rowId: string
  /** Text the user sent; used to find the matching bubble. */
  text: string
}

export interface IdAdoptionPlan {
  /** `from` = the id the transcript still shows, `to` = the persisted row id. */
  swaps: Array<{ from: string; to: string }>
  /** Entries that found no bubble yet — retried on the next change. */
  remaining: PendingIdAdoption[]
}

/**
 * Find, for each pending adoption, the newest user bubble that still carries a
 * client-generated id and holds the same text.
 *
 * Only the newest match is taken per entry, and a bubble is claimed once, so a
 * repeat send of the same text ("continue", "yes") maps to its own row rather
 * than rewriting an older bubble.
 */
export function planIdAdoptions(
  messages: UIMessage[],
  pending: PendingIdAdoption[],
  adoptedIds: ReadonlySet<string>,
): IdAdoptionPlan {
  if (pending.length === 0) return { swaps: [], remaining: [] }

  const claimed = new Set<string>()
  const swaps: Array<{ from: string; to: string }> = []
  const remaining: PendingIdAdoption[] = []

  for (const entry of pending) {
    const wanted = entry.text.trim()
    let match: string | null = null

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role !== "user") continue
      // The painted echo is a stand-in for a bubble that isn't there yet.
      if (message.id === OPTIMISTIC_ECHO_ID) continue
      if (message.id === entry.rowId) continue
      if (claimed.has(message.id)) continue
      if (adoptedIds.has(message.id)) continue
      if (extractTextContent(message).trim() !== wanted) continue
      match = message.id
      break
    }

    if (!match) {
      remaining.push(entry)
      continue
    }
    claimed.add(match)
    swaps.push({ from: match, to: entry.rowId })
  }

  return { swaps, remaining }
}
