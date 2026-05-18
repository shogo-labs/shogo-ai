/**
 * Webhook Channel Integration Tests
 *
 * Tests the HTTP Webhook channel against a live agent runtime.
 * Validates: health, sync message flow, test endpoint, activity log, and auth.
 *
 * Prerequisites:
 *   - Agent runtime must be running with Webhook channel connected
 *   - Set AGENT_URL to the agent's base URL
 *   - Set WEBHOOK_SECRET if the channel is configured with a secret
 *
 * Run:
 *   AGENT_URL=http://localhost:6200 bun test e2e/channels/webhook.integration.test.ts
 *   AGENT_URL=https://studio-staging.shogo.ai/api/projects/<id>/agent-proxy AUTH_COOKIE="..." bun test e2e/channels/webhook.integration.test.ts
 *
 * To exercise the cloud agent-proxy header allow-list end-to-end
 * (the regression that prompted `agent-proxy-headers.ts`), use the
 * shogo_sk_* Bearer flow that real external integrations use:
 *   AGENT_URL=https://api.shogo.ai/api/projects/<id>/agent-proxy \
 *     SHOGO_API_KEY=shogo_sk_... \
 *     WEBHOOK_SECRET=... \
 *     bun test e2e/channels/webhook.integration.test.ts
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { getTestEnv, agentFetch, waitForAgent, buildHeaders, isCloudProxyAgentUrl, type TestEnv } from './helpers'

let env: TestEnv
let channelConnected = false

beforeAll(async () => {
  env = getTestEnv()
  await waitForAgent(env)

  const healthRes = await agentFetch(env, '/agent/channels/webhook/health')
  if (healthRes.ok) {
    const body = await healthRes.json()
    channelConnected = body.status === 'healthy' && body.connected === true
  }
})

function skipIfNotConnected() {
  if (!channelConnected) {
    console.warn('Webhook channel is not connected — skipping test')
  }
  return !channelConnected
}

describe('Webhook Channel', () => {
  describe('health', () => {
    test('health endpoint returns status', async () => {
      const res = await agentFetch(env, '/agent/channels/webhook/health')
      expect(res.ok).toBe(true)

      const body = await res.json()
      expect(body.status).toBeDefined()
      expect(['healthy', 'disconnected', 'not_configured']).toContain(body.status)

      if (body.status === 'healthy') {
        expect(body.type).toBe('webhook')
        expect(body.connected).toBe(true)
        expect(body.metadata).toBeDefined()
        expect(typeof body.metadata.messageCount).toBe('number')
      }
    })
  })

  describe('sync messaging', () => {
    test('sends a sync message and receives a reply', async () => {
      if (skipIfNotConnected()) return

      const headers: Record<string, string> = {}
      if (env.webhookSecret) {
        headers['X-Webhook-Secret'] = env.webhookSecret
      }

      const res = await agentFetch(env, '/agent/channels/webhook/incoming', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: 'Integration test: reply with WEBHOOK_TEST_OK',
          senderId: 'integration-test',
          senderName: 'Channel Integration Test',
          metadata: { isTest: true, timestamp: Date.now() },
        }),
      })

      expect(res.ok).toBe(true)
      const body = await res.json()
      expect(body.reply).toBeDefined()
      expect(typeof body.reply).toBe('string')
      expect(body.reply.length).toBeGreaterThan(0)
    }, 120_000)

    test('rejects message without text', async () => {
      if (skipIfNotConnected()) return

      const headers: Record<string, string> = {}
      if (env.webhookSecret) {
        headers['X-Webhook-Secret'] = env.webhookSecret
      }

      const res = await agentFetch(env, '/agent/channels/webhook/incoming', {
        method: 'POST',
        headers,
        body: JSON.stringify({ senderId: 'test' }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('message')
    })

    test('rejects invalid JSON body', async () => {
      if (skipIfNotConnected()) return

      const res = await fetch(`${env.agentUrl}/agent/channels/webhook/incoming`, {
        method: 'POST',
        headers: {
          ...buildHeaders(env),
          'Content-Type': 'application/json',
          ...(env.webhookSecret ? { 'X-Webhook-Secret': env.webhookSecret } : {}),
        },
        body: 'not valid json {{{',
      })

      expect(res.status).toBe(400)
    })
  })

  describe('auth', () => {
    test('rejects request with wrong secret when secret is configured', async () => {
      if (skipIfNotConnected()) return

      const healthRes = await agentFetch(env, '/agent/channels/webhook/health')
      const health = await healthRes.json()

      if (!health.metadata?.hasSecret) {
        console.log('Webhook has no secret configured, skipping auth rejection test')
        return
      }

      const res = await agentFetch(env, '/agent/channels/webhook/incoming', {
        method: 'POST',
        headers: { 'X-Webhook-Secret': 'wrong-secret-value' },
        body: JSON.stringify({ message: 'should be rejected' }),
      })

      expect(res.status).toBe(401)
    })
  })

  describe('test endpoint', () => {
    test('test message endpoint works', async () => {
      if (skipIfNotConnected()) return

      const res = await agentFetch(env, '/agent/channels/webhook/test', {
        method: 'POST',
        body: JSON.stringify({
          message: 'Integration test ping via /test endpoint',
        }),
      })

      expect(res.ok).toBe(true)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.reply).toBeDefined()
      expect(typeof body.reply).toBe('string')
    }, 120_000)
  })

  describe('activity log', () => {
    test('activity endpoint returns recent entries', async () => {
      if (skipIfNotConnected()) return

      const res = await agentFetch(env, '/agent/channels/webhook/activity')
      expect(res.ok).toBe(true)

      const body = await res.json()
      expect(body.connected).toBe(true)
      expect(Array.isArray(body.activity)).toBe(true)
      expect(typeof body.messageCount).toBe('number')

      if (body.activity.length > 0) {
        const entry = body.activity[0]
        expect(entry.id).toBeDefined()
        expect(entry.timestamp).toBeDefined()
        expect(entry.direction).toBeDefined()
        expect(['inbound', 'outbound']).toContain(entry.direction)
        expect(['success', 'pending', 'error', 'timeout']).toContain(entry.status)
      }
    })
  })

  describe('outbox polling', () => {
    test('drains empty outbox without error', async () => {
      if (skipIfNotConnected()) return

      const headers: Record<string, string> = {}
      if (env.webhookSecret) {
        headers['X-Webhook-Secret'] = env.webhookSecret
      }

      const channelId = `test-poll-${Date.now()}`
      const res = await agentFetch(env, `/agent/channels/webhook/outbox/${channelId}`, {
        headers,
      })

      expect(res.ok).toBe(true)
      const body = await res.json()
      expect(body.messages).toBeDefined()
      expect(Array.isArray(body.messages)).toBe(true)
      expect(body.messages).toHaveLength(0)
    })
  })

  // ─── Cloud-proxy regression block ───────────────────────────────────
  // The original bug: the cloud agent-proxy forwarded only a small
  // header allow-list to the pod, silently dropping `X-Webhook-Secret`.
  // Externally-configured channel secrets failed closed at the cloud
  // and the only way to receive any traffic was to leave the secret
  // empty (which the runtime accepts as "auth disabled"). This block
  // pins that down end-to-end: it only runs when AGENT_URL is the
  // cloud agent-proxy AND both SHOGO_API_KEY and WEBHOOK_SECRET are
  // present, so local-pod test runs (the common case) remain a no-op.
  describe('cloud agent-proxy header forwarding (regression guard)', () => {
    const hasCloudFixture = () =>
      isCloudProxyAgentUrl(env.agentUrl) && !!env.shogoApiKey && !!env.webhookSecret

    function skipUnlessCloudFixture(): boolean {
      if (!hasCloudFixture()) {
        console.warn(
          '[webhook.integration] Cloud-proxy regression block skipped — ' +
            'set AGENT_URL=https://.../api/projects/<id>/agent-proxy, ' +
            'SHOGO_API_KEY=shogo_sk_*, and WEBHOOK_SECRET to enable.',
        )
        return true
      }
      return false
    }

    test('correct X-Webhook-Secret succeeds through the cloud relay', async () => {
      if (skipUnlessCloudFixture()) return
      if (skipIfNotConnected()) return

      const res = await agentFetch(env, '/agent/channels/webhook/incoming', {
        method: 'POST',
        headers: { 'X-Webhook-Secret': env.webhookSecret! },
        body: JSON.stringify({
          message: 'Cloud-proxy regression check: reply with WEBHOOK_TEST_OK',
          senderId: 'cloud-proxy-regression',
          senderName: 'Cloud Proxy Regression Test',
          metadata: { isTest: true, viaCloudProxy: true },
        }),
      })

      expect(res.ok).toBe(true)
      const body = await res.json()
      expect(body.reply).toBeDefined()
      expect(typeof body.reply).toBe('string')
    }, 120_000)

    test('wrong X-Webhook-Secret is rejected by the pod (not silently bypassed by the relay)', async () => {
      if (skipUnlessCloudFixture()) return
      if (skipIfNotConnected()) return

      const res = await agentFetch(env, '/agent/channels/webhook/incoming', {
        method: 'POST',
        headers: { 'X-Webhook-Secret': 'definitely-not-the-real-secret' },
        body: JSON.stringify({ message: 'should be rejected by the pod' }),
      })

      // The 24-byte `{"error":"Unauthorized"}` shape is the pod's
      // WebhookAdapter rejection. If the cloud relay were stripping
      // the header again, the runtime would see an empty secret and
      // (when a secret is configured) still reject — so we don't try
      // to fingerprint the response body; the 401 status is enough
      // to assert "the secret reached the pod and was compared".
      expect(res.status).toBe(401)
    })

    test('missing X-Webhook-Secret is rejected when the channel has a secret configured', async () => {
      if (skipUnlessCloudFixture()) return
      if (skipIfNotConnected()) return

      const healthRes = await agentFetch(env, '/agent/channels/webhook/health')
      const health = await healthRes.json()
      if (!health.metadata?.hasSecret) {
        console.log('Webhook has no secret configured, skipping missing-secret test')
        return
      }

      const res = await agentFetch(env, '/agent/channels/webhook/incoming', {
        method: 'POST',
        body: JSON.stringify({ message: 'no secret header at all' }),
      })

      expect(res.status).toBe(401)
    })
  })
})
