// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Stop is terminal, not unfinished.
 *
 * `isUnfinishedAssistant` (resume-replay-transport.ts) calls an assistant
 * message unfinished unless the turn reported itself complete, and the next
 * attach/replay drops an unfinished tail. A turn the user stopped never
 * reports complete, so a stopped reply was deleted from the transcript on the
 * next replay. Stamp the turn Stop cancelled with a client-side
 * `data-turn-stopped` part: the replay paths then treat it as finished.
 *
 * The stopped turn's id travels with the part so a send straight after Stop
 * can tell "the turn I just cancelled" from "a turn someone else is running"
 * (see `isLiveTurnOtherThan` in probe-turn-status.ts).
 */
import type { UIMessage } from "ai"

export const TURN_STOPPED_PART_TYPE = "data-turn-stopped"

type StoppedPart = { type: typeof TURN_STOPPED_PART_TYPE; data: { turnId: string | null } }

function stoppedParts(message: UIMessage): StoppedPart[] {
  return ((message.parts ?? []) as Array<Record<string, any>>).filter(
    (part) => part?.type === TURN_STOPPED_PART_TYPE,
  ) as StoppedPart[]
}

/** True for a reply the user stopped mid-flight. */
export function hasStoppedMarker(message: UIMessage | undefined): boolean {
  return !!message && message.role === "assistant" && stoppedParts(message).length > 0
}

/** The turn id carried by a stopped reply, if any. */
export function stoppedTurnIdOf(message: UIMessage | undefined): string | null {
  const part = message ? stoppedParts(message)[0] : undefined
  return part?.data?.turnId ?? null
}

/** The same message, with the stop marker appended once. */
export function stampStopped<T extends UIMessage>(
  message: T,
  turnId: string | null,
): T {
  if (hasStoppedMarker(message)) return message
  return {
    ...message,
    parts: [
      ...(message.parts ?? []),
      { type: TURN_STOPPED_PART_TYPE, data: { turnId } },
    ],
  } as T
}

/**
 * Marks the trailing assistant message as the reply Stop cancelled. Only the
 * tail is touched: an earlier turn's reply is already finished history.
 */
export function markStoppedTail<T extends UIMessage>(
  messages: T[],
  turnId: string | null,
): T[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== "assistant" || hasStoppedMarker(last)) {
    return messages
  }
  return [...messages.slice(0, -1), stampStopped(last, turnId)]
}

/**
 * Puts a stopped snapshot back into the live transcript without discarding
 * what the window gained after the stop — the bubble of the next message and
 * its reply start there. Messages present in both keep the live copy (it may
 * hold the last tokens) with the stop marker re-applied, so the reply stays
 * classified as finished.
 */
export function mergeStoppedSnapshot<T extends UIMessage>(
  live: T[],
  snapshot: T[],
): T[] {
  if (snapshot.length === 0) return live
  if (live.length === 0) return snapshot
  const liveById = new Map(live.map((message) => [message.id, message]))
  const snapshotIds = new Set(snapshot.map((message) => message.id))
  const merged = snapshot.map((message) => {
    const current = liveById.get(message.id)
    if (!current) return message
    return hasStoppedMarker(message)
      ? stampStopped(current, stoppedTurnIdOf(message))
      : current
  })
  for (const message of live) {
    if (!snapshotIds.has(message.id)) merged.push(message)
  }
  return merged
}
