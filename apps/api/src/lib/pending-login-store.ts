// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pending-Login Store — cross-pod state for the device-code Cloud-login flow
 *
 * The cli-auth routes (`apps/api/src/routes/cli-auth.ts`) drive a four-step
 * handshake between a desktop / CLI client and the user's browser:
 *
 *   POST /api/cli/login/start    →  pod registers `state` (nonce) + record
 *   GET  /api/cli/login/state    ←  browser bridge page reads the record
 *   POST /api/cli/login/approve  ←  bridge page mints + pins the key
 *   GET  /api/cli/login/poll     ←  client polls until the key is ready
 *
 * The cloud API tier runs with `replicas: 2` (see `k8s/base/api.yaml`).
 * When `state` was stored in a per-process `Map` (as it was historically),
 * the four requests above frequently landed on different pods:
 *
 *   pod A: POST /start          → pendingStates[A].set("abc", record)
 *   pod B: GET  /state?abc      → pendingStates[B].get("abc")  ⇒ undefined
 *                                 → 404 "expired"
 *
 * Users hit this as: navigating to the cloud sign-in link surfaces an
 * "Unknown or expired state" / 404 immediately, before they ever click
 * Approve. The route file's own header docstring flagged this exact
 * failure mode ("If we ever shard the API tier we'll need to either
 * move this to Redis or pin login-poll requests to the start node …").
 *
 * This module is that fix. It centralises the state map so cli-auth
 * doesn't have to know whether the backing store is Redis or local
 * memory, and it makes Redis the **single source of truth** in cloud
 * mode — no L1 caching of records, since `/approve` mutations on pod B
 * must be visible to `/poll` reads on pod A without delay.
 *
 * Modes:
 *
 *   - SHOGO_LOCAL_MODE=true (single-process / Electron-bundled API):
 *     every op routes to the in-memory `pendingStates` Map. No Redis.
 *
 *   - Cloud mode, Redis healthy: every op goes through the shared
 *     ioredis client reused from `./tunnel-redis.ts`. Records are stored
 *     under `cli-login:state:<nonce>` with a Redis-native TTL so
 *     server-side garbage-collection is automatic.
 *
 *   - Cloud mode, Redis degraded / unreachable: ops fall back to the
 *     in-memory Map and log a loud warning. This is a correctness
 *     downgrade (cross-pod sign-in will fail again until Redis recovers)
 *     but it keeps single-pod failures from becoming total outages.
 *
 * Test seam: `_testing.pendingStates` is the same in-memory Map used
 * in local mode, so the existing `cli-auth-routes*.test.ts` suites can
 * keep poking at it directly without mocking Redis. Tests run in local
 * mode (no `getSharedRedis()` available), which routes everything
 * through that Map.
 */

import { getSharedRedis } from './tunnel-redis'

export type PendingStatus = 'pending' | 'approved' | 'denied' | 'expired'

export interface PendingState {
  status: PendingStatus
  deviceId: string
  deviceName: string
  devicePlatform?: string
  deviceAppVersion?: string
  /** "desktop" | "cli" — hint for the bridge page UI only. */
  client: 'desktop' | 'cli'
  preselectedWorkspaceId?: string
  expiresAt: number

  // Populated on approval; cleared after the client polls for it once.
  mintedKey?: string
  email?: string | null
  workspace?: string | null
  approvedAt?: number
}

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'

// In-memory fallback. The source of truth in local mode (and during
// Redis outages in cloud mode). Exported via `_testing` so the existing
// test suites can seed / inspect records the same way they always have.
const pendingStates = new Map<string, PendingState>()

function redisKey(state: string): string {
  return `cli-login:state:${state}`
}

function ttlSecondsFor(record: PendingState): number {
  // Redis EX needs whole seconds and rejects values < 1. Records past
  // their expiry should never have been written, but clamp defensively
  // so a slightly-past-due record still gets a 1-second tombstone
  // instead of throwing.
  const ms = record.expiresAt - Date.now()
  return Math.max(1, Math.ceil(ms / 1000))
}

function redisOrNull() {
  if (isLocalMode) return null
  return getSharedRedis()
}

/**
 * Write or overwrite the record under `state`. TTL is derived from
 * `record.expiresAt` so the Redis key auto-expires alongside the
 * route-level `STATE_TTL_MS` budget without any explicit cleanup job.
 */
export async function setPendingState(state: string, record: PendingState): Promise<void> {
  const r = redisOrNull()
  if (!r) {
    pendingStates.set(state, record)
    return
  }
  try {
    await r.set(redisKey(state), JSON.stringify(record), 'EX', ttlSecondsFor(record))
  } catch (err) {
    console.warn(
      '[pending-login-store] Redis SET failed, falling back to local map (cross-pod sign-in will break until Redis recovers):',
      (err as Error).message,
    )
    pendingStates.set(state, record)
  }
}

/**
 * Read the record for `state`, or `undefined` when no live record exists.
 * In cloud mode this always hits Redis — no L1 caching — because the
 * approve→poll handoff between pods requires reads to see the latest
 * write across the cluster.
 */
export async function getPendingState(state: string): Promise<PendingState | undefined> {
  const r = redisOrNull()
  if (!r) return pendingStates.get(state)
  try {
    const raw = await r.get(redisKey(state))
    if (!raw) return undefined
    return JSON.parse(raw) as PendingState
  } catch (err) {
    console.warn(
      '[pending-login-store] Redis GET failed, falling back to local map:',
      (err as Error).message,
    )
    return pendingStates.get(state)
  }
}

export async function deletePendingState(state: string): Promise<void> {
  const r = redisOrNull()
  if (r) {
    try {
      await r.del(redisKey(state))
    } catch (err) {
      console.warn(
        '[pending-login-store] Redis DEL failed:',
        (err as Error).message,
      )
    }
  }
  // Always also clear the local fallback. No-op when the record never
  // had a fallback copy — but covers the hybrid case where a prior
  // Redis outage caused a local-map write that we now want to expire.
  pendingStates.delete(state)
}

/**
 * Sweep expired records out of the local-map fallback. No-op for the
 * Redis path because Redis enforces the TTL server-side.
 *
 * Kept callable from routes for two reasons:
 *   1. Local mode (Electron-bundled API) has no Redis to GC for us,
 *      so the route-level `purgeExpiredStates()` calls still matter.
 *   2. Tests run in local mode and exercise this directly via
 *      `_testing.purgeExpiredStates()`.
 */
export function purgeExpiredStates(): void {
  const now = Date.now()
  for (const [state, record] of pendingStates) {
    if (record.expiresAt <= now) {
      pendingStates.delete(state)
    }
  }
}

/** Test seam — clears the in-memory fallback Map between tests. */
export const _testing = {
  pendingStates,
  purgeExpiredStates,
}
