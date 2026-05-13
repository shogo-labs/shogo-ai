// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Warm Pool Self-Heal
 *
 * Helpers that detect a "promoted-but-orphaned" warm-pool pod (one whose
 * runtime is still in pool mode and rejecting requests with
 * `RUNTIME_AUTH_SECRET not configured`) and trigger eviction so the next
 * caller claims a fresh pod.
 *
 * Background: in the 2026-05-13 staging incident, K8s recreated promoted
 * warm-pool pods (OOM, drain, deploy) — the new pods came up in pool
 * mode without an assignment marker on emptyDir, but the K8s metadata
 * (labels, DB mapping, DomainMapping) still claimed they were promoted.
 * Every request to those pods returned a 401 forever. The chat handler
 * had inline detection-and-eviction logic, but no other caller (heartbeat
 * scheduler, voice signed-url proxy, knative health check, preview SPA)
 * shared it. This helper centralises the detection so any pod-facing
 * caller can self-heal cheaply.
 *
 * The chat handler keeps a high threshold (8 attempts) because it sees
 * transient 401s during normal warm-pool transitions. Background callers
 * (heartbeat, voice, health-check) can use threshold=1 because their 401
 * is never legitimate — those requests are issued from inside the API and
 * always carry a valid runtime token.
 */

const SENTINEL = 'RUNTIME_AUTH_SECRET not configured'

/**
 * Inspect a non-2xx response from a project pod and, if it looks like the
 * "promoted-but-orphaned" failure mode (HTTP 401 + `RUNTIME_AUTH_SECRET
 * not configured`), hard-evict the project so the next request claims a
 * fresh warm pod.
 *
 * @param projectId  The project whose pod returned the error.
 * @param status     HTTP status from the pod.
 * @param body       Response body (a `string` or anything coercible — we
 *                   call `String()` on it). Bodies are searched for the
 *                   sentinel substring.
 * @param attempts   How many consecutive 401-with-sentinel responses this
 *                   caller has observed. Pass 1 if you don't track
 *                   attempts (and accept the lower threshold).
 * @param threshold  Number of 401s required before eviction. Defaults to
 *                   1 — appropriate for background callers. The chat
 *                   handler should pass 8.
 *
 * @returns `true` if eviction was triggered (caller should treat the
 *          response as terminal and report a "session restarted" error
 *          to the user), `false` otherwise.
 */
export async function evictIfPodMissingAuth(
  projectId: string,
  status: number,
  body: unknown,
  attempts: number,
  threshold = 1,
): Promise<boolean> {
  if (status !== 401) return false
  const text = typeof body === 'string' ? body : String(body ?? '')
  if (!text.includes(SENTINEL)) return false
  if (attempts < threshold) return false

  console.error(
    `[WarmPoolSelfHeal] Pod for ${projectId} reported ${SENTINEL} after ${attempts} attempt(s) (threshold=${threshold}) — hard-evicting`,
  )
  try {
    const { getWarmPoolController } = await import('./warm-pool-controller')
    const wp = getWarmPoolController()
    await wp.evictProject(projectId, { deleteService: true })
    return true
  } catch (err: any) {
    console.error(`[WarmPoolSelfHeal] Eviction of ${projectId} failed: ${err?.message || err}`)
    // Even on eviction failure, return true so callers don't keep retrying
    // a permanently-broken pod. The next inbound request will hit the
    // (now-also-stale) DB mapping and either succeed via fallback paths
    // or surface its own error.
    return true
  }
}

/**
 * Convenience wrapper around `evictIfPodMissingAuth` for callers that
 * don't track per-project attempt counts: treats a single matching 401
 * as enough to trigger eviction. Use for heartbeat, voice, and health
 * paths — they only fire from inside the API and never produce
 * legitimate 401s, so a single hit is unambiguous.
 */
export function evictOnSingleMissingAuth(
  projectId: string,
  status: number,
  body: unknown,
): Promise<boolean> {
  return evictIfPodMissingAuth(projectId, status, body, 1, 1)
}

/** Exported for tests. */
export const RUNTIME_AUTH_MISSING_SENTINEL = SENTINEL
