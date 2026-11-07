// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What a chat shows while it is rejoining a turn that is still running
 * (SHO-297).
 *
 * A chat that is not already mounted as a tab paints the half-written reply
 * from when the person left, then waits a network round-trip for the delta and
 * another for the `/turn` probe before it attaches to the live stream. For
 * those seconds the stale reply sits there looking like the current state, so
 * the chat reads as frozen.
 *
 * While the window believes the turn is live but has not attached yet, a
 * "Rejoining live reply…" row is drawn under everything the chat has received —
 * the half-written reply included (SHO-366). Keeping the reply on screen means
 * nothing the person already read disappears while it waits. The resume
 * snapshot replaces that unfinished tail in place (`applyMessageSnapshot` in
 * resume-replay-transport.ts drops it before appending the rebuilt message), so
 * there is never a duplicate.
 *
 * This is display-only: it never mutates the transcript or the device cache, so
 * a reply the person has already read is still there if the attach never lands
 * (SHO-274).
 */
import type { UIMessage } from "ai"

export interface RejoinViewInput<T extends UIMessage> {
  /** The transcript as it would be painted, oldest first. */
  messages: readonly T[]
  /** This window believes the turn is live but is not attached to it yet. */
  rejoining: boolean
}

export interface RejoinView<T extends UIMessage> {
  /** The transcript to paint. Identical to the input. */
  messages: readonly T[]
  /** Show the "Rejoining live reply…" row under the last turn. */
  showRejoinRow: boolean
}

/**
 * Decide whether the rejoin row is drawn. The transcript always passes
 * through unchanged: the reply received so far stays on screen and the row
 * lands under it (SHO-366).
 */
export function resolveRejoinView<T extends UIMessage>(
  input: RejoinViewInput<T>,
): RejoinView<T> {
  const { messages, rejoining } = input
  return { messages, showRejoinRow: rejoining }
}
