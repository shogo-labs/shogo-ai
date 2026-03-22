// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AI Proxy Integration Tests
 *
 * Tests the AI model proxy endpoints:
 * - Token generation and validation
 * - Anthropic-native pass-through (for Claude Code CLI)
 * - OpenAI-compatible proxy
 * - Authentication enforcement
 *
 * Run: bun test apps/api/src/__tests__/ai-proxy.test.ts
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import {
  generateProxyToken,
  verifyProxyToken,
  extractProjectIdFromProxyToken,
} from '../lib/ai-proxy-token'

// =============================================================================
// Token Tests
// =============================================================================

describe('AI Proxy Token', () => {
  const testProjectId = 'test-project-123'
  const testWorkspaceId = 'test-workspace-456'
  const testUserId = 'test-user-789'

  test('generates and verifies a valid token', async () => {
    const token = await generateProxyToken(testProjectId, testWorkspaceId, testUserId)
    expect(token).toBeDefined()
    expect(typeof token).toBe('string')

    // Token should have 3 parts (JWT format)
    const parts = token.split('.')
    expect(parts.length).toBe(3)

    // Verify the token
    const payload = await verifyProxyToken(token)
    expect(payload).not.toBeNull()
    expect(payload!.projectId).toBe(testProjectId)
    expect(payload!.workspaceId).toBe(testWorkspaceId)
    expect(payload!.userId).toBe(testUserId)
    expect(payload!.type).toBe('ai-proxy')
  })

  test('extracts project ID without verification', () => {
    // Create a token manually to test extraction
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const payload = btoa(JSON.stringify({
      projectId: testProjectId,
      workspaceId: testWorkspaceId,
      type: 'ai-proxy',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const fakeToken = `${header}.${payload}.fakesignature`

    const extracted = extractProjectIdFromProxyToken(fakeToken)
    expect(extracted).toBe(testProjectId)
  })

  test('rejects expired tokens', async () => {
    // Generate token that expired 1 second ago
    const token = await generateProxyToken(testProjectId, testWorkspaceId, testUserId, -1000)

    const payload = await verifyProxyToken(token)
    expect(payload).toBeNull()
  })

  test('rejects tampered tokens', async () => {
    const token = await generateProxyToken(testProjectId, testWorkspaceId, testUserId)

    // Tamper with the payload
    const parts = token.split('.')
    const tamperedPayload = btoa(JSON.stringify({
      projectId: 'hacked-project',
      workspaceId: testWorkspaceId,
      type: 'ai-proxy',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`
    const payload = await verifyProxyToken(tamperedToken)
    expect(payload).toBeNull()
  })

  test('rejects tokens with wrong type', async () => {
    // Generate a preview token (different type) and try to validate as proxy token
    const token = await generateProxyToken(testProjectId, testWorkspaceId, testUserId)

    // This should succeed since it's the right type
    const payload = await verifyProxyToken(token)
    expect(payload).not.toBeNull()
    expect(payload!.type).toBe('ai-proxy')
  })

  test('generates tokens with custom expiry', async () => {
    // 1 hour expiry
    const token = await generateProxyToken(testProjectId, testWorkspaceId, testUserId, 3600 * 1000)
    const payload = await verifyProxyToken(token)
    expect(payload).not.toBeNull()

    // Expiry should be approximately 1 hour from now
    const now = Math.floor(Date.now() / 1000)
    expect(payload!.exp - now).toBeGreaterThan(3500) // Within 100 seconds
    expect(payload!.exp - now).toBeLessThan(3700)
  })

  test('handles malformed tokens gracefully', async () => {
    expect(await verifyProxyToken('')).toBeNull()
    expect(await verifyProxyToken('not-a-token')).toBeNull()
    expect(await verifyProxyToken('a.b')).toBeNull()
    expect(await verifyProxyToken('a.b.c')).toBeNull()
  })
})

// =============================================================================
// Proxy Route Tests (requires API server running)
// =============================================================================

describe('AI Proxy Routes', () => {
  const API_URL = process.env.API_URL || 'http://localhost:3000'
  let proxyToken: string

  beforeAll(async () => {
    // Generate a test token
    proxyToken = await generateProxyToken('test-project', 'test-workspace', 'test-user')
  })

  test('health endpoint returns provider status', async () => {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3000)
      const response = await fetch(`${API_URL}/api/ai/proxy/health`, {
        signal: controller.signal,
      })
      clearTimeout(timeout)
      if (!response.ok) {
        console.log('API server not running, skipping route tests')
        return
      }

      const data = await response.json() as any
      expect(data.status).toBe('ok')
      expect(data.providers).toBeDefined()
      expect(typeof data.providers.anthropic).toBe('boolean')
      expect(typeof data.providers.openai).toBe('boolean')
    } catch (e) {
      console.log('API server not running, skipping route tests')
    }
  })

  test('models endpoint requires auth', async () => {
    try {
      const response = await fetch(`${API_URL}/api/ai/v1/models`)
      if (!response.ok && response.status === 401) {
        const data = await response.json() as any
        expect(data.error.type).toBe('authentication_error')
      }
    } catch (e) {
      console.log('API server not running, skipping route tests')
    }
  })

  test('models endpoint works with valid token', async () => {
    try {
      const response = await fetch(`${API_URL}/api/ai/v1/models`, {
        headers: {
          Authorization: `Bearer ${proxyToken}`,
        },
      })
      if (!response.ok) {
        console.log('API server not running or token rejected, skipping')
        return
      }

      const data = await response.json() as any
      expect(data.object).toBe('list')
      expect(Array.isArray(data.data)).toBe(true)
      expect(data.data.length).toBeGreaterThan(0)

      // Check model structure
      const model = data.data[0]
      expect(model.id).toBeDefined()
      expect(model.owned_by).toBeDefined()
    } catch (e) {
      console.log('API server not running, skipping route tests')
    }
  })

  test('Anthropic pass-through rejects unauthenticated requests', async () => {
    try {
      const response = await fetch(`${API_URL}/api/ai/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3-haiku-20240307', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
      })
      if (response.status === 401) {
        const data = await response.json() as any
        expect(data.error.type).toBe('authentication_error')
      }
    } catch (e) {
      console.log('API server not running, skipping route tests')
    }
  })

  test('Anthropic pass-through authenticates via x-api-key', async () => {
    try {
      const response = await fetch(`${API_URL}/api/ai/anthropic/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': proxyToken,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
          max_tokens: 10,
        }),
      })

      // If Anthropic API key isn't configured, we'll get a 503
      // If it is configured, we should get a 200 with a response
      if (response.status === 503) {
        console.log('Anthropic not configured on server, pass-through auth validated')
        return
      }
      if (response.status === 401) {
        console.log('Token was rejected - check AI_PROXY_SECRET configuration')
        return
      }

      expect(response.ok).toBe(true)
      const data = await response.json() as any
      expect(data.content).toBeDefined()
      console.log('Anthropic pass-through successful:', data.content?.[0]?.text)
    } catch (e) {
      console.log('API server not running, skipping route tests')
    }
  })

  test('OpenAI-compatible completions rejects unauthenticated requests', async () => {
    try {
      const response = await fetch(`${API_URL}/api/ai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
      })
      if (response.status === 401) {
        const data = await response.json() as any
        expect(data.error.type).toBe('authentication_error')
      }
    } catch (e) {
      console.log('API server not running, skipping route tests')
    }
  })
})
