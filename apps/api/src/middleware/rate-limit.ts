/**
 * Rate Limiting Middleware
 *
 * In-memory sliding window rate limiter. Each key (IP or user) gets a window
 * of `windowMs` during which at most `max` requests are allowed.
 *
 * When REDIS_URL is set in production, this should be swapped for a
 * Redis-backed store (e.g. ioredis + sorted sets) for cross-pod consistency.
 */

import type { Context, Next, MiddlewareHandler } from 'hono'

interface RateLimitEntry {
  timestamps: number[]
}

interface RateLimitOptions {
  /** Maximum requests per window (default: 100) */
  max?: number
  /** Window size in milliseconds (default: 60_000 = 1 minute) */
  windowMs?: number
  /** Extract the key to rate-limit on. Defaults to IP address. */
  keyGenerator?: (c: Context) => string
  /** Message returned when rate-limited (default: 'Too many requests') */
  message?: string
}

const stores = new Map<string, Map<string, RateLimitEntry>>()

function getStore(name: string): Map<string, RateLimitEntry> {
  let store = stores.get(name)
  if (!store) {
    store = new Map()
    stores.set(name, store)
  }
  return store
}

let gcTimer: ReturnType<typeof setInterval> | null = null

function ensureGC() {
  if (gcTimer) return
  gcTimer = setInterval(() => {
    const now = Date.now()
    for (const store of stores.values()) {
      for (const [key, entry] of store) {
        if (entry.timestamps.length === 0 || entry.timestamps[entry.timestamps.length - 1] < now - 120_000) {
          store.delete(key)
        }
      }
    }
  }, 60_000)
  if (gcTimer && typeof gcTimer === 'object' && 'unref' in gcTimer) {
    gcTimer.unref()
  }
}

function getClientIp(c: Context): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    'unknown'
  )
}

export function rateLimiter(
  name: string,
  opts: RateLimitOptions = {}
): MiddlewareHandler {
  const max = opts.max ?? 100
  const windowMs = opts.windowMs ?? 60_000
  const message = opts.message ?? 'Too many requests, please try again later'
  const keyGenerator = opts.keyGenerator ?? getClientIp
  const store = getStore(name)

  ensureGC()

  return async (c: Context, next: Next) => {
    const key = keyGenerator(c)
    const now = Date.now()
    const windowStart = now - windowMs

    let entry = store.get(key)
    if (!entry) {
      entry = { timestamps: [] }
      store.set(key, entry)
    }

    entry.timestamps = entry.timestamps.filter((t) => t > windowStart)

    if (entry.timestamps.length >= max) {
      c.header('Retry-After', String(Math.ceil(windowMs / 1000)))
      c.header('X-RateLimit-Limit', String(max))
      c.header('X-RateLimit-Remaining', '0')
      return c.json(
        { error: { code: 'rate_limited', message } },
        429
      )
    }

    entry.timestamps.push(now)

    c.header('X-RateLimit-Limit', String(max))
    c.header('X-RateLimit-Remaining', String(max - entry.timestamps.length))

    await next()
  }
}
