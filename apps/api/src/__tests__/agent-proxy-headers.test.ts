// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the agent-proxy forward-header allow-list.
 *
 * The helper is consumed by `app.all('/api/projects/:projectId/agent-proxy/*')`
 * in `apps/api/src/server.ts` on *both* the cloud-pod fetch branch
 * and the tunnel relay branch. The allow-list is the single audit
 * surface for "what does the cloud relay forward to the inner
 * agent-runtime", so it has its own test suite.
 *
 * Regression target: prior to the extraction of this helper, the cloud
 * relay's inline header construction silently dropped `x-webhook-secret`,
 * meaning every externally-configured webhook channel secret failed
 * closed at the cloud — `WebhookAdapter.verifyAuth` saw an empty
 * secret header and rejected. Callers could only get through by
 * setting `config.secret = ""` on the pod, which bypasses the check
 * entirely. The tests below pin down the corrected contract so that
 * regression cannot recur silently.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildAgentProxyForwardHeaders,
  isAgentProxyWebchatPath,
  isAgentProxyWebhookPath,
} from '../lib/agent-proxy-headers'

/**
 * Tiny in-memory `readHeader` factory used by every test. Mirrors the
 * shape of Hono's `c.req.header()` (case-insensitive, returns `undefined`
 * for missing headers).
 */
function makeReader(headers: Record<string, string>): (name: string) => string | undefined {
  const lower = new Map<string, string>()
  for (const [k, v] of Object.entries(headers)) lower.set(k.toLowerCase(), v)
  return (name: string) => lower.get(name.toLowerCase())
}

const RUNTIME_TOKEN = 'rt_v1_proj-test_deadbeef'

describe('isAgentProxyWebchatPath', () => {
  test('matches the five static widget endpoints', () => {
    expect(isAgentProxyWebchatPath('/agent/channels/webchat/widget.js')).toBe(true)
    expect(isAgentProxyWebchatPath('/agent/channels/webchat/health')).toBe(true)
    expect(isAgentProxyWebchatPath('/agent/channels/webchat/config')).toBe(true)
    expect(isAgentProxyWebchatPath('/agent/channels/webchat/session')).toBe(true)
    expect(isAgentProxyWebchatPath('/agent/channels/webchat/message')).toBe(true)
  })

  test('matches dynamic event-stream sub-paths', () => {
    expect(isAgentProxyWebchatPath('/agent/channels/webchat/events/abc-123')).toBe(true)
    expect(isAgentProxyWebchatPath('/agent/channels/webchat/events/')).toBe(true)
  })

  test('does NOT match unrelated agent paths (no widening of unauth bypass)', () => {
    expect(isAgentProxyWebchatPath('/agent/chat')).toBe(false)
    expect(isAgentProxyWebchatPath('/agent/channels/webhook/incoming')).toBe(false)
    expect(isAgentProxyWebchatPath('/agent/channels/webchat')).toBe(false)
    expect(isAgentProxyWebchatPath('/agent/channels/webchat-other/widget.js')).toBe(false)
  })
})

describe('isAgentProxyWebhookPath', () => {
  test('matches every documented webhook sub-route', () => {
    // Mirrors the routes registered by WebhookAdapter.registerRoutes.
    expect(isAgentProxyWebhookPath('/agent/channels/webhook/incoming')).toBe(true)
    expect(isAgentProxyWebhookPath('/agent/channels/webhook/outbox/some-channel-id')).toBe(true)
    expect(isAgentProxyWebhookPath('/agent/channels/webhook/health')).toBe(true)
    expect(isAgentProxyWebhookPath('/agent/channels/webhook/activity')).toBe(true)
    expect(isAgentProxyWebhookPath('/agent/channels/webhook/test')).toBe(true)
  })

  test('does NOT match unrelated paths or paths that just contain "webhook"', () => {
    expect(isAgentProxyWebhookPath('/agent/chat')).toBe(false)
    expect(isAgentProxyWebhookPath('/agent/channels/webchat/widget.js')).toBe(false)
    expect(isAgentProxyWebhookPath('/agent/channels/webhook')).toBe(false)
    expect(isAgentProxyWebhookPath('/agent/channels/webhooks/incoming')).toBe(false)
    expect(isAgentProxyWebhookPath('/agent/hooks/wake')).toBe(false)
  })
})

describe('buildAgentProxyForwardHeaders — invariants on every request', () => {
  test('always sets x-runtime-token, regardless of path or other headers', () => {
    const headers = buildAgentProxyForwardHeaders({
      readHeader: makeReader({}),
      runtimeToken: RUNTIME_TOKEN,
      cleanPath: '/agent/health',
    })
    expect(headers['x-runtime-token']).toBe(RUNTIME_TOKEN)
  })

  test('forwards content-type and accept when the caller set them', () => {
    const headers = buildAgentProxyForwardHeaders({
      readHeader: makeReader({
        'content-type': 'application/json',
        accept: 'text/event-stream',
      }),
      runtimeToken: RUNTIME_TOKEN,
      cleanPath: '/agent/chat',
    })
    expect(headers['content-type']).toBe('application/json')
    expect(headers['accept']).toBe('text/event-stream')
  })

  test('omits content-type / accept when the caller did not send them (no empty-string defaults)', () => {
    const headers = buildAgentProxyForwardHeaders({
      readHeader: makeReader({}),
      runtimeToken: RUNTIME_TOKEN,
      cleanPath: '/agent/chat',
    })
    expect('content-type' in headers).toBe(false)
    expect('accept' in headers).toBe(false)
  })
})

describe('buildAgentProxyForwardHeaders — dropped headers (security contract)', () => {
  // These headers are part of the caller's auth handshake with the
  // cloud, not the inner runtime, and must NOT cross the trust
  // boundary. A new entry in the allow-list should require a parallel
  // test addition here.
  const SENSITIVE_HEADERS = [
    'authorization',
    'cookie',
    'x-forwarded-for',
    'x-forwarded-host',
    'host',
    'x-billing-user-id', // caller cannot self-attribute billing
  ] as const

  test.each(SENSITIVE_HEADERS)('drops %s on /agent/chat (cloud-auth-required path)', (header) => {
    const headers = buildAgentProxyForwardHeaders({
      readHeader: makeReader({ [header]: 'attacker-supplied' }),
      runtimeToken: RUNTIME_TOKEN,
      cleanPath: '/agent/chat',
    })
    expect(header in headers).toBe(false)
  })

  test.each(SENSITIVE_HEADERS)('drops %s on /agent/channels/webhook/incoming', (header) => {
    const headers = buildAgentProxyForwardHeaders({
      readHeader: makeReader({ [header]: 'attacker-supplied' }),
      runtimeToken: RUNTIME_TOKEN,
      cleanPath: '/agent/channels/webhook/incoming',
    })
    expect(header in headers).toBe(false)
  })

  test('caller cannot inject their own x-runtime-token (cloud value always wins)', () => {
    const headers = buildAgentProxyForwardHeaders({
      readHeader: makeReader({ 'x-runtime-token': 'rt_v1_attacker_forged' }),
      runtimeToken: RUNTIME_TOKEN,
      cleanPath: '/agent/chat',
    })
    expect(headers['x-runtime-token']).toBe(RUNTIME_TOKEN)
  })
})

describe('buildAgentProxyForwardHeaders — webhook path passthrough (the regression guard)', () => {
  test('forwards x-webhook-secret on /agent/channels/webhook/incoming', () => {
    const headers = buildAgentProxyForwardHeaders({
      readHeader: makeReader({ 'x-webhook-secret': 'super-secret-from-jira' }),
      runtimeToken: RUNTIME_TOKEN,
      cleanPath: '/agent/channels/webhook/incoming',
    })
    expect(headers['x-webhook-secret']).toBe('super-secret-from-jira')
  })

  test('forwards x-webhook-secret on every webhook sub-route', () => {
    const subroutes = [
      '/agent/channels/webhook/incoming',
      '/agent/channels/webhook/test',
      '/agent/channels/webhook/outbox/some-id',
      '/agent/channels/webhook/health',
      '/agent/channels/webhook/activity',
    ]
    for (const path of subroutes) {
      const headers = buildAgentProxyForwardHeaders({
        readHeader: makeReader({ 'x-webhook-secret': 'shh' }),
        runtimeToken: RUNTIME_TOKEN,
        cleanPath: path,
      })
      expect(headers['x-webhook-secret']).toBe('shh')
    }
  })

  test('does NOT forward x-webhook-secret on unrelated agent paths (no leak)', () => {
    // Otherwise a malicious caller could exfiltrate or replay the
    // channel secret against an unrelated runtime endpoint that
    // happens to read the header.
    const unrelatedPaths = [
      '/agent/chat',
      '/agent/health',
      '/agent/channels/webchat/widget.js',
      '/agent/channels/telegram/webhook',
      '/agent/hooks/wake',
    ]
    for (const path of unrelatedPaths) {
      const headers = buildAgentProxyForwardHeaders({
        readHeader: makeReader({ 'x-webhook-secret': 'shh' }),
        runtimeToken: RUNTIME_TOKEN,
        cleanPath: path,
      })
      expect('x-webhook-secret' in headers).toBe(false)
    }
  })

  test('omits x-webhook-secret when the caller did not send one (no empty-string forwarding)', () => {
    // An empty `x-webhook-secret` would degrade verifyAuth to the
    // empty-secret bypass; explicit omission keeps the runtime's
    // behaviour identical to "header missing".
    const headers = buildAgentProxyForwardHeaders({
      readHeader: makeReader({}),
      runtimeToken: RUNTIME_TOKEN,
      cleanPath: '/agent/channels/webhook/incoming',
    })
    expect('x-webhook-secret' in headers).toBe(false)
  })

  test('case-insensitive header lookup (caller may send X-Webhook-Secret with any casing)', () => {
    const headers = buildAgentProxyForwardHeaders({
      readHeader: makeReader({ 'X-WEBHOOK-SECRET': 'mixed-case-secret' }),
      runtimeToken: RUNTIME_TOKEN,
      cleanPath: '/agent/channels/webhook/incoming',
    })
    expect(headers['x-webhook-secret']).toBe('mixed-case-secret')
  })
})

describe('buildAgentProxyForwardHeaders — webchat path passthrough', () => {
  test('forwards origin + x-webchat-* on webchat paths', () => {
    const headers = buildAgentProxyForwardHeaders({
      readHeader: makeReader({
        origin: 'https://customer.example.com',
        'x-webchat-widget-key': 'pk_widget_abc',
        'x-webchat-session-token': 'sess_xyz',
        'x-webchat-session': 'sess_legacy',
      }),
      runtimeToken: RUNTIME_TOKEN,
      cleanPath: '/agent/channels/webchat/message',
    })
    expect(headers['origin']).toBe('https://customer.example.com')
    expect(headers['x-webchat-widget-key']).toBe('pk_widget_abc')
    expect(headers['x-webchat-session-token']).toBe('sess_xyz')
    expect(headers['x-webchat-session']).toBe('sess_legacy')
  })

  test('does NOT forward webchat headers on non-webchat paths', () => {
    const headers = buildAgentProxyForwardHeaders({
      readHeader: makeReader({
        origin: 'https://customer.example.com',
        'x-webchat-widget-key': 'pk_widget_abc',
      }),
      runtimeToken: RUNTIME_TOKEN,
      cleanPath: '/agent/chat',
    })
    expect('origin' in headers).toBe(false)
    expect('x-webchat-widget-key' in headers).toBe(false)
  })
})

describe('buildAgentProxyForwardHeaders — billing attribution', () => {
  test('sets x-billing-user-id on chat-stream turns with an authed user', () => {
    const headers = buildAgentProxyForwardHeaders({
      readHeader: makeReader({}),
      runtimeToken: RUNTIME_TOKEN,
      cleanPath: '/agent/chat',
      isChatStream: true,
      billingUserId: 'user-42',
    })
    expect(headers['x-billing-user-id']).toBe('user-42')
  })

  test('omits x-billing-user-id when isChatStream is false (non-chat traffic)', () => {
    const headers = buildAgentProxyForwardHeaders({
      readHeader: makeReader({}),
      runtimeToken: RUNTIME_TOKEN,
      cleanPath: '/agent/channels/webhook/incoming',
      isChatStream: false,
      billingUserId: 'user-42',
    })
    expect('x-billing-user-id' in headers).toBe(false)
  })

  test('omits x-billing-user-id when billingUserId is missing (unauth chat — should never happen, but fails safe)', () => {
    const headers = buildAgentProxyForwardHeaders({
      readHeader: makeReader({}),
      runtimeToken: RUNTIME_TOKEN,
      cleanPath: '/agent/chat',
      isChatStream: true,
      billingUserId: null,
    })
    expect('x-billing-user-id' in headers).toBe(false)
  })
})
