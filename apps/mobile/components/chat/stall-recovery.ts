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

export type StallRecoveryAction = "reconnect" | "retry-later" | "reload-history"

export interface StallRecoveryEffects {
  action: StallRecoveryAction
  interruptStuckTools: boolean
  /** Replace the rendered turn with the persisted history (the turn ended server-side). */
  reloadHistory: boolean
  showRetryBanner: boolean
}

export interface StallRecoveryInput {
  /** Status from the runtime's read-only `/turn` probe. */
  turnStatus: ChatTurnStatus
  /** 1-based index of the probe attempt that produced `turnStatus`. */
  attempt: number
  /** Probe attempts allowed for an `unknown` answer before reloading history. */
  maxAttempts: number
}

export interface StallRecoveryGateInput {
  stalledTurnId: string | null
  recoveredTurnId: string | null
  renderDepthErrorTurnId: string | null
  userInitiatedStop: boolean
}

/**
 * Decide whether a stream ending without `data-turn-complete` should launch
 * automatic recovery. A React update-depth error is not a transport stall:
 * replaying the same buffered turn immediately feeds the overloaded render
 * tree again and creates the repeated Sentry #185 cluster.
 */
export function shouldAutoRecoverStalledTurn({
  stalledTurnId,
  recoveredTurnId,
  renderDepthErrorTurnId,
  userInitiatedStop,
}: StallRecoveryGateInput): boolean {
  if (!stalledTurnId || userInitiatedStop) return false
  if (renderDepthErrorTurnId === stalledTurnId) return false
  return recoveredTurnId !== stalledTurnId
}

/**
 * Decide what auto-recovery should do after one `/turn` probe. Pure + total.
 *
 *  - `active`                          -> reconnect (agent still running; reattach
 *                                         to the live buffer via `resumeStream()`).
 *  - `unreachable`                     -> retry-later, without limit (we couldn't
 *                                         reach the server; the turn may still be
 *                                         running — keep trying until the network
 *                                         is back or the user stops).
 *  - `unknown` and attempts remain     -> retry-later (the buffer may not be
 *                                         published yet, or the probe raced a
 *                                         warm-pool/pod transition).
 *  - terminal (`completed`/`failed`/`aborted`), or `unknown` with no attempts
 *    left                              -> reload-history (the turn ended
 *                                         server-side; the persisted messages are
 *                                         the truth, so show them — not an error).
 *
 * Critically this NEVER returns an action that re-sends or truncates.
 */
export function decideStallRecovery({
  turnStatus,
  attempt,
  maxAttempts,
}: StallRecoveryInput): StallRecoveryAction {
  if (turnStatus === "active") return "reconnect"
  if (turnStatus === "unreachable") return "retry-later"
  if (turnStatus === "unknown" && attempt < maxAttempts) return "retry-later"
  return "reload-history"
}

/** UI side effects for a recovery decision, kept pure for component tests. */
export function getStallRecoveryEffects(
  input: StallRecoveryInput,
): StallRecoveryEffects {
  const action = decideStallRecovery(input)
  const ended = action === "reload-history"
  return {
    action,
    interruptStuckTools: ended,
    reloadHistory: ended,
    showRetryBanner: false,
  }
}

/** Pure message transform shared by stream-error and stall-recovery paths. */
export function markStuckToolsInterrupted<
  T extends { role: string; parts?: unknown[] },
>(messages: T[], reason = "Interrupted"): T[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !message.parts) return message
    let changed = false
    const parts = message.parts.map((part: any) => {
      if (
        (part.type === "tool-invocation" || part.type === "dynamic-tool") &&
        (part.state === "partial-call" ||
          part.state === "call" ||
          part.state === "input-streaming" ||
          part.state === "input-available")
      ) {
        changed = true
        return { ...part, state: "error", output: { error: reason } }
      }
      return part
    })
    return changed ? ({ ...message, parts } as T) : message
  })
}

export interface RecoveryBackoffOptions {
  /** Initial delay in ms. Default 600. */
  initialMs?: number
  /** Max delay in ms. Default 30000. */
  maxMs?: number
}

/**
 * Exponential backoff (capped) for the recovery poll. Matches the
 * shape used by `auto-resuming-fetch` so the two recovery layers feel
 * consistent. `attempt` is 1-based; attempt 1 returns `initialMs`.
 */
export function computeRecoveryBackoff(
  attempt: number,
  opts: RecoveryBackoffOptions = {},
): number {
  const initialMs = opts.initialMs ?? 600
  const maxMs = opts.maxMs ?? 30_000
  const n = Math.max(1, attempt)
  return Math.min(initialMs * Math.pow(2, n - 1), maxMs)
}
