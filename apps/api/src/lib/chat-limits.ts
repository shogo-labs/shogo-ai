// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cross-pod limits for team chat: fixed-window rate limits and a lease-based
 * semaphore for concurrent agent replies. Both use the shared Redis when
 * there is one and fall back to process memory (desktop, tests, or a Redis
 * outage), which only limits per pod.
 */

import type Redis from 'ioredis'
import { getSharedRedis } from './tunnel-redis'

type LimitsRedis = Pick<Redis, 'eval' | 'zrem'>

let redisOverride: LimitsRedis | null | undefined

/** Test hook: swap the Redis client (null forces the in-process fallback). */
export function _setChatLimitsRedisForTests(redis: LimitsRedis | null | undefined): void {
  redisOverride = redis
  windows.clear()
}

function redis(): LimitsRedis | null {
  return redisOverride !== undefined ? redisOverride : getSharedRedis()
}

// ─── Rate limits ─────────────────────────────────────────────────────────────

const windows = new Map<string, { resetAt: number; count: number }>()

const INCR_WINDOW = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`

function localHit(key: string, windowMs: number, now: number): number {
  const entry = windows.get(key)
  if (!entry || entry.resetAt <= now) {
    if (windows.size > 50_000) {
      for (const [k, v] of windows) if (v.resetAt <= now) windows.delete(k)
    }
    windows.set(key, { resetAt: now + windowMs, count: 1 })
    return 1
  }
  return ++entry.count
}

export interface RateLimitResult {
  allowed: boolean
  retryAfterSeconds: number
}

/** Count one action against `max` per `windowMs` for `key`. */
export async function takeRateLimit(key: string, max: number, windowMs: number): Promise<RateLimitResult> {
  const now = Date.now()
  const bucket = Math.floor(now / windowMs)
  const retryAfterSeconds = Math.max(1, Math.ceil(((bucket + 1) * windowMs - now) / 1000))
  const client = redis()
  let count: number | null = null
  if (client) {
    count = await (client.eval(INCR_WINDOW, 1, `chat:rl:${key}:${bucket}`, String(windowMs)) as Promise<number>).catch(() => null)
  }
  if (count === null) count = localHit(`${key}:${bucket}`, windowMs, now)
  return { allowed: count <= max, retryAfterSeconds }
}

export const CHAT_RATE_LIMITS = {
  /** Human posts per user per workspace. */
  message: { max: 60, windowMs: 60_000 },
  reaction: { max: 120, windowMs: 60_000 },
  /** Opening DMs, including agents starting DMs through their tools. */
  dmOpen: { max: 30, windowMs: 60_000 },
  /** Channel and DM posts from one agent's tools. */
  agentPost: { max: 30, windowMs: 60_000 },
  /** Huddle joins per user, so reconnect loops can't flood LiveKit or the roster. */
  huddleJoin: { max: 20, windowMs: 60_000 },
} as const

// ─── Semaphore ───────────────────────────────────────────────────────────────

// Leases expire on their own so a pod that dies mid-reply can't leak a slot.
const ACQUIRE_LEASE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[5])
  return 1
end
return 0`

/**
 * Try to take one of `max` slots for `key` across all pods. Returns a release
 * function, `false` when all slots are taken, or `null` when Redis is not
 * available (the caller falls back to its in-process limit).
 */
export async function tryAcquireSharedSlot(key: string, max: number, leaseMs: number): Promise<(() => void) | false | null> {
  const client = redis()
  if (!client) return null
  const token = crypto.randomUUID()
  const now = Date.now()
  const redisKey = `chat:slots:${key}`
  const got = await (client.eval(ACQUIRE_LEASE, 1, redisKey, String(now), String(now + leaseMs), String(max), token, String(leaseMs)) as Promise<number>)
    .catch(() => null)
  if (got === null) return null
  if (got !== 1) return false
  let released = false
  return () => {
    if (released) return
    released = true
    void client.zrem(redisKey, token).catch(() => {})
  }
}
