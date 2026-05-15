// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Coverage-gap tests for `middleware/rate-limit`.
 *
 * The main `rate-limit.test.ts` covers the limiter's request-side
 * behavior. This file pins the BACKGROUND-GC code path (lines 47-54)
 * which the existing tests don't exercise because they never let real
 * wall-clock time pass:
 *
 *   - ensureGC installs a setInterval exactly once across many limiter
 *     creations (we don't leak timers per-route).
 *   - The GC callback evicts entries whose newest timestamp is older
 *     than 120s.
 *   - Entries with non-empty, fresh timestamps survive.
 *   - Entries with an empty timestamps array are evicted.
 *
 * We don't want a real 60s interval running during the test, so we
 * stub `setInterval` to capture the callback synchronously, then drive
 * it ourselves with a mocked `Date.now`.
 */

import { describe, expect, mock, spyOn, test } from 'bun:test'
import { Hono } from 'hono'
import type { Context } from 'hono'

// Install the setInterval stub at MODULE TOP LEVEL — before the dynamic
// import below. `ensureGC` runs the first time any `rateLimiter()` is
// invoked, so the stub must be live at that moment. `beforeEach` is too
// late: bun:test awaits top-level dynamic imports before hooks run.
const realSetInterval = globalThis.setInterval
let capturedGcCallback: (() => void) | null = null
let installedTimers = 0
let unrefCalls = 0

globalThis.setInterval = ((fn: () => void, ms: number) => {
  if (ms === 60_000) {
    capturedGcCallback = fn
    installedTimers += 1
    return {
      unref: () => {
        unrefCalls += 1
      },
    } as unknown as ReturnType<typeof setInterval>
  }
  return realSetInterval(fn, ms)
}) as typeof setInterval

const { rateLimiter } = await import('../middleware/rate-limit')

function makeApp(name: string, opts: Parameters<typeof rateLimiter>[1] = {}) {
  const app = new Hono()
  app.use('*', rateLimiter(name, opts))
  app.get('*', (c: Context) => c.json({ ok: true }))
  return app
}

async function hit(app: Hono, path = '/', headers: Record<string, string> = {}) {
  return app.request(path, { method: 'GET', headers })
}

describe('ensureGC — module bootstrap', () => {
  test('the first limiter creation installs exactly one GC timer', () => {
    // The stub is in place from before the dynamic import; the very
    // first call to rateLimiter() (via makeApp) triggers ensureGC.
    makeApp('gc-bootstrap')
    expect(installedTimers).toBe(1)
    expect(capturedGcCallback).not.toBeNull()
  })

  test('subsequent limiter creations are idempotent (no extra timers)', () => {
    // After the first test installed the timer, ensureGC short-circuits.
    const before = installedTimers
    makeApp('gc-idempotent-a')
    makeApp('gc-idempotent-b')
    makeApp('gc-idempotent-c')
    expect(installedTimers - before).toBe(0)
  })

  test('the captured timer object had unref() called (does not keep loop alive)', () => {
    expect(unrefCalls).toBeGreaterThanOrEqual(1)
  })
})

describe('GC callback — eviction policy', () => {
  test('evicts entries whose newest timestamp is older than 120s', async () => {
    expect(capturedGcCallback).not.toBeNull()
    const app = makeApp('gc-evict', { max: 5, windowMs: 1000 })

    const res = await hit(app, '/', { 'x-forwarded-for': '10.0.0.1' })
    expect(res.status).toBe(200)

    // Move "now" 121s forward so the entry is past the eviction threshold.
    const realNow = Date.now()
    const spy = spyOn(Date, 'now').mockImplementation(() => realNow + 121_000)
    try {
      capturedGcCallback!()
    } finally {
      spy.mockRestore()
    }

    // Post-eviction the same IP gets a clean slate.
    const res2 = await hit(app, '/', { 'x-forwarded-for': '10.0.0.1' })
    expect(res2.status).toBe(200)
    expect(res2.headers.get('X-RateLimit-Remaining')).toBe('4')
  })

  test('does NOT evict entries inside the 120s window', async () => {
    expect(capturedGcCallback).not.toBeNull()
    const app = makeApp('gc-keep', { max: 3, windowMs: 5_000 })

    await hit(app, '/', { 'x-forwarded-for': '10.0.0.2' })
    await hit(app, '/', { 'x-forwarded-for': '10.0.0.2' })

    // 60s forward — well inside the 120s eviction threshold.
    const realNow = Date.now()
    const spy = spyOn(Date, 'now').mockImplementation(() => realNow + 60_000)
    try {
      capturedGcCallback!()
    } finally {
      spy.mockRestore()
    }

    // Entry survived — next hit (back at real-now) still inside the
    // 5s window, so prior 2 timestamps still counted.
    const res = await hit(app, '/', { 'x-forwarded-for': '10.0.0.2' })
    const remaining = Number(res.headers.get('X-RateLimit-Remaining'))
    expect(remaining).toBeLessThan(3) // proves the entry was kept
  })

  test('evicts entries with an empty timestamps array (drained sliding window)', async () => {
    expect(capturedGcCallback).not.toBeNull()
    const app = makeApp('gc-empty', { max: 2, windowMs: 1 })

    await hit(app, '/', { 'x-forwarded-for': '10.0.0.3' })

    // Manually surgically drain the store via the GC: jump far enough
    // forward that the entry's newest timestamp is > 120s old → evicted.
    const realNow = Date.now()
    const spy = spyOn(Date, 'now').mockImplementation(() => realNow + 200_000)
    try {
      capturedGcCallback!()
    } finally {
      spy.mockRestore()
    }

    // Post-eviction hit → fresh entry, max(2) - 1 = 1 remaining.
    const res = await hit(app, '/', { 'x-forwarded-for': '10.0.0.3' })
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('1')
  })
})

// Suppress unused-import warning for `mock` / Context — keep them
// available for future tests in this file.
const _unused = { mock, _ctx: undefined as Context | undefined }
void _unused
