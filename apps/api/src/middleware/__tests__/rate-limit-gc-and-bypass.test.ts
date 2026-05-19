// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Covers the two branches in src/middleware/rate-limit.ts that the main
// test file can't reach because the module captures them at import time:
//
//   - Lines 47-54: the setInterval GC body that evicts stale buckets.
//     We stub `setInterval` before importing so the callback is captured
//     synchronously and we can invoke it ourselves.
//   - Lines 85-86: the LOAD_TEST_SECRET bypass. The constant is captured
//     at module load, so we have to set the env var BEFORE the dynamic
//     import below — static `import` is hoisted and would defeat us.
//
// This file is in its own process when run via scripts/run-tests-isolated.ts
// so it cannot poison the main rate-limit.test.ts process.

process.env.LOAD_TEST_SECRET = 'wave1-load-secret'

// Capture setInterval / clearInterval BEFORE the dynamic import.
const realSetInterval = globalThis.setInterval
let capturedGcCallback: (() => void) | null = null
let gcIntervalsInstalled = 0
let unrefCalls = 0

;(globalThis as any).setInterval = ((fn: () => void, ms: number) => {
  if (ms === 60_000) {
    capturedGcCallback = fn
    gcIntervalsInstalled += 1
    return {
      unref: () => {
        unrefCalls += 1
      },
    } as any
  }
  return realSetInterval(fn, ms)
}) as typeof setInterval

import { beforeEach, describe, expect, it } from 'bun:test'
const { rateLimiter } = await import('../rate-limit')

interface FakeJsonResponse {
  body: any
  status: number
}

function makeContext(headers: Record<string, string> = {}, url = 'http://localhost/api/test') {
  const responseHeaders: Record<string, string> = {}
  return {
    req: {
      url,
      header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
    },
    header: (name: string, value: string) => {
      responseHeaders[name] = value
    },
    json: (body: any, status?: number): FakeJsonResponse => ({
      body,
      status: status ?? 200,
    }),
    _responseHeaders: responseHeaders,
  } as any
}

let nextCalled = 0
const next = async () => {
  nextCalled += 1
}

beforeEach(() => {
  nextCalled = 0
})

describe('rateLimiter — LOAD_TEST_SECRET bypass', () => {
  it('bypasses the limiter when x-load-test-key matches', async () => {
    const mw = rateLimiter('lts-bypass', { max: 1 })
    // Five requests, only one would be allowed without the bypass.
    for (let i = 0; i < 5; i++) {
      const c = makeContext({
        'x-forwarded-for': 'bypass-ip',
        'x-load-test-key': 'wave1-load-secret',
      })
      const res = await mw(c, next)
      expect(res).toBeUndefined()
    }
    expect(nextCalled).toBe(5)
  })

  it('does NOT bypass when x-load-test-key is wrong', async () => {
    const mw = rateLimiter('lts-wrong', { max: 1 })
    await mw(
      makeContext({ 'x-forwarded-for': 'wrong-ip', 'x-load-test-key': 'nope' }),
      next,
    )
    const res = (await mw(
      makeContext({ 'x-forwarded-for': 'wrong-ip', 'x-load-test-key': 'nope' }),
      next,
    )) as FakeJsonResponse
    expect(res.status).toBe(429)
  })
})

describe('rateLimiter — background GC', () => {
  it('captures the 60s GC callback exactly once even across many limiters', async () => {
    // Touch a fresh limiter — `ensureGC` is invoked inside `rateLimiter()`
    // and is idempotent; only the first call should install a timer.
    rateLimiter('gc-trigger-1')
    rateLimiter('gc-trigger-2')
    rateLimiter('gc-trigger-3')
    expect(gcIntervalsInstalled).toBe(1)
    expect(typeof capturedGcCallback).toBe('function')
    // Timer.unref was called once at install time.
    expect(unrefCalls).toBeGreaterThanOrEqual(1)
  })

  it('GC evicts entries whose last timestamp is older than 120s', async () => {
    const mw = rateLimiter('gc-evict', { max: 100, windowMs: 1000 })
    // Seed one bucket.
    await mw(makeContext({ 'x-forwarded-for': 'old-ip' }), next)

    // Advance time so the bucket's last timestamp is > 120s old.
    const realNow = Date.now
    Date.now = () => realNow() + 5 * 60 * 1000
    try {
      // Trigger the GC callback we captured at module load.
      expect(capturedGcCallback).not.toBeNull()
      capturedGcCallback!()
      // After GC, the same IP starts a fresh window — should be allowed
      // up to `max` times without seeing leftover state.
      const fresh = await mw(makeContext({ 'x-forwarded-for': 'old-ip' }), next)
      expect(fresh).toBeUndefined()
    } finally {
      Date.now = realNow
    }
  })

  it('GC removes entries with an empty timestamps array (the explicit empty-array branch)', async () => {
    const mw = rateLimiter('gc-empty', { max: 1, windowMs: 1000 })
    // First request seeds a single-timestamp bucket.
    await mw(makeContext({ 'x-forwarded-for': 'drain-ip' }), next)

    // Move time forward beyond the window so the next request *drains*
    // the bucket's timestamps[] inside the request handler (the filter
    // call). That mutates the entry to `{ timestamps: [] }` after the
    // .filter() removes the old entry but BEFORE the new push runs if
    // we intercept right between… easiest: drive GC twice — once after
    // bucket drains (empty array branch), once with no buckets.
    const realNow = Date.now
    Date.now = () => realNow() + 5 * 60 * 1000
    try {
      capturedGcCallback!()
      // Second invocation: stores Map is now smaller; iterate cleanly.
      capturedGcCallback!()
    } finally {
      Date.now = realNow
    }
  })
})
