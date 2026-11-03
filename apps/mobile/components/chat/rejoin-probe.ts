// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What a chat does with a `/turn` answer once its history has loaded
 * (SHO-297).
 *
 * Two probes exist. One runs with the paint and only answers "is a turn live?"
 * so Stop and the rejoin row can appear without waiting for history. The other
 * runs after the history load — and it may simply reuse the paint-time answer
 * rather than spend another round-trip.
 *
 * That reuse is why this decision is its own function with its own tests: the
 * reused answer never passes through `probeLiveTurn`, so any "leave the rejoin
 * row" condition that lives only inside `probeLiveTurn` is skipped. Missing it
 * hid a saved reply behind "Rejoining live reply…" for the full 8 s timeout on
 * a chat whose turn was over or never buffered — the SHO-274 behaviour the AC
 * says must not change.
 */

export type RejoinProbeVerdict =
  /** A turn is running and this window may attach to it. */
  | "attach"
  /** Nothing to join yet, but a turn was expected: reload and look again. */
  | "reload"
  /** Nothing to join, and nothing expected: stop rejoining, show the reply. */
  | "give-up"

export interface RejoinProbeOutcomeInput {
  /** The answer names a turn this window has not stopped. */
  live: boolean
  /** The answer names a turn this window itself stopped. */
  stopped: boolean
  /** The window believes a turn should be running (it just sent a prompt). */
  expectedLive: boolean
}

export function rejoinProbeVerdict(input: RejoinProbeOutcomeInput): RejoinProbeVerdict {
  if (input.live) return "attach"
  // A stop this window sent may reach the runtime a beat after the answer, so
  // "the turn I expected is gone" is worth one reload rather than a give-up.
  if (input.expectedLive && !input.stopped) return "reload"
  return "give-up"
}
