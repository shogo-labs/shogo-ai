/**
 * Webhook Channel Integration Tests (SHO-462)
 *
 * Tests the HTTP Webhook channel hit via the agent-proxy URL — WITHOUT an
 * AUTH_COOKIE. The only credential is X-Webhook-Secret. This is the scenario
 * that was broken before SHO-462: an unauthenticated POST would 401 at the
 * agent-proxy before the runtime ever saw the request.
 *
 * Run against cloud agent-proxy:
 *   AGENT_URL=https://api.shogo.ai/api/projects/<id>/agent-proxy \
 *   WEBHOOK_SECRET=<secret> \
 *   bun test e2e/channels/webhook.integration.test.ts
 *
 * Run against a local runtime directly (agent-proxy not in the path):
 *   AGENT_URL=http://localhost:6200 \
 *   WEBHOOK_SECRET=<secret> \
 *   bun test e2e/channels/webhook.integration.test.ts
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { getTestEnv, waitForAgent, type TestEnv } from './helpers'

let env: TestEnv
let channelConnected = false

beforeAll(async () => {
  env = getTestEnv()
  // waitForAgent uses /health which is behind auth when going through the proxy.
  // We skip it here and rely on the health endpoint check below.
  try { await waitForAgent(env) } catch { /* ok if behind auth */ }

  // Check channel health — no auth cookie, no shogo_sk_* key, just the secret
  const healthRes = await fetch(`${env.agentUrl}/agent/channels/webhook/health`, {
    headers: env.webhookSecret ? { 'X-Webhook-Secret': env.webhookSecret } : {},
  })
  if (healthRes.ok) {
    const body = await healthRes.json()
    channelConnected = body.status === 'healthy' && body.connected === true
  }
})

function skipIfNotConnected(msg = 'Webhook channel is not connected — skipping') {
  if (!channelConnected) console.warn(msg)
  return !channelConnected
}

describe('Webhook Channel — via agent-proxy without AUTH_COOKIE', () => {
  describe('no-credential request', () => {
    test('request with no X-Webhook-Secret returns 401', async () => {
      if (skipIfNotConnected()) return

      const res = await fetch(`${env.agentUrl}/agent/channels/webhook/incoming`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'no secret' }),
      })
      expect(res.status).toBe(401)
    })

    test('request with wrong X-Webhook-Secret returns 401 (constant-time compare)', async () => {
      if (skipIfNotConnected()) return

      const res = await fetch(`${env.agentUrl}/agent/channels/webhook/incoming`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': 'wrong-secret-aaaa' },
        body: JSON.stringify({ message: 'wrong secret' }),
      })
      expect(res.status).toBe(401)
    })

    test('Authorization: Bearer <secret> without X-Webhook-Secret returns 401 with guidance', async () => {
      if (skipIfNotConnected()) return
      if (!env.webhookSecret) return

      const res = await fetch(`${env.agentUrl}/agent/channels/webhook/incoming`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.webhookSecret}`,
        },
        body: JSON.stringify({ message: 'using old auth style' }),
      })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toMatch(/X-Webhook-Secret/i)
    })
  })

  describe('sync messaging via agent-proxy (no session)', () => {
    test('unauthenticated POST with correct X-Webhook-Secret reaches agent and returns reply + correlationId', async () => {
      if (skipIfNotConnected()) return
      if (!env.webhookSecret) {
        console.warn('WEBHOOK_SECRET not set — skipping sync test')
        return
      }

      const res = await fetch(`${env.agentUrl}/agent/channels/webhook/incoming`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': env.webhookSecret,
        },
        body: JSON.stringify({
          message: 'Integration test SHO-462: reply with WEBHOOK_PUBLIC_OK',
          senderId: 'e2e-sho462',
          senderName: 'SHO-462 Integration Test',
          metadata: { isTest: true },
        }),
      })

      // 200 (sync) or 202 (timeout — still correct behaviour)
      expect([200, 202]).toContain(res.status)
      const body = await res.json()
      expect(typeof body.correlationId).toBe('string')
      if (res.status === 200) {
        expect(typeof body.reply).toBe('string')
        expect(body.reply.length).toBeGreaterThan(0)
      } else {
        // 202 timeout: should have outboxUrl or status = pending
        expect(body.status).toBe('pending')
      }
    }, 130_000)

    test('valid X-Webhook-Secret + valid shogo_sk_* still works (regression)', async () => {
      if (skipIfNotConnected()) return
      if (!env.webhookSecret) return
      const apiKey = process.env.SHOGO_API_KEY
      if (!apiKey) {
        console.warn('SHOGO_API_KEY not set — skipping regression test')
        return
      }

      const res = await fetch(`${env.agentUrl}/agent/channels/webhook/incoming`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'X-Webhook-Secret': env.webhookSecret,
        },
        body: JSON.stringify({ message: 'bearer + secret combo' }),
      })
      expect([200, 202]).toContain(res.status)
    }, 130_000)
  })

  describe('outbox via agent-proxy (no session)', () => {
    test('GET outbox/<id> with correct secret returns empty array for unknown id', async () => {
      if (skipIfNotConnected()) return
      if (!env.webhookSecret) return

      const res = await fetch(`${env.agentUrl}/agent/channels/webhook/outbox/unknown-id-${Date.now()}`, {
        headers: { 'X-Webhook-Secret': env.webhookSecret },
      })
      expect(res.ok).toBe(true)
      const body = await res.json()
      expect(Array.isArray(body.messages)).toBe(true)
    })

    test('GET outbox/<id> without secret returns 401', async () => {
      if (skipIfNotConnected()) return

      const res = await fetch(`${env.agentUrl}/agent/channels/webhook/outbox/some-id`)
      expect(res.status).toBe(401)
    })
  })

  describe('gated paths still require auth', () => {
    test('/health is accessible (no auth required for health check on direct runtime)', async () => {
      // health doesn't go through the proxy auth gate on a direct runtime URL
      if (!env.agentUrl.includes('agent-proxy')) {
        const res = await fetch(`${env.agentUrl}/agent/channels/webhook/health`)
        expect(res.ok).toBe(true)
      }
    })
  })
})
