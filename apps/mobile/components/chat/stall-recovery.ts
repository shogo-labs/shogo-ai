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

export interface StallRecoveryEffects {
  action: StallRecoveryAction
  interruptStuckTools: boolean
  showRetryBanner: boolean
}

export interface StallRecoveryInput {
  /** Status from the runtime's read-only `/turn` probe. */
  turnStatus: ChatTurnStatus
  /** 1-based index of the probe attempt that produced `turnStatus`. */
  attempt: number
  /** Total probe attempts allowed before giving up. */
  maxAttempts: number
}

export interface StallRecoveryGateInput {
  stalledTurnId: string | null
  recoveredTurnId: string | null
  renderDepthErrorTurnId: string | null
  userInitiatedStop: boolean
}

/** A status the runtime reported for a turn that is no longer running. */
export function turnEndedOnServer(turnStatus: ChatTurnStatus): boolean {
  return turnStatus === "completed" || turnStatus === "failed" || turnStatus === "aborted"
}

export type StallTripDecision =
  /** The runtime is still running this turn — give it a fresh window. */
  | "stay-attached"
  /** The runtime is running it but this body is dead — reattach, no banner. */
  | "stop-and-reattach"
  /** The turn already ended server-side — drop the dead body and paint history. */
  | "stop-and-reload"
  /**
   * The runtime answered and holds no turn for this session (404/204): the
   * turn is not running there. Drop the body, paint saved history, and only
   * offer Retry if history has no reply for the prompt.
   */
  | "stop-and-verify"
  /** Nothing confirmed the turn is alive — break the wedge and offer Retry. */
  | "stop"

/**
 * How many consecutive trips a single turn may be kept alive for. One full
 * fresh window absorbs a slow first byte; a second window of complete silence
 * while the runtime still reports the turn running means the body this device
 * is reading is dead, so the panel drops it and reattaches from the buffer
 * instead of waiting on a socket that will never deliver.
 */
export const DEFAULT_STALL_KEEP_ALIVES = 1

export interface StallTripInput {
  turnStatus: ChatTurnStatus
  /** Whether the `/turn` probe was answered at all (see `ChatTurnSnapshot`). */
  answered: boolean
  /** Trips already kept alive for this same turn. */
  keptAlive?: number
  /** Budget before the body is declared dead. Defaults to {@link DEFAULT_STALL_KEEP_ALIVES}. */
  maxKeptAlive?: number
}

/**
 * What the stall watchdog should do once its threshold has passed and the
 * `/turn` probe has answered.
 *
 * The watchdog used to call `stop()` the moment client-side time crossed the
 * threshold, without asking the server anything. Every trip it recorded sat at
 * roughly threshold + one 15 s tick (~133 s against the 120 s `submitted`
 * threshold), which is exactly what a healthy turn looks like when the runtime
 * has not written a byte yet (cold pod, large prompt build, provider TTFB) or
 * when the socket died without an error. Aborting those turns is how a live
 * reply turned into "Runtime unreachable — tap retry" on web, iOS and Android.
 *
 * So: `active` keeps the turn (and only resets the window), a terminal status
 * reloads what the server already saved, and only an unanswered probe — where
 * nothing says the turn is alive — falls back to the old hard stop.
 */
export function decideStallTrip({
  turnStatus,
  answered,
  keptAlive = 0,
  maxKeptAlive = DEFAULT_STALL_KEEP_ALIVES,
}: StallTripInput): StallTripDecision {
  if (turnStatus === "active") {
    return keptAlive >= maxKeptAlive ? "stop-and-reattach" : "stay-attached"
  }
  if (answered && turnEndedOnServer(turnStatus)) return "stop-and-reload"
  if (answered && turnStatus === "unknown") return "stop-and-verify"
  return "stop"
}

export type StallGiveUpOutcome =
  /** The runtime says the turn ended: its reply (or failure) is saved. */
  | "reload-history"
  /**
   * The runtime answered that it has no turn for this session. The turn is
   * not running anywhere this client can reattach to; its reply is usually
   * already saved (the buffer is evicted after the grace window), so paint
   * history and show Retry only when history still ends on the prompt.
   */
  | "reload-then-check-reply"
  /** Nothing answered: the runtime may still be running it, so offer Retry. */
  | "show-retry"

/**
 * What the bounded recovery poll does once it gives up. Every answered probe
 * that reads "no turn here" used to end on the Retry banner after ~50 s, even
 * when the reply was already saved (Sentry chat_stall_recovery_gave_up with
 * probeAnswered=true on REACT-5Z / ANDROID-V / IOS-S / DESKTOP-15).
 */
export function decideStallGiveUp({
  turnStatus,
  answered,
}: {
  turnStatus: ChatTurnStatus
  answered: boolean
}): StallGiveUpOutcome {
  if (!answered) return "show-retry"
  if (turnEndedOnServer(turnStatus)) return "reload-history"
  return "reload-then-check-reply"
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

/** UI side effects for a recovery decision, kept pure for component tests. */
export function getStallRecoveryEffects(
  input: StallRecoveryInput,
): StallRecoveryEffects {
  const action = decideStallRecovery(input)
  return {
    action,
    interruptStuckTools: action === "give-up",
    showRetryBanner: action === "give-up",
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
