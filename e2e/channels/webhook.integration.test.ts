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
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { getTestEnv, agentFetch, waitForAgent, buildHeaders, type TestEnv } from './helpers'

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
})
