// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tunnel timeouts, in one place.
 *
 * The two used to be independent 30 s literals, and because they were equal the
 * relay always lost the race: the pod that owns the WebSocket gave up on the
 * desktop at the same instant the requesting pod gave up on *it*, so the caller
 * only ever saw "Cross-pod relay timed out" and never the real error. Every
 * timeout is derived from `PROXY_TIMEOUT_MS`, so the relay can no longer expire
 * before the proxy inside it does (SHO-185).
 *
 * `SHOGO_PROXY_TIMEOUT_MS` exists for tests: the two-pod relay test needs a
 * machine to answer slower than the proxy timeout without waiting 30 s.
 */

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/** How long one desktop request may take before the owning pod gives up on it. */
export const PROXY_TIMEOUT_MS = envMs('SHOGO_PROXY_TIMEOUT_MS', 30_000)

/**
 * Extra time the cross-pod relay gets on top of the proxy timeout: the reply
 * still has to be published and read back, so the owner pod must always be the
 * first to time out and report *why*.
 */
export const RELAY_GRACE_MS = envMs('SHOGO_RELAY_GRACE_MS', 5_000)

/** How long a pod waits for another pod's relayed reply. */
export const RELAY_TIMEOUT_MS = PROXY_TIMEOUT_MS + RELAY_GRACE_MS
