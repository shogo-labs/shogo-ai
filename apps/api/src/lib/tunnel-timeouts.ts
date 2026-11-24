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

/**
 * How long a request that reaches a paired desktop may take to produce response
 * headers before this API answers for it (SHO-538).
 *
 * Cloudflare gives an origin 100 s to send headers and then answers **524**, so
 * a request that spends its wake *plus* a proxy timeout on the same call has no
 * way to answer at all. Everything a desktop call waits for — the tunnel wake
 * and the request itself — is measured against this one budget, and a call that
 * runs out answers a retryable error of its own. The margin covers the pod's
 * own overhead before the edge sees anything.
 */
export const EDGE_RESPONSE_BUDGET_MS = envMs('SHOGO_EDGE_RESPONSE_BUDGET_MS', 90_000)

/**
 * How long a hosted-workspace request waits **inside itself** for an idle
 * desktop's tunnel to come back (SHO-538).
 *
 * A desktop only learns the cloud wants its tunnel from its next heartbeat poll,
 * and an idle one polls every 60 s (`POLL_INTERVAL_IDLE_S`) — longer than the
 * request may take. So the wake is capped here and a host that misses the window
 * answers `host_connecting` for the client to retry, rather than holding a
 * header-less request until the edge gives up on it.
 */
export const HOST_WAKE_INTERACTIVE_MS = envMs('SHOGO_HOST_WAKE_INTERACTIVE_MS', 20_000)

/** Seconds to tell a caller to wait before asking a waking host again. */
export const HOST_RETRY_AFTER_S = 15
