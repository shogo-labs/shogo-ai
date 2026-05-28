// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret-affiliate'
process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-secret-ai-proxy'
/**
 * Regression test for the staging incident on 2026-05-26:
 *
 * `userAttributionRoute` (admin.ts) and `licenseKeyRoutes` (license-keys.ts)
 * are mounted at `/api` via `app.route('/api', subRouter())` in server.ts.
 * Both used to register `router.use('*', requireAuth)`. In Hono v4 a `*`
 * middleware on a sub-router becomes part of the parent app's middleware
 * chain for *every* path under the mount prefix — not just the paths
 * actually registered in that sub-router. That meant any unauthenticated
 * /api/* endpoint mounted **after** those routers (e.g.
 * `/api/affiliates/lookup`, `/api/affiliates/click`) was rejected with 401
 * even though server.ts's own publicPrefixes allowlist explicitly bypassed
 * requireAuth for them.
 *
 * The fix in both routers was to scope `router.use(...)` to the actual
 * path patterns they handle instead of `*`. This test guards both
 * regressions by composing a stand-in app the same way server.ts does
 * and asserting that public affiliate paths return non-401.
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { Hono } from 'hono'

// Import the real router factories — we want to catch any regression
// where someone re-introduces `router.use('*', ...)`.
const { userAttributionRoute } = await import('../routes/admin')
const { licenseKeyRoutes } = await import('../routes/license-keys')

// Tiny stand-ins so we don't pull in the global rate limiter / csrf / etc.
async function fakeAuthMiddleware(c: any, next: any) {
  c.set('auth', { isAuthenticated: false })
  await next()
}
async function fakeRequireAuth(c: any, next: any) {
  if (!c.get('auth')?.isAuthenticated) {
    return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
  }
  await next()
}

// Mimic the publicPrefixes branch from server.ts.
function publicPrefixGate() {
  return async (c: any, next: any) => {
    const path = new URL(c.req.url).pathname
    const allowed = ['/api/affiliates/lookup', '/api/affiliates/click', '/api/health']
    if (allowed.some((p) => path.startsWith(p))) return next()
    return fakeRequireAuth(c, next)
  }
}

// Mock the public-but-secret-gated affiliate routes the same way
// server.ts mounts them: at /api after the polluters.
function affiliateStub(): Hono {
  const r = new Hono()
  r.get('/affiliates/lookup', (c) => c.json({ exists: false }))
  r.post('/affiliates/click', (c) => c.json({ ok: true }))
  return r
}

describe('public /api/* routes survive sub-router middleware mount order', () => {
  let app: Hono

  beforeAll(() => {
    app = new Hono()
    app.use('/api/*', fakeAuthMiddleware)
    app.use('/api/*', publicPrefixGate())
    // SAME mount order as server.ts:
    //   licenseKeyRoutes()        (line 6294)
    //   userAttributionRoute()    (line 6297)
    //   affiliateRoutes()         (line 6302)
    app.route('/api', licenseKeyRoutes())
    app.route('/api', userAttributionRoute())
    app.route('/api', affiliateStub())
  })

  test('GET /api/affiliates/lookup is reachable (not 401) despite polluter routers mounted first', async () => {
    const res = await app.fetch(new Request('http://x/api/affiliates/lookup?code=ghost'))
    expect(res.status).not.toBe(401)
    expect(res.status).toBe(200)
  })

  test('POST /api/affiliates/click is reachable (not 401) despite polluter routers mounted first', async () => {
    const res = await app.fetch(new Request('http://x/api/affiliates/click', { method: 'POST' }))
    expect(res.status).not.toBe(401)
    expect(res.status).toBe(200)
  })

  test('the would-be polluter routes themselves are still auth-gated', async () => {
    // userAttribution endpoint still requires auth (its scoped middleware
    // still fires for /api/users/me/*).
    const attribRes = await app.fetch(
      new Request('http://x/api/users/me/attribution', { method: 'POST' }),
    )
    expect(attribRes.status).toBe(401)

    // licenseKey redeem still requires auth.
    const redeemRes = await app.fetch(
      new Request('http://x/api/workspaces/ws_x/redeem-license', { method: 'POST' }),
    )
    expect(redeemRes.status).toBe(401)
  })
})
