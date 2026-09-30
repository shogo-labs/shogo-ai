// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure model for the inline "Reconnecting…" status that replaces the
 * "Planning next moves" line while a turn is being retried.
 *
 * Retries come from three places, and the user sees one status:
 *   - the client can't reach the server (auto-resuming-fetch network retry,
 *     or the stall probe getting no answer)       → `offline` / `server`
 *   - the runtime can't reach the model upstream (connectivity park)
 *                                                  → `server`
 *   - the model provider is overloaded / failing (provider backoff)
 *                                                  → `provider`
 * A client-side failure wins: while we can't reach the server, anything the
 * runtime last told us is stale.
 *
 * Staging (elapsed since the episode began):
 *   < 5s    silent       — keep showing "Planning next moves"; most blips heal
 *   5–30s   reconnecting — "Reconnecting…"
 *   30s+    detailed     — cause-specific copy, elapsed time, "Retry now"
 *   2m+     long         — plus an action ("Switch to <model>" on overload,
 *                          a connection hint otherwise)
 */

export type RetryCause = "offline" | "server" | "provider"
export type RetryStage = "silent" | "reconnecting" | "detailed" | "long"

export interface TurnRetryStatus {
  cause: RetryCause
  /** Epoch ms the retry episode began. */
  startedAt: number
  /** Provider failure reason from the runtime, e.g. `overloaded`. */
  reason?: string
  /** The runtime saw the same failure repeatedly with no progress. */
  suspectedDeterministic?: boolean
}

export interface ServerRetryInput {
  cause: "offline" | "provider"
  reason?: string
  startedAt: number
  suspectedDeterministic?: boolean
}

export interface ClientRetryInput {
  offline: boolean
  startedAt: number
}

export const RETRY_STAGE_RECONNECTING_MS = 5_000
export const RETRY_STAGE_DETAILED_MS = 30_000
export const RETRY_STAGE_LONG_MS = 120_000

export function resolveTurnRetryStatus(
  server: ServerRetryInput | null,
  client: ClientRetryInput | null,
): TurnRetryStatus | null {
  if (client) {
    return {
      cause: client.offline ? "offline" : "server",
      startedAt: client.startedAt,
    }
  }
  if (server) {
    return {
      cause: server.cause === "provider" ? "provider" : "server",
      startedAt: server.startedAt,
      reason: server.reason,
      suspectedDeterministic: server.suspectedDeterministic,
    }
  }
  return null
}

export function retryStage(elapsedMs: number): RetryStage {
  if (elapsedMs < RETRY_STAGE_RECONNECTING_MS) return "silent"
  if (elapsedMs < RETRY_STAGE_DETAILED_MS) return "reconnecting"
  if (elapsedMs < RETRY_STAGE_LONG_MS) return "detailed"
  return "long"
}

export function formatRetryElapsed(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000))
  const mins = Math.floor(totalSec / 60)
  const secs = totalSec % 60
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
}

export interface RetryStatusView {
  stage: RetryStage
  /** Short shimmering headline. */
  headline: string
  /** Static text after the headline, e.g. "retrying automatically · 1m 5s". */
  trailing?: string
  /** Muted secondary line. */
  detail?: string
  showRetryNow: boolean
  /** Offer switching models (long stage, provider overload only). */
  suggestSwitchModel: boolean
}

function causeHeadline(status: TurnRetryStatus): string {
  switch (status.cause) {
    case "offline":
      return "You're offline"
    case "server":
      return "Can't reach Shogo"
    case "provider":
      return status.reason === "overloaded"
        ? "The model is overloaded"
        : "The model provider isn't responding"
  }
}

export function describeRetryStatus(status: TurnRetryStatus, now: number): RetryStatusView {
  const elapsed = Math.max(0, now - status.startedAt)
  const stage = retryStage(elapsed)
  if (stage === "silent" || stage === "reconnecting") {
    return {
      stage,
      headline: status.cause === "provider" ? "Retrying\u2026" : "Reconnecting\u2026",
      showRetryNow: false,
      suggestSwitchModel: false,
    }
  }
  const waiting =
    status.cause === "offline"
      ? "will resume when you're back online"
      : "retrying automatically"
  let detail: string | undefined
  if (status.suspectedDeterministic) {
    detail = "This keeps failing the same way. You can stop and try rephrasing."
  } else if (stage === "long" && status.cause !== "provider") {
    detail =
      status.cause === "offline"
        ? "Check your Wi-Fi or cellular connection."
        : "Your work is saved; this will pick up where it left off."
  }
  return {
    stage,
    headline: causeHeadline(status),
    trailing: `\u2014 ${waiting} \u00B7 ${formatRetryElapsed(elapsed)}`,
    detail,
    showRetryNow: true,
    suggestSwitchModel: stage === "long" && status.cause === "provider",
  }
}
