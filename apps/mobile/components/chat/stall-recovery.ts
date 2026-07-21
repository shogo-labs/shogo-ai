// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure decision logic for AUTOMATIC stream-stall recovery.
 *
 * The reported bug: for some users the chat stream ends mid-turn (the
 * `auto-resuming-fetch` budget is exhausted, the app was backgrounded, or a
 * transport blip closed the body) so `useChat().status` falls back to
 * `ready`/`error` and the UI shows the static "Connection interrupted. Please
 * tap Retry to continue." banner — WHILE the agent is still running and
 * buffering frames server-side. The user is stranded on a dead-end banner even
 * though a single `resumeStream()` would silently reattach.
 *
 * The manual Retry button already triages this correctly (see retry-triage.ts:
 * `active` -> reconnect). This module lets the panel run that same recovery
 * AUTOMATICALLY, with a bounded poll, the instant a turn ends without ever
 * emitting `data-turn-complete` — so the common case (server still streaming)
 * heals itself and only genuinely-dead turns fall through to the manual banner.
 *
 * Extracted as a pure function (mirroring retry-triage.ts / chat-stall-watchdog.ts)
 * so the recovery state machine is unit-testable without React or the runtime.
 */

import type { ChatTurnStatus } from "./probe-turn-status"

export type StallRecoveryAction = "reconnect" | "retry-later" | "give-up"
export type StallGiveUpAction = "fail-closed" | "ignore"

export interface StallRecoveryInput {
  /** Status from the runtime's read-only `/turn` probe. */
  turnStatus: ChatTurnStatus
  /** 1-based index of the probe attempt that produced `turnStatus`. */
  attempt: number
  /** Total probe attempts allowed before giving up. */
  maxAttempts: number
}

/**
 * Decide what auto-recovery should do after one `/turn` probe. Pure + total.
 *
 *  - `active`                          -> reconnect (agent still running; reattach
 *                                         to the live buffer via `resumeStream()`).
 *  - `unknown` and attempts remain     -> retry-later (the buffer may not be
 *                                         published yet, or the probe raced a
 *                                         warm-pool/pod transition — back off and
 *                                         probe again).
 *  - terminal (`completed`/`failed`/`aborted`) -> give-up (the turn really ended;
 *                                         loaded history already reflects it).
 *  - `unknown` with no attempts left   -> give-up (fall through to the manual
 *                                         Retry banner).
 *
 * Critically this NEVER returns an action that re-sends or truncates — the only
 * "active" branch reattaches to existing work, exactly like manual Retry.
 */
export function decideStallRecovery({
  turnStatus,
  attempt,
  maxAttempts,
}: StallRecoveryInput): StallRecoveryAction {
  if (turnStatus === "active") return "reconnect"
  if (turnStatus === "unknown" && attempt < maxAttempts) return "retry-later"
  return "give-up"
}

export interface StallGiveUpInput {
  /** The latest status from the final `/turn` probe before giving up. */
  turnStatus: ChatTurnStatus
  /** Whether the user explicitly pressed Stop for this turn. */
  userInitiatedStop: boolean
}

/**
 * Decide the local UI terminal action when automatic recovery gives up.
 *
 * A stream EOF without `data-turn-complete` is not a normal completed turn. If
 * the user did not press Stop and the runtime is not actively streamable, close
 * the UI as a failed/partial turn: clear stale active task state and show a
 * concrete retry banner. That prevents desktop runtime crashes (for example a
 * local preview/generate crash) from leaving the turn visually active forever.
 */
export function decideStallGiveUpAction({
  turnStatus,
  userInitiatedStop,
}: StallGiveUpInput): StallGiveUpAction {
  if (userInitiatedStop) return "ignore"
  if (turnStatus === "active") return "ignore"
  return "fail-closed"
}

export interface RecoveryBackoffOptions {
  /** Initial delay in ms. Default 600. */
  initialMs?: number
  /** Max delay in ms. Default 5000. */
  maxMs?: number
}

/**
 * Exponential backoff (capped) for the bounded recovery poll. Matches the
 * shape used by `auto-resuming-fetch` so the two recovery layers feel
 * consistent. `attempt` is 1-based; attempt 1 returns `initialMs`.
 */
export function computeRecoveryBackoff(
  attempt: number,
  opts: RecoveryBackoffOptions = {},
): number {
  const initialMs = opts.initialMs ?? 600
  const maxMs = opts.maxMs ?? 5_000
  const n = Math.max(1, attempt)
  return Math.min(initialMs * Math.pow(2, n - 1), maxMs)
}
