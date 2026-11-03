// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What a panel does when another window (or the server) starts or ends a turn
 * in the chat it is showing (SHO-299).
 *
 * A chat open in two windows used to be two islands: the panel only looked for
 * a turn on focus and after its own turn ended, so a window that stayed visible
 * never learned that tab 2 was running one. The API now publishes
 * `chat-session.turn` at the turn-state insert point, and this is the decision
 * that turns that event into an action.
 */

import { persistedTailAwaitsReply, type PersistedTail } from './late-turn-attach'

export type TurnSyncEvent = {
  type?: string
  chatSessionId?: string
  turnId?: string
  state?: string
}

export type TurnSyncAction = 'ignore' | 'attach' | 'repaint'

export interface TurnSyncContext {
  /** The chat this panel is showing. */
  currentSessionId: string | null | undefined
  /** This window is streaming a reply of its own. */
  isStreaming: boolean
  /** This window is sending a message of its own. */
  isSending: boolean
  /**
   * A person can see this window right now (`document.visibilityState`, or
   * `AppState` on native).
   *
   * A window nobody is looking at must not act on the push (SHO-53): attaching
   * to the turn from here arms the task watch and the late-turn poll, so a
   * backgrounded window would poll the task list for as long as the turn runs.
   * It is behind on nothing it cannot fix when it comes back — the refocus
   * catch-up probes `/turn` once and paints saved history.
   */
  isVisible: boolean
}

/**
 * `attach` when a turn started elsewhere, `repaint` when one ended elsewhere,
 * `ignore` for anything that is not this panel's business.
 *
 * A window that is streaming or sending is already attached to its own turn:
 * attaching again would rebuild the reply it is watching, and repainting would
 * drop the bubble it just echoed.
 */
export function turnSyncAction(
  event: TurnSyncEvent | null | undefined,
  context: TurnSyncContext,
): TurnSyncAction {
  if (!event || event.type !== 'chat-session.turn') return 'ignore'
  if (!context.currentSessionId || event.chatSessionId !== context.currentSessionId) return 'ignore'
  if (context.isStreaming || context.isSending) return 'ignore'
  // Nothing on screen can show the turn, and acting would arm watches this
  // window has no reason to run (SHO-53). Refocus catches it up.
  if (!context.isVisible) return 'ignore'
  if (event.state === 'started') return 'attach'
  if (event.state === 'ended') return 'repaint'
  return 'ignore'
}

/**
 * How long to keep looking for the reply row after a turn ended elsewhere.
 * `ended` is published when the turn is cleared, which is normally after the
 * assistant row is written — but a row that lands a moment later must not leave
 * the window showing a prompt with no answer.
 */
export const TURN_END_REPAINT_RETRY_MS = [1_000, 3_000] as const

export interface TurnEndRepaintOptions {
  /** The newest saved row of the chat, one row wide. */
  probe: () => Promise<PersistedTail | null>
  /** Reload and paint the transcript from saved history. */
  reload: () => Promise<void>
  isCancelled?: () => boolean
  delaysMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
}

/**
 * Wait for the reply row of a turn that ended elsewhere, then paint it.
 *
 * The prompt is already on screen (the caller painted it), so this only has to
 * notice the reply landing. Bounded: two probes, then the panel is left to the
 * next event rather than polling forever.
 */
export async function repaintWhenReplyLands(options: TurnEndRepaintOptions): Promise<void> {
  const delays = options.delaysMs ?? TURN_END_REPAINT_RETRY_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (const delay of delays) {
    await sleep(delay)
    if (options.isCancelled?.()) return
    let tail: PersistedTail | null = null
    try {
      tail = await options.probe()
    } catch {
      // A failed read is not evidence of a missed reply: try again next tick.
      continue
    }
    if (options.isCancelled?.()) return
    if (persistedTailAwaitsReply(tail)) continue
    await options.reload()
    return
  }
}
