// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression tests for the csrf-eats-DELETE bug.
 *
 * Symptoms before the fix:
 *   Every DELETE /api/* request returned `500 {"error":{"code":"internal_error","message":""}}`,
 *   regardless of route. Cause:
 *     1. hono/csrf throws `HTTPException(403, { res })` for non-GET/HEAD
 *        requests with form-ish Content-Type (incl. the default `text/plain`)
 *        whose Origin doesn't pass the allow-list. Critically, when Origin
 *        is `undefined` Hono short-circuits to "deny" before ever calling
 *        the user-supplied `origin` handler.
 *     2. `app.onError` caught that HTTPException and converted it into a
 *        generic 500 with the empty `err.message`, hiding the real status.
 *
 * The two fixes that this test pins down:
 *   - `app.onError` returns `err.getResponse()` for any HTTPException so
 *     framework-level 4xx errors reach the client unchanged.
 *   - The /api/* csrf wrapper skips csrf entirely for requests that have
 *     neither Origin nor Referer (mobile fetch, server-to-server, curl, CLI).
 *     Browser cross-origin attacks cannot strip both headers.
 *
 * We don't boot the real server.ts (which imports Prisma, Redis, OTEL, …).
 * Instead we replicate the two relevant middleware layers on a minimal
 * Hono app — that's enough to exercise the bug and lock in the fix.
 */
import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { HTTPException } from 'hono/http-exception'

function buildApp(): Hono {
  const app = new Hono()

  // Mirror server.ts: onError must pass HTTPException through, never
  // collapse it to 500.
  app.onError((err, _c) => {
    if (err instanceof HTTPException) {
      return err.getResponse()
    }
    return new Response(JSON.stringify({ error: 'internal' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  })

  const csrfMw = csrf({
    origin: (origin) => {
      if (!origin) return true
      return origin === 'http://localhost:5173' || origin === 'http://localhost:5174'
    },
  })

  // Mirror server.ts's wrapper: skip csrf entirely when there's no Origin
  // AND no Referer (non-browser callers).
  app.use('/api/*', async (c, next) => {
    if (!c.req.header('origin') && !c.req.header('referer')) {
      return next()
    }
    return csrfMw(c, next)
  })

  app.get('/api/ping', (c) => c.json({ ok: true }))
  app.post('/api/echo', (c) => c.json({ method: 'POST' }))
  app.delete('/api/things/:id', (c) => c.json({ deleted: c.req.param('id') }))
  app.put('/api/things/:id', (c) => c.json({ updated: c.req.param('id') }))

  return app
}

async function call(
  app: Hono,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  const req = new Request(`http://test.local${path}`, {
    method,
    headers,
    body: body ?? undefined,
  })
  const res = await app.fetch(req)
  return { status: res.status, body: await res.text() }
}

describe('csrf + onError regression', () => {
  test('DELETE with no Origin / no Referer reaches the route handler (200, not 500)', async () => {
    const app = buildApp()
    const r = await call(app, 'DELETE', '/api/things/abc')
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toEqual({ deleted: 'abc' })
  })

  test('PUT with no Origin reaches the route handler', async () => {
    const app = buildApp()
    const r = await call(app, 'PUT', '/api/things/abc')
    expect(r.status).toBe(200)
  })

  test('DELETE with allowed Origin reaches the route handler', async () => {
    const app = buildApp()
    const r = await call(app, 'DELETE', '/api/things/abc', {
      origin: 'http://localhost:5173',
    })
    expect(r.status).toBe(200)
  })

  test('DELETE with disallowed Origin returns 403 (not 500)', async () => {
    const app = buildApp()
    const r = await call(app, 'DELETE', '/api/things/abc', {
      origin: 'https://evil.example.com',
      'content-type': 'text/plain',
    })
    // The pre-fix behavior was 500 here. After fix we get the real 403
    // that hono/csrf intended, via HTTPException.getResponse().
    expect(r.status).toBe(403)
    expect(r.body).toBe('Forbidden')
  })

  test('POST with no Origin and form-ish Content-Type reaches the route handler', async () => {
    // Before the fix this also hit the csrf trap because hono's csrf
    // matches `text/plain` against its form-element regex.
    const app = buildApp()
    const r = await call(
      app,
      'POST',
      '/api/echo',
      { 'content-type': 'text/plain' },
      'hello',
    )
    expect(r.status).toBe(200)
  })

  test('POST with disallowed Origin + form Content-Type still blocked as 403', async () => {
    const app = buildApp()
    const r = await call(
      app,
      'POST',
      '/api/echo',
      { origin: 'https://evil.example.com', 'content-type': 'application/x-www-form-urlencoded' },
      'a=1',
    )
    expect(r.status).toBe(403)
  })

  test('Referer alone (no Origin) is still subject to csrf — closes Origin-stripping attack surface', async () => {
    const app = buildApp()
    const r = await call(
      app,
      'DELETE',
      '/api/things/abc',
      { referer: 'https://evil.example.com/page', 'content-type': 'text/plain' },
    )
    expect(r.status).toBe(403)
  })

  test('onError still converts non-HTTPException errors to 500', async () => {
    const app = buildApp()
    app.get('/api/boom', () => {
      throw new Error('boom')
    })
    const r = await call(app, 'GET', '/api/boom')
    expect(r.status).toBe(500)
    expect(JSON.parse(r.body)).toEqual({ error: 'internal' })
  })

  test('GET requests are never subject to csrf regardless of headers', async () => {
    const app = buildApp()
    const r = await call(app, 'GET', '/api/ping', {
      origin: 'https://evil.example.com',
      'content-type': 'text/plain',
    })
    expect(r.status).toBe(200)
  })
})
