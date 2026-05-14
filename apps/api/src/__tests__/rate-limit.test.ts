// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `middleware/rate-limit`.
 *
 * The limiter is an in-memory sliding window keyed (by default) on the
 * client IP. These tests exercise it against a real Hono app so the
 * Context-derived branches (header parsing, JSON response shape, header
 * mutation) are covered end-to-end rather than mocked.
 *
 * What's pinned here:
 *   - `max` is honoured per key — Nth+1 request returns 429 with the
 *     documented JSON shape and Retry-After / X-RateLimit-* headers.
 *   - Different keys do not interfere with each other.
 *   - Sliding window: requests outside `windowMs` no longer count.
 *   - `keyGenerator` override (rate-limit per user instead of per IP).
 *   - `skipPrefixes` short-circuits the limiter for matching paths.
 *   - `LOAD_TEST_SECRET` header bypass.
 *   - IP extraction: x-forwarded-for (first hop), x-real-ip fallback,
 *     "unknown" when neither is set.
 *   - Separate `name`s use separate stores (no shared counters).
 *
 * `LOAD_TEST_SECRET` is read at module load time, so the bypass test
 * sets the env var BEFORE importing the module via `import.meta.require`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// Fresh-import helper
// ---------------------------------------------------------------------------
// The limiter holds module-level state (the store map + gcTimer). To keep
// tests independent we re-require the module after invalidating the
// cache, so each `freshRateLimiter()` returns a factory bound to a clean
// store.
function freshRateLimiter() {
  const path = require.resolve('../middleware/rate-limit')
  delete require.cache[path]
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../middleware/rate-limit').rateLimiter as typeof import('../middleware/rate-limit').rateLimiter
}

// ---------------------------------------------------------------------------
// LOAD_TEST_SECRET env wiring — captured before any limiter import so we
// can restore it between tests.
// ---------------------------------------------------------------------------
const originalLoadTestSecret = process.env.LOAD_TEST_SECRET

afterEach(() => {
  if (originalLoadTestSecret === undefined) delete process.env.LOAD_TEST_SECRET
  else process.env.LOAD_TEST_SECRET = originalLoadTestSecret
})

// ---------------------------------------------------------------------------
// Tiny Hono harness so we exercise the real middleware contract.
// ---------------------------------------------------------------------------
function makeApp(opts: Parameters<ReturnType<typeof freshRateLimiter>>[1] = {}, name = 'test') {
  delete process.env.LOAD_TEST_SECRET
  const rateLimiter = freshRateLimiter()
  const app = new Hono()
  app.use('*', rateLimiter(name, opts))
  app.get('/ok', (c) => c.text('ok'))
  app.get('/admin/x', (c) => c.text('admin'))
  return app
}

async function hit(app: Hono, path = '/ok', headers: Record<string, string> = {}) {
  return app.request(`http://localhost${path}`, { headers })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rateLimiter — basic counting', () => {
  test('allows up to `max` requests then 429s', async () => {
    const app = makeApp({ max: 3, windowMs: 60_000 })
    const ip = { 'x-forwarded-for': '203.0.113.1' }

    for (let i = 0; i < 3; i++) {
      const r = await hit(app, '/ok', ip)
      expect(r.status).toBe(200)
      expect(r.headers.get('x-ratelimit-limit')).toBe('3')
      expect(r.headers.get('x-ratelimit-remaining')).toBe(String(3 - (i + 1)))
    }

    const blocked = await hit(app, '/ok', ip)
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('60')
    expect(blocked.headers.get('x-ratelimit-limit')).toBe('3')
    expect(blocked.headers.get('x-ratelimit-remaining')).toBe('0')
    const body = await blocked.json()
    expect(body).toEqual({
      error: { code: 'rate_limited', message: 'Too many requests, please try again later' },
    })
  })

  test('keeps per-IP counters isolated', async () => {
    const app = makeApp({ max: 2 })

    // IP A uses both slots
    expect((await hit(app, '/ok', { 'x-forwarded-for': '1.1.1.1' })).status).toBe(200)
    expect((await hit(app, '/ok', { 'x-forwarded-for': '1.1.1.1' })).status).toBe(200)
    expect((await hit(app, '/ok', { 'x-forwarded-for': '1.1.1.1' })).status).toBe(429)

    // IP B is unaffected
    expect((await hit(app, '/ok', { 'x-forwarded-for': '2.2.2.2' })).status).toBe(200)
    expect((await hit(app, '/ok', { 'x-forwarded-for': '2.2.2.2' })).status).toBe(200)
    expect((await hit(app, '/ok', { 'x-forwarded-for': '2.2.2.2' })).status).toBe(429)
  })

  test('emits a custom message when provided', async () => {
    const app = makeApp({ max: 1, message: 'Slow down!' })
    await hit(app, '/ok', { 'x-forwarded-for': '9.9.9.9' })
    const r = await hit(app, '/ok', { 'x-forwarded-for': '9.9.9.9' })
    const body = await r.json()
    expect(body.error.message).toBe('Slow down!')
  })

  test('Retry-After scales with windowMs (ceil to seconds)', async () => {
    const app = makeApp({ max: 1, windowMs: 12_500 })
    await hit(app, '/ok', { 'x-forwarded-for': '4.4.4.4' })
    const r = await hit(app, '/ok', { 'x-forwarded-for': '4.4.4.4' })
    expect(r.headers.get('retry-after')).toBe('13') // ceil(12500/1000)
  })
})

describe('rateLimiter — sliding window', () => {
  let realNow: () => number
  let nowMs = 1_000_000

  beforeEach(() => {
    realNow = Date.now
    Date.now = () => nowMs
  })

  afterEach(() => {
    Date.now = realNow
  })

  test('forgets timestamps older than windowMs', async () => {
    const app = makeApp({ max: 2, windowMs: 10_000 })
    const ip = { 'x-forwarded-for': '7.7.7.7' }

    nowMs = 1_000_000
    expect((await hit(app, '/ok', ip)).status).toBe(200)
    nowMs = 1_000_100
    expect((await hit(app, '/ok', ip)).status).toBe(200)
    nowMs = 1_000_200
    expect((await hit(app, '/ok', ip)).status).toBe(429)

    // Advance past the window — both prior timestamps fall off.
    nowMs = 1_000_200 + 10_001
    expect((await hit(app, '/ok', ip)).status).toBe(200)
    expect((await hit(app, '/ok', ip)).status).toBe(200)
    expect((await hit(app, '/ok', ip)).status).toBe(429)
  })
})

describe('rateLimiter — keyGenerator', () => {
  test('rate-limits per-user when keyGenerator is overridden', async () => {
    const app = makeApp({
      max: 2,
      keyGenerator: (c) => c.req.header('x-user-id') || 'anon',
    })

    // Same IP, different users → independent buckets.
    const ip = { 'x-forwarded-for': '5.5.5.5' }
    expect((await hit(app, '/ok', { ...ip, 'x-user-id': 'u1' })).status).toBe(200)
    expect((await hit(app, '/ok', { ...ip, 'x-user-id': 'u1' })).status).toBe(200)
    expect((await hit(app, '/ok', { ...ip, 'x-user-id': 'u1' })).status).toBe(429)

    expect((await hit(app, '/ok', { ...ip, 'x-user-id': 'u2' })).status).toBe(200)
  })
})

describe('rateLimiter — skipPrefixes', () => {
  test('does not count requests whose path starts with a skipPrefix', async () => {
    const app = makeApp({ max: 1, skipPrefixes: ['/admin'] })
    const ip = { 'x-forwarded-for': '6.6.6.6' }

    // /admin/* never increments the bucket.
    for (let i = 0; i < 5; i++) {
      expect((await hit(app, '/admin/x', ip)).status).toBe(200)
    }

    // /ok still has its full quota.
    expect((await hit(app, '/ok', ip)).status).toBe(200)
    expect((await hit(app, '/ok', ip)).status).toBe(429)
  })
})

describe('rateLimiter — load-test bypass', () => {
  test('LOAD_TEST_SECRET + matching header bypasses the limiter', async () => {
    process.env.LOAD_TEST_SECRET = 'shh-its-load'
    const rateLimiter = freshRateLimiter()
    const app = new Hono()
    app.use('*', rateLimiter('lt', { max: 1 }))
    app.get('/ok', (c) => c.text('ok'))

    // Without the secret header → standard limiting still applies.
    expect((await hit(app, '/ok', { 'x-forwarded-for': '8.8.8.8' })).status).toBe(200)
    expect((await hit(app, '/ok', { 'x-forwarded-for': '8.8.8.8' })).status).toBe(429)

    // With the secret header → unlimited, even on the same key.
    for (let i = 0; i < 10; i++) {
      const r = await hit(app, '/ok', {
        'x-forwarded-for': '8.8.8.8',
        'x-load-test-key': 'shh-its-load',
      })
      expect(r.status).toBe(200)
    }

    // Wrong secret value is NOT bypassed.
    const wrong = await hit(app, '/ok', {
      'x-forwarded-for': '8.8.8.8',
      'x-load-test-key': 'wrong-value',
    })
    expect(wrong.status).toBe(429)
  })
})

describe('rateLimiter — IP extraction', () => {
  test('uses the first hop of x-forwarded-for', async () => {
    const app = makeApp({ max: 1 })
    // Two requests with the same FIRST hop but different downstream
    // proxies — should hit the same bucket.
    expect(
      (await hit(app, '/ok', { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' })).status,
    ).toBe(200)
    expect(
      (await hit(app, '/ok', { 'x-forwarded-for': '203.0.113.5, 10.0.0.99' })).status,
    ).toBe(429)
  })

  test('falls back to x-real-ip when x-forwarded-for is absent', async () => {
    const app = makeApp({ max: 1 })
    expect((await hit(app, '/ok', { 'x-real-ip': '198.51.100.7' })).status).toBe(200)
    expect((await hit(app, '/ok', { 'x-real-ip': '198.51.100.7' })).status).toBe(429)
  })

  test('groups all unidentified clients under a single "unknown" bucket', async () => {
    const app = makeApp({ max: 1 })
    expect((await hit(app, '/ok')).status).toBe(200)
    expect((await hit(app, '/ok')).status).toBe(429)
  })
})

describe('rateLimiter — independent named stores', () => {
  test('two limiters with different names do not share counters', async () => {
    const rateLimiter = freshRateLimiter()
    const app = new Hono()
    app.use('/api/a/*', rateLimiter('limiter-a', { max: 1 }))
    app.use('/api/b/*', rateLimiter('limiter-b', { max: 1 }))
    app.get('/api/a/x', (c) => c.text('a'))
    app.get('/api/b/x', (c) => c.text('b'))

    const ip = { 'x-forwarded-for': '203.0.113.99' }
    expect((await hit(app, '/api/a/x', ip)).status).toBe(200)
    expect((await hit(app, '/api/a/x', ip)).status).toBe(429)

    // Limiter B still has its own quota for the same IP.
    expect((await hit(app, '/api/b/x', ip)).status).toBe(200)
    expect((await hit(app, '/api/b/x', ip)).status).toBe(429)
  })
})

describe('rateLimiter — defaults', () => {
  test('default max is 100 (sanity check on the documented contract)', async () => {
    const app = makeApp({}) // no overrides
    const ip = { 'x-forwarded-for': '10.20.30.40' }
    let lastRemaining: string | null = null
    for (let i = 0; i < 100; i++) {
      const r = await hit(app, '/ok', ip)
      expect(r.status).toBe(200)
      lastRemaining = r.headers.get('x-ratelimit-remaining')
    }
    expect(lastRemaining).toBe('0')
    expect((await hit(app, '/ok', ip)).status).toBe(429)
  })
})
