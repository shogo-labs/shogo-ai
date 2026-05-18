// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

// IMPORTANT: this test file exists to close coverage gaps on the
// `LOAD_TEST_SECRET` bypass and `skipPrefixes` branches in
// src/middleware/rate-limit.ts. The bypass constant is captured at
// module import time, so we MUST set the env var before the very first
// `import` of the limiter. This file is isolated by the test runner —
// no other code in this process should import rate-limit before this.

process.env.LOAD_TEST_SECRET = 'coverage-secret-9bf32'

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

// Dynamic import AFTER the env var assignment — ESM `import` statements
// are hoisted above all top-level code (including the env assignment
// above), so a static import would capture LOAD_TEST_SECRET as undefined.
const { rateLimiter } = await import('../middleware/rate-limit')

function makeApp(opts: Parameters<typeof rateLimiter>[1] = {}, name = 'cov') {
  const app = new Hono()
  app.use('*', rateLimiter(name, opts))
  app.get('/ok', (c) => c.text('ok'))
  app.get('/admin/x', (c) => c.text('admin'))
  app.get('/internal/health', (c) => c.text('h'))
  return app
}

async function hit(app: Hono, path = '/ok', headers: Record<string, string> = {}) {
  return app.request(`http://localhost${path}`, { headers })
}

describe('rateLimiter — LOAD_TEST_SECRET bypass (coverage of lines 84-86)', () => {
  test('exact-secret-match header bypasses the limiter entirely', async () => {
    const app = makeApp({ max: 1 })
    const ip = { 'x-forwarded-for': '7.7.7.7' }
    const secret = { ...ip, 'x-load-test-key': 'coverage-secret-9bf32' }

    // 20 hits, all bypass — exercises the `await next(); return` branch.
    for (let i = 0; i < 20; i++) {
      const r = await hit(app, '/ok', secret)
      expect(r.status).toBe(200)
    }
  })

  test('matching key produces 200 even after the same IP already hit the limit', async () => {
    const app = makeApp({ max: 1 }, 'cov-after-limit')
    const ip = { 'x-forwarded-for': '9.9.9.9' }

    // First, exhaust the limit without the secret.
    expect((await hit(app, '/ok', ip)).status).toBe(200)
    expect((await hit(app, '/ok', ip)).status).toBe(429)

    // Now the same IP with the secret bypasses → 200.
    const withSecret = { ...ip, 'x-load-test-key': 'coverage-secret-9bf32' }
    expect((await hit(app, '/ok', withSecret)).status).toBe(200)
    expect((await hit(app, '/ok', withSecret)).status).toBe(200)
  })

  test('wrong header value is NOT bypassed', async () => {
    const app = makeApp({ max: 1 }, 'cov-wrong')
    const ip = { 'x-forwarded-for': '1.2.3.4' }
    expect(
      (await hit(app, '/ok', { ...ip, 'x-load-test-key': 'nope' })).status
    ).toBe(200)
    expect(
      (await hit(app, '/ok', { ...ip, 'x-load-test-key': 'nope' })).status
    ).toBe(429)
  })

  test('missing header is NOT bypassed', async () => {
    const app = makeApp({ max: 1 }, 'cov-missing')
    const ip = { 'x-forwarded-for': '5.6.7.8' }
    expect((await hit(app, '/ok', ip)).status).toBe(200)
    expect((await hit(app, '/ok', ip)).status).toBe(429)
  })
})

describe('rateLimiter — skipPrefixes (coverage of lines 89-94)', () => {
  test('paths matching a skipPrefix bypass the limiter regardless of volume', async () => {
    const app = makeApp({ max: 1, skipPrefixes: ['/admin', '/internal'] }, 'cov-skip')
    const ip = { 'x-forwarded-for': '2.2.2.2' }

    // /admin/* — never increments. Try 30 hits, all 200.
    for (let i = 0; i < 30; i++) {
      expect((await hit(app, '/admin/x', ip)).status).toBe(200)
    }
    // /internal/* — same prefix, also bypasses.
    for (let i = 0; i < 30; i++) {
      expect((await hit(app, '/internal/health', ip)).status).toBe(200)
    }
    // /ok still has its full quota.
    expect((await hit(app, '/ok', ip)).status).toBe(200)
    expect((await hit(app, '/ok', ip)).status).toBe(429)
  })

  test('exact prefix-boundary: /admin (no trailing slash) matches /admin/...', async () => {
    const app = makeApp({ max: 1, skipPrefixes: ['/admin'] }, 'cov-boundary')
    const ip = { 'x-forwarded-for': '3.3.3.3' }
    // /admin/x starts with /admin → bypasses.
    expect((await hit(app, '/admin/x', ip)).status).toBe(200)
    expect((await hit(app, '/admin/x', ip)).status).toBe(200)
  })

  test('empty skipPrefixes array short-circuits the inner `if` (length check)', async () => {
    // skipPrefixes: [] → opts.skipPrefixes?.length is 0 (falsy) → branch skipped.
    const app = makeApp({ max: 1, skipPrefixes: [] }, 'cov-empty')
    const ip = { 'x-forwarded-for': '4.4.4.4' }
    expect((await hit(app, '/admin/x', ip)).status).toBe(200)
    expect((await hit(app, '/admin/x', ip)).status).toBe(429)
  })

  test('omitting skipPrefixes also short-circuits the branch', async () => {
    const app = makeApp({ max: 1 }, 'cov-undef')
    const ip = { 'x-forwarded-for': '6.6.6.6' }
    expect((await hit(app, '/admin/x', ip)).status).toBe(200)
    expect((await hit(app, '/admin/x', ip)).status).toBe(429)
  })

  test('non-matching prefix passes through to the standard limiter path', async () => {
    const app = makeApp({ max: 1, skipPrefixes: ['/admin'] }, 'cov-no-match')
    const ip = { 'x-forwarded-for': '7.0.0.1' }
    expect((await hit(app, '/ok', ip)).status).toBe(200)
    expect((await hit(app, '/ok', ip)).status).toBe(429)
  })
})
