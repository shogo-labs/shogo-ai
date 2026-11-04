// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Media spend holds — reserve a media job's known price between the moment it
 * is authorized and the moment it is charged.
 *
 * An async job (video, 3D) is authorized at submit and billed minutes later
 * when it completes. Without a hold, five parallel submits all read the same
 * remaining balance and only the last one's charge succeeds. A hold is that
 * reservation: `sumHolds` is added to the required balance of every later
 * submit until the hold is released (when the job is charged or fails) or its
 * TTL lapses.
 *
 * Redis (via `getSharedRedis`) is the cross-pod source of truth, so a submit on
 * one API replica is visible to the next. Local mode, and cloud mode while
 * Redis is unreachable, use a per-process Map. `withSpendLock` serializes the
 * read-then-reserve step per billing workspace so two submits cannot both see
 * the same room.
 */

import { getSharedRedis } from './tunnel-redis'

/** A live reservation. Expiry is absolute so a crashed pod cannot leak one forever. */
interface HoldEntry {
  usd: number
  expiresAt: number
}

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'
const localHolds = new Map<string, Map<string, HoldEntry>>()
/** Tail of the per-workspace critical section when there is no shared Redis. */
const localLocks = new Map<string, Promise<unknown>>()

const holdsKey = (billingWorkspaceId: string) => `media-spend-holds:${billingWorkspaceId}`
const lockKey = (billingWorkspaceId: string) => `media-spend-lock:${billingWorkspaceId}`

/** The lock only guards a balance read plus one hash write — a couple of round-trips. */
const LOCK_TTL_MS = 2_000
const LOCK_WAIT_MS = 1_000
const LOCK_RETRY_MS = 25

const RELEASE_IF_OWNED = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`

function redisOrNull() {
  if (isLocalMode) return null
  return getSharedRedis()
}

function parseHold(raw: string | null | undefined): HoldEntry | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<HoldEntry>
    if (typeof parsed.usd !== 'number' || typeof parsed.expiresAt !== 'number') return null
    return { usd: parsed.usd, expiresAt: parsed.expiresAt }
  } catch {
    return null
  }
}

function sumLocal(billingWorkspaceId: string, now: number): number {
  const holds = localHolds.get(billingWorkspaceId)
  if (!holds) return 0
  let total = 0
  for (const [holdId, entry] of holds) {
    if (entry.expiresAt <= now) holds.delete(holdId)
    else total += entry.usd
  }
  if (holds.size === 0) localHolds.delete(billingWorkspaceId)
  return total
}

/** Total USD currently reserved for `billingWorkspaceId` (expired holds excluded). */
export async function sumHolds(billingWorkspaceId: string): Promise<number> {
  const now = Date.now()
  const r = redisOrNull()
  if (!r) return sumLocal(billingWorkspaceId, now)
  try {
    const hash = await r.hgetall(holdsKey(billingWorkspaceId))
    if (!hash || Object.keys(hash).length === 0) return sumLocal(billingWorkspaceId, now)
    let total = 0
    const expired: string[] = []
    for (const [holdId, raw] of Object.entries(hash)) {
      const entry = parseHold(raw)
      if (!entry || entry.expiresAt <= now) expired.push(holdId)
      else total += entry.usd
    }
    if (expired.length > 0) {
      // Lazy sweep: the TTL on the hash keeps the key bounded even if this
      // never runs. Failure here only costs a stale member in a later read.
      await r.hdel(holdsKey(billingWorkspaceId), ...expired).catch(() => {})
    }
    return total
  } catch (err) {
    console.warn('[media-spend-hold] Redis HGETALL failed, using local holds:', (err as Error).message)
    return sumLocal(billingWorkspaceId, now)
  }
}

/** Reserve `usd` for `holdId` until `ttlSeconds` from now (re-placing replaces it). */
export async function placeHold(
  billingWorkspaceId: string,
  holdId: string,
  usd: number,
  ttlSeconds: number,
): Promise<void> {
  const entry: HoldEntry = { usd: Math.max(0, usd), expiresAt: Date.now() + ttlSeconds * 1000 }
  const r = redisOrNull()
  if (!r) {
    const holds = localHolds.get(billingWorkspaceId) ?? new Map<string, HoldEntry>()
    holds.set(holdId, entry)
    localHolds.set(billingWorkspaceId, holds)
    return
  }
  try {
    await r.hset(holdsKey(billingWorkspaceId), holdId, JSON.stringify(entry))
    // Keep the hash alive at least as long as its longest-lived member.
    await r.pexpire(holdsKey(billingWorkspaceId), ttlSeconds * 1000 + 60_000)
  } catch (err) {
    console.warn('[media-spend-hold] Redis HSET failed, keeping the hold locally:', (err as Error).message)
    const holds = localHolds.get(billingWorkspaceId) ?? new Map<string, HoldEntry>()
    holds.set(holdId, entry)
    localHolds.set(billingWorkspaceId, holds)
  }
}

/**
 * Drop a reservation. Idempotent: a job that charges and then fails to release
 * (or is polled twice) only ever deletes its own member, and the TTL covers a
 * release that never happens.
 */
export async function releaseHold(billingWorkspaceId: string, holdId: string): Promise<void> {
  localHolds.get(billingWorkspaceId)?.delete(holdId)
  const r = redisOrNull()
  if (!r) return
  try {
    await r.hdel(holdsKey(billingWorkspaceId), holdId)
  } catch (err) {
    console.warn('[media-spend-hold] Redis HDEL failed, hold will lapse at its TTL:', (err as Error).message)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Serializes work for one workspace in-process (local mode / Redis outage). */
async function withLocalLock<T>(billingWorkspaceId: string, fn: () => Promise<T>): Promise<T> {
  const previous = localLocks.get(billingWorkspaceId) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  localLocks.set(billingWorkspaceId, tail)
  try {
    return await run
  } finally {
    if (localLocks.get(billingWorkspaceId) === tail) localLocks.delete(billingWorkspaceId)
  }
}

/**
 * Run `fn` with the workspace's spend lock held, so the balance read inside it
 * cannot interleave with another submit's read-then-reserve.
 *
 * Waits up to `LOCK_WAIT_MS` and then proceeds without the lock: a stuck lock
 * must not deadlock media generation, and `sumHolds` still reflects every hold
 * placed so far, so the worst case is the pre-hold race this fixes.
 */
export async function withSpendLock<T>(
  billingWorkspaceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const r = redisOrNull()
  if (!r) return withLocalLock(billingWorkspaceId, fn)

  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const deadline = Date.now() + LOCK_WAIT_MS
  let acquired = false
  while (Date.now() < deadline) {
    try {
      const result = await r.set(lockKey(billingWorkspaceId), token, 'PX', LOCK_TTL_MS, 'NX')
      if (result === 'OK') {
        acquired = true
        break
      }
    } catch (err) {
      console.warn('[media-spend-hold] Redis lock unavailable, reserving without it:', (err as Error).message)
      break
    }
    await sleep(LOCK_RETRY_MS)
  }
  if (!acquired && Date.now() >= deadline) {
    console.warn(`[media-spend-hold] Spend lock for ${billingWorkspaceId} was busy; reserving without it.`)
  }
  try {
    return await fn()
  } finally {
    if (acquired) {
      await r.eval(RELEASE_IF_OWNED, 1, lockKey(billingWorkspaceId), token).catch(() => {})
    }
  }
}

/** Test seam — clears the in-memory fallback state between tests. */
export const _testing = { localHolds, localLocks }
