/**
 * External Channel Integration Tests
 *
 * Tests for channels that rely on external platforms: Slack, Telegram,
 * Discord, WhatsApp, Teams, Email.
 *
 * These channels can't be fully message-tested without real platform
 * credentials, but we CAN test:
 *   - Connect/disconnect API lifecycle with validation
 *   - Channel-specific webhook/messaging endpoints
 *   - Status reporting after connect attempts
 *
 * Run:
 *   AGENT_URL=http://localhost:6200 bun test e2e/channels/external-channels.integration.test.ts
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { getTestEnv, agentFetch, waitForAgent, type TestEnv } from './helpers'

let env: TestEnv

beforeAll(async () => {
  env = getTestEnv()
  await waitForAgent(env)
})

// ---------------------------------------------------------------------------
// Channel connect/disconnect API
// ---------------------------------------------------------------------------

describe('Channel Connect/Disconnect API', () => {
  const channelTypes = ['telegram', 'discord', 'slack', 'whatsapp', 'email'] as const

  test('rejects connect without type', async () => {
    const res = await agentFetch(env, '/agent/channels/connect', {
      method: 'POST',
      body: JSON.stringify({ config: {} }),
    })

    // Should be 400 — missing type
    expect([400, 503]).toContain(res.status)
  })

  test('rejects connect with invalid channel type', async () => {
    const res = await agentFetch(env, '/agent/channels/connect', {
      method: 'POST',
      body: JSON.stringify({ type: 'invalid_channel_type', config: {} }),
    })

    if (res.status === 503) {
      console.warn('Gateway not running, skipping')
      return
    }

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid channel type')
  })

  test('rejects disconnect without type', async () => {
    const res = await agentFetch(env, '/agent/channels/disconnect', {
      method: 'POST',
      body: JSON.stringify({}),
    })

    expect([400, 503]).toContain(res.status)
  })

  for (const type of channelTypes) {
    test(`${type}: connect with empty config fails with credential error`, async () => {
      const res = await agentFetch(env, '/agent/channels/connect', {
        method: 'POST',
        body: JSON.stringify({ type, config: {} }),
      })

      if (res.status === 503) {
        console.warn('Gateway not running, skipping')
        return
      }

      // Should fail because required credentials are missing
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error).toBeDefined()
      expect(typeof body.error).toBe('string')
      expect(body.error.length).toBeGreaterThan(0)

      console.log(`  ${type} connect error (expected): ${body.error}`)
    })
  }

  test('telegram: connect with bad token fails gracefully', async () => {
    const res = await agentFetch(env, '/agent/channels/connect', {
      method: 'POST',
      body: JSON.stringify({
        type: 'telegram',
        config: { botToken: 'invalid-token-12345' },
      }),
    })

    if (res.status === 503) return

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBeDefined()
  })

  test('slack: connect with bad tokens fails gracefully', async () => {
    const res = await agentFetch(env, '/agent/channels/connect', {
      method: 'POST',
      body: JSON.stringify({
        type: 'slack',
        config: { botToken: 'xoxb-fake', appToken: 'xapp-fake' },
      }),
    })

    if (res.status === 503) return

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBeDefined()
  })

  test('discord: connect with bad token fails gracefully', async () => {
    const res = await agentFetch(env, '/agent/channels/connect', {
      method: 'POST',
      body: JSON.stringify({
        type: 'discord',
        config: { botToken: 'fake-discord-token' },
      }),
    })

    if (res.status === 503) return

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// WhatsApp webhook endpoint
// ---------------------------------------------------------------------------

describe('WhatsApp Webhook Endpoint', () => {
  test('webhook verification rejects bad verify token', async () => {
    const res = await agentFetch(
      env,
      '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=test123',
    )

    expect(res.status).toBe(403)
  })

  test('webhook POST returns 200 (acknowledges even without adapter)', async () => {
    const res = await agentFetch(env, '/webhooks/whatsapp', {
      method: 'POST',
      body: JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{
          changes: [{
            value: {
              metadata: { phone_number_id: 'fake-test-id' },
              messages: [{
                from: '15551234567',
                type: 'text',
                text: { body: 'integration test message' },
                timestamp: String(Math.floor(Date.now() / 1000)),
              }],
            },
          }],
        }],
      }),
    })

    // WhatsApp webhooks must always return 200 to prevent Meta from retrying
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Teams messaging endpoint
// ---------------------------------------------------------------------------

describe('Teams Messaging Endpoint', () => {
  test('returns 503 when Teams channel is not configured', async () => {
    const statusRes = await agentFetch(env, '/agent/status')
    const status = await statusRes.json()
    const teamsChannel = status.channels?.find((c: any) => c.type === 'teams')

    if (teamsChannel?.connected) {
      console.log('Teams is actually connected, skipping 503 test')
      return
    }

    const res = await agentFetch(env, '/agent/channels/teams/messages', {
      method: 'POST',
      body: JSON.stringify({
        type: 'message',
        text: 'integration test',
        from: { id: 'test-user', name: 'Test' },
        conversation: { id: 'test-conv' },
        serviceUrl: 'https://smba.trafficmanager.net/test/',
      }),
    })

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toContain('not configured')
  })
})

// ---------------------------------------------------------------------------
// Channel status after tests
// ---------------------------------------------------------------------------

describe('All Channel Status Report', () => {
  test('agent status reflects channel states correctly', async () => {
    const res = await agentFetch(env, '/agent/status')
    expect(res.ok).toBe(true)

    const status = await res.json()

    console.log('\n--- Full Channel Status After Integration Tests ---')
    for (const ch of status.channels || []) {
      const icon = ch.connected ? '[CONNECTED]' : '[DISCONNECTED]'
      const err = ch.error ? ` error: ${ch.error}` : ''
      console.log(`  ${icon} ${ch.type}${err}`)
    }
    console.log('---------------------------------------------------\n')

    // Each channel in the status array should have required fields
    for (const ch of status.channels || []) {
      expect(ch.type).toBeDefined()
      expect(typeof ch.connected).toBe('boolean')
    }
  })
})
