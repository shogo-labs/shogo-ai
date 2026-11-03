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
 * While the window believes the turn is live but has not attached yet, the
 * unfinished tail is hidden and a "Rejoining live reply…" row stands where the
 * reply goes. The resume snapshot delivers the whole message so far in one
 * chunk the moment the window attaches, so nothing is lost by hiding it.
 *
 * This is display-only: it never mutates the transcript or the device cache, so
 * a reply the person has already read is still there if the attach never lands
 * (SHO-274).
 */
import type { UIMessage } from "ai"
import { isUnfinishedAssistant } from "./resume-replay-transport"

export interface RejoinViewInput<T extends UIMessage> {
  /** The transcript as it would be painted, oldest first. */
  messages: readonly T[]
  /** This window believes the turn is live but is not attached to it yet. */
  rejoining: boolean
}

export interface RejoinView<T extends UIMessage> {
  /** The transcript to paint. Identical to the input when not rejoining. */
  messages: readonly T[]
  /** Show the "Rejoining live reply…" row under the last turn. */
  showRejoinRow: boolean
}

/**
 * Hide the stale half-written reply while rejoining.
 *
 * Only an *unfinished* assistant tail is dropped. A finished turn, a prompt, a
 * reply the person stopped and a turn the server declared dead are all history
 * the person has read, and they stay on screen — the row simply appears under
 * them.
 */
export function resolveRejoinView<T extends UIMessage>(
  input: RejoinViewInput<T>,
): RejoinView<T> {
  const { messages, rejoining } = input
  if (!rejoining) return { messages, showRejoinRow: false }
  const tail = messages[messages.length - 1]
  if (!isUnfinishedAssistant(tail)) return { messages, showRejoinRow: true }
  return { messages: messages.slice(0, -1), showRejoinRow: true }
}
