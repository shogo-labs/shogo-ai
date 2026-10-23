// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Following the turn that runs after the one a window was attached to.
 *
 * A chat can queue a second message behind a live turn (the user sends into a
 * turn that started elsewhere, and the API queues it). The queue dispatcher
 * starts that message only once it has seen the previous turn end, so the next
 * turn begins *after* this window's stream has already closed — and a short
 * queued turn can start and finish between two probes. Probing at two fixed
 * offsets therefore misses it: the window shows the earlier reply, never
 * attaches, and, because a probe that finds no live turn used to do nothing,
 * never repaints the reply that did run (SHO-29).
 *
 * So: keep probing for as long as the dispatcher could take, and refresh the
 * saved history when nothing was live. Same shape as `pollForLateTurn` in
 * `late-turn-attach.ts`, which solves this for delegated tasks.
 */

/**
 * Gaps between `/turn` probes, cumulative on purpose: 1.5s, 4s, 8s and 10.5s
 * after the turn this window followed ended. The old pair of probes (1.5s, 4s)
 * is kept as the first two, and the tail covers the queue dispatcher, which
 * starts the next message from its turn-end hook (measured ~1.5s) and from a
 * 15s tick when that hook is missed. The history is refreshed after the last
 * gap, so the wait has to leave room inside the ~15s a caller waits for a reply
 * to show up.
 */
export const NEXT_TURN_PROBE_GAPS_MS = [1500, 2500, 4000, 2500] as const

export type FollowNextTurnResult = 'attached' | 'refreshed' | 'cancelled'

export interface FollowNextTurnOptions {
  /** Probe `/turn` and attach to its stream when a turn is live. */
  attachIfLive: () => Promise<boolean>
  /** Nothing was live after the last probe: repaint from saved history. */
  refreshHistory: () => void
  /** Stop following (panel unmounted, another chat opened, a stream is open). */
  isCancelled?: () => boolean
  gapsMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
  onError?: (error: unknown) => void
}

/**
 * Resolves `attached` when a live turn was picked up, `refreshed` when the
 * follow ran out and the history was reloaded instead, `cancelled` when the
 * caller stopped it.
 */
export async function followNextTurn(
  opts: FollowNextTurnOptions,
): Promise<FollowNextTurnResult> {
  const gaps = opts.gapsMs ?? NEXT_TURN_PROBE_GAPS_MS
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (const gap of gaps) {
    await sleep(gap)
    if (opts.isCancelled?.()) return 'cancelled'
    let attached = false
    try {
      attached = await opts.attachIfLive()
    } catch (error) {
      // A probe that fails is not an answer: keep following on the next gap.
      opts.onError?.(error)
    }
    if (opts.isCancelled?.()) return 'cancelled'
    if (attached) return 'attached'
  }
  opts.refreshHistory()
  return 'refreshed'
}
