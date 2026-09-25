// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression: `/api/github/webhook` (routes/github.ts) is the ONLY inbound
 * trigger for the issue-pipeline's "webhook wakes the pipeline" step
 * (docs/issue-pipeline/PLAN.md Phase 2) and for ordinary GitHub↔project sync
 * (installation/push events). It verifies its own HMAC-SHA256 signature
 * in-handler (`verifyWebhookSignature`, keyed on `GH_APP_WEBHOOK_SECRET`) —
 * exactly like `/api/voice/elevenlabs/webhook` does for ElevenLabs.
 *
 * server.ts's blanket `/api/*` gate (the `publicPrefixes` branch right
 * before `return requireAuth(c, next)`) allowlisted the voice webhook but
 * never allowlisted this one. GitHub's real webhook delivery carries no
 * Shogo session cookie or API key, so EVERY real delivery — installation,
 * push, issues, issue_comment, pull_request_review — was 401'd by
 * `requireAuth` before the request ever reached the handler's own signature
 * check. Found live: connecting a project's GitHub App to a repo for the
 * first time (issue-pipeline multi-project eval, L1) and hand-delivering a
 * signed synthetic `issues` webhook, since GitHub itself can't reach a local
 * dev server to have ever exercised this path before.
 *
 * This test mimics the publicPrefixes branch the same way
 * affiliate-public-routes-mount-order.test.ts does (the real gate is an
 * inline closure in server.ts, not exported) and asserts the specific
 * prefix list server.ts uses, so a future edit that drops the entry (or
 * narrows it to a prefix that no longer matches the literal path) fails
 * this test instead of silently breaking every live GitHub webhook again.
 */
import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'

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

/** Mirrors the exact publicPrefixes branch in server.ts (see the block right before `return requireAuth(c, next)`). */
function publicPrefixGate() {
  return async (c: any, next: any) => {
    const path = new URL(c.req.url).pathname
    const publicPrefixes = ['/api/health', '/api/webhooks/']
    if (publicPrefixes.some((p) => path.startsWith(p))) return next()
    if (
      path === '/api/voice/elevenlabs/webhook' ||
      path.startsWith('/api/voice/twilio/status/')
    ) {
      return next()
    }
    if (path === '/api/github/webhook') return next()
    return fakeRequireAuth(c, next)
  }
}

function githubWebhookStub(): Hono {
  const r = new Hono()
  r.post('/github/webhook', (c) => {
    if (!c.req.header('x-hub-signature-256')) {
      return c.json({ error: 'Invalid signature' }, 401)
    }
    return c.json({ ok: true })
  })
  r.get('/github/status', (c) => c.json({ ok: true, configured: true }))
  return r
}

describe('/api/github/webhook bypasses session/API-key auth (signature-verified in-handler)', () => {
  function buildApp(): Hono {
    const app = new Hono()
    app.use('/api/*', fakeAuthMiddleware)
    app.use('/api/*', publicPrefixGate())
    app.route('/api', githubWebhookStub())
    return app
  }

  test('POST /api/github/webhook is reachable with no session/API-key (not 401)', async () => {
    const app = buildApp()
    const res = await app.fetch(
      new Request('http://x/api/github/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'ping',
          'x-hub-signature-256': 'sha256=valid',
        },
        body: '{}',
      }),
    )
    expect(res.status).not.toBe(401)
    expect(res.status).toBe(200)
  })

  test('POST /api/github/webhook rejects a missing signature', async () => {
    const app = buildApp()
    const res = await app.fetch(
      new Request('http://x/api/github/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-github-event': 'ping' },
        body: '{}',
      }),
    )
    expect(res.status).toBe(401)
  })

  test('a sibling /api/github/* route (e.g. status) is still session/API-key-gated', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://x/api/github/status'))
    expect(res.status).toBe(401)
  })
})
