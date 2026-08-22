// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure circuit-breaker logic for the *automatic* chat-stream resume paths
 * (Effect 1's post-load live-turn probe and `attemptStallRecovery`'s stall
 * detector in ChatPanel.tsx) — as opposed to the user-initiated `handleRetry`
 * tap, which always honors the user's explicit request and is never gated.
 *
 * The incident this guards against: a real user's desktop logs showed a
 * ~45-minute storm of `[AgentChat] Stream reconnect: ... fromSeq=0` lines
 * every ~8-10 seconds. Both automatic paths are individually guarded against
 * re-firing for the *same* turn (see `recoveredTurnIdRef` / `myGeneration` in
 * ChatPanel.tsx), but nothing stopped the pair of paths — or repeated
 * "forward progress" that itself immediately re-stalls — from re-triggering
 * `resumeStream()` indefinitely. Each call replays the AI SDK's default
 * `/stream` resume convention from `fromSeq=0` (it has no way to carry our
 * custom seq cursor), so a tight loop re-downloads the entire buffered turn
 * every cycle instead of settling.
 *
 * Extracted as a pure function (mirroring stall-recovery.ts /
 * chat-stall-watchdog.ts) so the trip condition is unit-testable without
 * React, timers, or the runtime.
 */

export interface CircuitBreakerOptions {
  /** Rolling window size in ms. Default 60_000 (60s). */
  windowMs?: number
  /** Trip once MORE than this many attempts land inside the window. Default 4. */
  maxInWindow?: number
}

export interface CircuitBreakerResult {
  /** Updated timestamp list — pass this back in as `timestamps` next call. */
  timestamps: number[]
  /** True once this call pushed the count past `maxInWindow`. */
  tripped: boolean
}

/**
 * Record one automatic-resume attempt at `now` and report whether the
 * breaker should trip. Pure + total: prunes timestamps outside the window,
 * appends `now`, and trips based on the resulting count. Deliberately
 * generous by default — a handful of legitimate reattaches (e.g. flaky wifi
 * during a long tool run) shouldn't trip it, but a tight reconnect loop will.
 */
export function recordAutoResumeAttempt(
  timestamps: readonly number[],
  now: number,
  opts: CircuitBreakerOptions = {},
): CircuitBreakerResult {
  const windowMs = opts.windowMs ?? 60_000
  const maxInWindow = opts.maxInWindow ?? 4
  const recent = timestamps.filter((t) => now - t < windowMs)
  recent.push(now)
  return { timestamps: recent, tripped: recent.length > maxInWindow }
}
