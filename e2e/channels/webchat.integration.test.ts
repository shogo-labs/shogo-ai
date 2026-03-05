/**
 * WebChat Channel Integration Tests
 *
 * Tests the full WebChat channel lifecycle against a live agent runtime.
 * Validates: health, config, session creation, message send/reply, and SSE streaming.
 *
 * Prerequisites:
 *   - Agent runtime must be running with WebChat channel connected
 *   - Set AGENT_URL to the agent's base URL
 *
 * Run:
 *   AGENT_URL=http://localhost:6200 bun test e2e/channels/webchat.integration.test.ts
 *   AGENT_URL=https://studio-staging.shogo.ai/api/projects/<id>/agent-proxy AUTH_COOKIE="..." bun test e2e/channels/webchat.integration.test.ts
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { getTestEnv, agentFetch, collectSSEEvents, waitForAgent, type TestEnv } from './helpers'

let env: TestEnv

beforeAll(async () => {
  env = getTestEnv()
  await waitForAgent(env)
})

describe('WebChat Channel', () => {
  describe('health', () => {
    test('health endpoint returns status', async () => {
      const res = await agentFetch(env, '/agent/channels/webchat/health')
      expect(res.ok).toBe(true)

      const body = await res.json()
      expect(body.status).toBeDefined()

      if (body.status === 'not_configured') {
        console.warn('WebChat channel is not configured — skipping remaining webchat tests')
        return
      }

      expect(body.status).toBe('healthy')
      expect(body.type).toBe('webchat')
      expect(body.connected).toBe(true)
    })
  })

  describe('config', () => {
    test('returns widget configuration', async () => {
      const res = await agentFetch(env, '/agent/channels/webchat/config')

      if (res.status === 503) {
        console.warn('WebChat not connected, skipping config test')
        return
      }

      expect(res.ok).toBe(true)
      const config = await res.json()

      expect(config.title).toBeDefined()
      expect(typeof config.title).toBe('string')
      expect(config.primaryColor).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(['bottom-right', 'bottom-left']).toContain(config.position)
    })
  })

  describe('session', () => {
    test('creates a new session', async () => {
      const res = await agentFetch(env, '/agent/channels/webchat/session', {
        method: 'POST',
      })

      if (res.status === 503) {
        console.warn('WebChat not connected, skipping session test')
        return
      }

      expect(res.ok).toBe(true)
      const body = await res.json()

      expect(body.sessionId).toBeDefined()
      expect(typeof body.sessionId).toBe('string')
      expect(body.sessionId.length).toBeGreaterThan(0)
    })

    test('resumes an existing session', async () => {
      const createRes = await agentFetch(env, '/agent/channels/webchat/session', {
        method: 'POST',
      })
      if (createRes.status === 503) return

      const { sessionId } = await createRes.json()

      const resumeRes = await agentFetch(env, '/agent/channels/webchat/session', {
        method: 'POST',
        headers: { 'X-WebChat-Session': sessionId },
      })

      expect(resumeRes.ok).toBe(true)
      const body = await resumeRes.json()
      expect(body.sessionId).toBe(sessionId)
    })
  })

  describe('messaging', () => {
    test('sends a message and receives a reply', async () => {
      const sessionRes = await agentFetch(env, '/agent/channels/webchat/session', {
        method: 'POST',
      })
      if (sessionRes.status === 503) {
        console.warn('WebChat not connected, skipping message test')
        return
      }

      const { sessionId } = await sessionRes.json()

      const msgRes = await agentFetch(env, '/agent/channels/webchat/message', {
        method: 'POST',
        body: JSON.stringify({
          message: 'Hello, this is an integration test. Reply with exactly: CHANNEL_TEST_OK',
          sessionId,
        }),
      })

      expect(msgRes.ok).toBe(true)
      const body = await msgRes.json()
      expect(body.reply).toBeDefined()
      expect(typeof body.reply).toBe('string')
      expect(body.reply.length).toBeGreaterThan(0)
    }, 120_000)

    test('rejects message without sessionId', async () => {
      const res = await agentFetch(env, '/agent/channels/webchat/message', {
        method: 'POST',
        body: JSON.stringify({ message: 'hello' }),
      })

      if (res.status === 503) return

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('sessionId')
    })

    test('rejects message without text', async () => {
      const sessionRes = await agentFetch(env, '/agent/channels/webchat/session', {
        method: 'POST',
      })
      if (sessionRes.status === 503) return

      const { sessionId } = await sessionRes.json()

      const res = await agentFetch(env, '/agent/channels/webchat/message', {
        method: 'POST',
        body: JSON.stringify({ sessionId }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('message')
    })
  })

  describe('SSE streaming', () => {
    test('connects to event stream and receives connected event', async () => {
      const sessionRes = await agentFetch(env, '/agent/channels/webchat/session', {
        method: 'POST',
      })
      if (sessionRes.status === 503) {
        console.warn('WebChat not connected, skipping SSE test')
        return
      }

      const { sessionId } = await sessionRes.json()

      const events = await collectSSEEvents(
        env,
        `/agent/channels/webchat/events/${sessionId}`,
        {
          timeoutMs: 5_000,
          done: (evts) => evts.some(e => e.event === 'connected'),
        },
      )

      const connectedEvent = events.find(e => e.event === 'connected')
      expect(connectedEvent).toBeDefined()
      expect(connectedEvent!.data.sessionId).toBe(sessionId)
      expect(connectedEvent!.data.timestamp).toBeDefined()
    })

    test('receives welcome message if configured', async () => {
      const configRes = await agentFetch(env, '/agent/channels/webchat/config')
      if (!configRes.ok) return
      const config = await configRes.json()

      if (!config.welcomeMessage) {
        console.log('No welcome message configured, skipping')
        return
      }

      const sessionRes = await agentFetch(env, '/agent/channels/webchat/session', {
        method: 'POST',
      })
      const { sessionId } = await sessionRes.json()

      const events = await collectSSEEvents(
        env,
        `/agent/channels/webchat/events/${sessionId}`,
        {
          timeoutMs: 5_000,
          done: (evts) => evts.some(e => e.event === 'message' && e.data?.isWelcome),
        },
      )

      const welcome = events.find(e => e.event === 'message' && e.data?.isWelcome)
      expect(welcome).toBeDefined()
      expect(welcome!.data.content).toBe(config.welcomeMessage)
    })
  })

  describe('widget script', () => {
    test('serves the embeddable widget.js', async () => {
      const res = await agentFetch(env, '/agent/channels/webchat/widget.js')
      expect(res.ok).toBe(true)

      const contentType = res.headers.get('content-type')
      expect(contentType).toContain('javascript')

      const script = await res.text()
      expect(script).toContain('__shogoWebChat')
      expect(script).toContain('EventSource')
      expect(script.length).toBeGreaterThan(500)
    })
  })
})
