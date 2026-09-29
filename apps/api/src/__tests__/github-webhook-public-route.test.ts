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
 * The blanket `/api/*` gate (now `middleware/api-auth-gate.ts`) allowlisted the voice webhook but
 * never allowlisted this one. GitHub's real webhook delivery carries no
 * Shogo session cookie or API key, so EVERY real delivery — installation,
 * push, issues, issue_comment, pull_request_review — was 401'd by
 * `requireAuth` before the request ever reached the handler's own signature
 * check. Found live: connecting a project's GitHub App to a repo for the
 * first time (issue-pipeline multi-project eval, L1) and hand-delivering a
 * signed synthetic `issues` webhook, since GitHub itself can't reach a local
 * dev server to have ever exercised this path before.
 *
 * This test runs the real gate (`apiAuthGate`), so a future edit that drops
 * the entry (or narrows it to a prefix that no longer matches the literal
 * path) fails here instead of silently breaking every live GitHub webhook.
 */
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret-github-webhook'

import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'

const { apiAuthGate } = await import('../middleware/api-auth-gate')

async function fakeAuthMiddleware(c: any, next: any) {
  c.set('auth', { isAuthenticated: false })
  await next()
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
    app.use('/api/*', apiAuthGate)
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
