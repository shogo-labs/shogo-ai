/**
 * Agent Status Integration Tests
 *
 * Validates the agent's status and health endpoints, including channel
 * connectivity information. Useful as a quick smoke test for any environment.
 *
 * Run:
 *   AGENT_URL=http://localhost:6200 bun test e2e/channels/agent-status.integration.test.ts
 *   AGENT_URL=https://studio-staging.shogo.ai/api/projects/<id>/agent-proxy AUTH_COOKIE="..." bun test e2e/channels/agent-status.integration.test.ts
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { getTestEnv, agentFetch, waitForAgent, type TestEnv } from './helpers'

let env: TestEnv

beforeAll(async () => {
  env = getTestEnv()
  await waitForAgent(env)
})

describe('Agent Status', () => {
  test('health endpoint returns ok', async () => {
    const res = await agentFetch(env, '/health')
    expect(res.ok).toBe(true)

    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.runtimeType).toBe('agent')
    expect(typeof body.uptime).toBe('number')
    expect(body.uptime).toBeGreaterThanOrEqual(0)
  })

  test('detailed agent status is available', async () => {
    const res = await agentFetch(env, '/agent/status')
    expect(res.ok).toBe(true)

    const status = await res.json()
    expect(status.running).toBeDefined()
    expect(status.heartbeat).toBeDefined()
    expect(Array.isArray(status.channels)).toBe(true)
    expect(Array.isArray(status.skills)).toBe(true)

    // Heartbeat should have its configuration fields
    expect(typeof status.heartbeat.enabled).toBe('boolean')
  })

  test('lists connected channels with their status', async () => {
    const res = await agentFetch(env, '/agent/status')
    expect(res.ok).toBe(true)

    const status = await res.json()
    const channels: Array<{
      type: string
      connected: boolean
      error?: string
      metadata?: Record<string, unknown>
    }> = status.channels

    console.log(`Connected channels: ${channels.filter(c => c.connected).map(c => c.type).join(', ') || 'none'}`)

    for (const channel of channels) {
      expect(channel.type).toBeDefined()
      expect(typeof channel.type).toBe('string')
      expect(typeof channel.connected).toBe('boolean')

      if (channel.connected) {
        expect(channel.error).toBeUndefined()
      }
    }
  })

  test('webchat channel appears in status when connected', async () => {
    const res = await agentFetch(env, '/agent/status')
    const status = await res.json()

    const webchat = status.channels.find((c: any) => c.type === 'webchat')
    if (!webchat) {
      console.log('WebChat channel not present in status')
      return
    }

    if (webchat.connected) {
      expect(webchat.metadata).toBeDefined()
      expect(typeof webchat.metadata.messageCount).toBe('number')
      expect(typeof webchat.metadata.activeSessions).toBe('number')
      expect(webchat.metadata.config).toBeDefined()
      expect(webchat.metadata.config.title).toBeDefined()
    }
  })

  test('webhook channel appears in status when connected', async () => {
    const res = await agentFetch(env, '/agent/status')
    const status = await res.json()

    const webhook = status.channels.find((c: any) => c.type === 'webhook')
    if (!webhook) {
      console.log('Webhook channel not present in status')
      return
    }

    if (webhook.connected) {
      expect(webhook.metadata).toBeDefined()
      expect(typeof webhook.metadata.messageCount).toBe('number')
      expect(typeof webhook.metadata.authenticated).toBe('boolean')
    }
  })
})

describe('Channel Connectivity Matrix', () => {
  /**
   * This test doesn't assert pass/fail — it reports which channels
   * are connected and healthy. Useful as a deployment smoke check.
   */
  test('reports all channel statuses', async () => {
    const res = await agentFetch(env, '/agent/status')
    const status = await res.json()

    const channelTypes = ['webchat', 'webhook', 'telegram', 'slack', 'discord', 'whatsapp', 'teams', 'email']

    console.log('\n--- Channel Connectivity Report ---')
    console.log(`Agent: ${env.agentUrl}`)
    console.log(`Running: ${status.running}`)
    console.log('')

    for (const type of channelTypes) {
      const ch = status.channels.find((c: any) => c.type === type)
      if (ch) {
        const icon = ch.connected ? '[OK]' : '[FAIL]'
        const detail = ch.error ? ` (${ch.error})` : ''
        console.log(`  ${icon} ${type}${detail}`)
      } else {
        console.log(`  [--] ${type} (not configured)`)
      }
    }

    console.log('-----------------------------------\n')

    // At minimum, we confirmed the status endpoint works
    expect(status.running).toBeDefined()
  })
})
