// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AI Proxy Route Handler Tests (unit-level, no server needed)
 *
 * Tests the proxy route handlers using Hono's built-in test utilities.
 * These tests validate the request handling logic without making real API calls.
 *
 * Run: bun test apps/api/src/__tests__/ai-proxy-routes.test.ts
 */

import { describe, test, expect, beforeAll, mock } from 'bun:test'
import { Hono } from 'hono'
import { generateProxyToken } from '../lib/ai-proxy-token'
import { aiProxyRoutes } from '../routes/ai-proxy'

// Mock prisma to avoid database dependency
mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'test-project', name: 'Test' }),
      findUnique: async () => ({ id: 'test-project', workspaceId: 'test-workspace' }),
    },
    usageEvent: {
      create: async () => ({}),
    },
    creditLedger: {
      findUnique: async () => ({
        workspaceId: 'test-workspace',
        dailyCredits: 5,
        monthlyCredits: 100,
        lastDailyReset: new Date(),
      }),
      create: async (data: any) => data,
    },
  },
}))

describe('AI Proxy Route Handlers', () => {
  let app: Hono
  let validToken: string

  beforeAll(async () => {
    app = new Hono()
    const proxyRouter = aiProxyRoutes()
    app.route('/api', proxyRouter)

    // Generate a valid test token
    validToken = await generateProxyToken('test-project', 'test-workspace', 'test-user')
  })

  // ===========================================================================
  // Health Check
  // ===========================================================================

  test('GET /api/ai/proxy/health returns status', async () => {
    const req = new Request('http://localhost/api/ai/proxy/health')
    const res = await app.fetch(req)
    expect(res.status).toBe(200)

    const data = await res.json() as any
    expect(data.status).toBe('ok')
    expect(data.providers).toBeDefined()
    expect(data.modelCount).toBeGreaterThan(0)
  })

  // ===========================================================================
  // Models
  // ===========================================================================

  test('GET /api/ai/v1/models rejects without auth', async () => {
    const req = new Request('http://localhost/api/ai/v1/models')
    const res = await app.fetch(req)
    expect(res.status).toBe(401)

    const data = await res.json() as any
    expect(data.error.type).toBe('authentication_error')
  })

  test('GET /api/ai/v1/models returns models with valid token', async () => {
    const req = new Request('http://localhost/api/ai/v1/models', {
      headers: { Authorization: `Bearer ${validToken}` },
    })
    const res = await app.fetch(req)
    expect(res.status).toBe(200)

    const data = await res.json() as any
    expect(data.object).toBe('list')
    expect(Array.isArray(data.data)).toBe(true)
    expect(data.data.length).toBeGreaterThan(0)

    // Check that models have correct structure
    const firstModel = data.data[0]
    expect(firstModel.id).toBeDefined()
    expect(firstModel.object).toBe('model')
    expect(firstModel.owned_by).toBeDefined()
    expect(typeof firstModel.available).toBe('boolean')
  })

  // ===========================================================================
  // OpenAI-compatible Completions
  // ===========================================================================

  test('POST /api/ai/v1/chat/completions rejects without auth', async () => {
    const req = new Request('http://localhost/api/ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    const res = await app.fetch(req)
    expect(res.status).toBe(401)
  })

  test('POST /api/ai/v1/chat/completions rejects unknown model', async () => {
    const req = new Request('http://localhost/api/ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${validToken}`,
      },
      body: JSON.stringify({
        model: 'unknown-model-xyz',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    const res = await app.fetch(req)
    expect(res.status).toBe(400)

    const data = await res.json() as any
    expect(data.error.code).toBe('model_not_found')
  })

  test('POST /api/ai/v1/chat/completions rejects missing model', async () => {
    const req = new Request('http://localhost/api/ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${validToken}`,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    const res = await app.fetch(req)
    expect(res.status).toBe(400)

    const data = await res.json() as any
    expect(data.error.code).toBe('model_required')
  })

  // ===========================================================================
  // Anthropic Native Pass-Through
  // ===========================================================================

  test('POST /api/ai/anthropic/v1/messages rejects without x-api-key', async () => {
    const req = new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
      }),
    })
    const res = await app.fetch(req)
    expect(res.status).toBe(401)

    const data = await res.json() as any
    expect(data.error.type).toBe('authentication_error')
  })

  test('POST /api/ai/anthropic/v1/messages rejects invalid token', async () => {
    const req = new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'not-a-valid-token',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
      }),
    })
    const res = await app.fetch(req)
    expect(res.status).toBe(401)
  })

  test('POST /api/ai/anthropic/v1/messages accepts valid proxy token as x-api-key', async () => {
    // This test validates the auth flow but won't succeed with real Anthropic
    // unless ANTHROPIC_API_KEY is set. We test the auth validation path.
    const req = new Request('http://localhost/api/ai/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': validToken,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
      }),
    })
    const res = await app.fetch(req)

    // Should be 503 (Anthropic not configured) rather than 401 (auth failed)
    // This proves the token was accepted and validated successfully
    if (!process.env.ANTHROPIC_API_KEY) {
      expect(res.status).toBe(503)
      const data = await res.json() as any
      expect(data.error.type).toBe('api_error')
      expect(data.error.message).toContain('not configured')
    } else {
      // If Anthropic key is configured, we should get a real response
      expect(res.status).toBe(200)
    }
  })

  // ===========================================================================
  // Anthropic Token Counting Pass-Through
  // ===========================================================================

  test('POST /api/ai/anthropic/v1/messages/count_tokens rejects without auth', async () => {
    const req = new Request('http://localhost/api/ai/anthropic/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    const res = await app.fetch(req)
    expect(res.status).toBe(401)
  })

  // ===========================================================================
  // Anthropic Models Pass-Through
  // ===========================================================================

  test('GET /api/ai/anthropic/v1/models rejects without auth', async () => {
    const req = new Request('http://localhost/api/ai/anthropic/v1/models')
    const res = await app.fetch(req)
    expect(res.status).toBe(401)
  })

  // ===========================================================================
  // Token Generation
  // ===========================================================================

  test('POST /api/ai/proxy/tokens generates token for valid project', async () => {
    const req = new Request('http://localhost/api/ai/proxy/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'test-project',
        workspaceId: 'test-workspace',
        userId: 'test-user',
      }),
    })
    const res = await app.fetch(req)
    expect(res.status).toBe(200)

    const data = await res.json() as any
    expect(data.token).toBeDefined()
    expect(data.projectId).toBe('test-project')
    expect(data.workspaceId).toBe('test-workspace')
  })

  test('POST /api/ai/proxy/tokens rejects missing fields', async () => {
    const req = new Request('http://localhost/api/ai/proxy/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'test-project' }),
    })
    const res = await app.fetch(req)
    expect(res.status).toBe(400)
  })
})
