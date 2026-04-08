// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { Hono } from 'hono'

const originalEnv = { ...process.env }

// ---------------------------------------------------------------------------
// Mock fetch — simulates the API server's /api/internal/validate-preview-token
// ---------------------------------------------------------------------------
let fetchResponses: Array<{ ok: boolean; status?: number; body: any }> = []
let fetchCalls: Array<{ url: string; options: any }> = []

const mockFetch = mock((url: string, options?: any) => {
  fetchCalls.push({ url, options })
  const response = fetchResponses.shift()
  if (!response) {
    return Promise.reject(new Error('No mock response configured'))
  }
  return Promise.resolve({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: () => Promise.resolve(response.body),
  })
})

global.fetch = mockFetch as any

// ---------------------------------------------------------------------------
// Test: validate-preview-token endpoint (API server side)
// ---------------------------------------------------------------------------
describe('Internal validate-preview-token endpoint', () => {
  // We test this by importing the preview-token module from the API and calling
  // verifyPreviewToken directly, since the endpoint is a thin wrapper.
  // The actual endpoint wiring is tested via the full integration below.

  test('verifyPreviewToken rejects malformed tokens', async () => {
    const { verifyPreviewToken } = await import('../../src/preview-token')
    const result = await verifyPreviewToken('not-a-jwt')
    expect(result).toBeNull()
  })

  test('verifyPreviewToken rejects tokens with wrong part count', async () => {
    const { verifyPreviewToken } = await import('../../src/preview-token')
    const result = await verifyPreviewToken('a.b')
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Test: server-framework preview token auth middleware
// ---------------------------------------------------------------------------
describe('Preview token auth in server-framework', () => {
  beforeEach(() => {
    fetchCalls = []
    fetchResponses = []
    mockFetch.mockClear()
    process.env = { ...originalEnv }
    process.env.PROJECT_ID = 'test-project-123'
    process.env.RUNTIME_AUTH_SECRET = 'test-runtime-secret'
    process.env.SHOGO_API_URL = 'http://api.test.local'
    delete process.env.WARM_POOL_MODE
    delete process.env.NODE_ENV
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  async function buildApp() {
    // Dynamic import to pick up fresh env for each test
    // We need to clear the module cache to ensure createRuntimeApp picks up new env
    const mod = await import('../../src/server-framework')
    const { app, state } = await mod.createRuntimeApp({
      name: 'test-runtime',
      workDir: '/tmp/test-workspace',
      runtimeType: 'unified',
      authPrefixes: ['/agent', '/pool'],
      async onAssign() {},
    })

    // Add a test route behind auth
    app.get('/agent/test', (c) => c.json({ ok: true }))

    return { app, state }
  }

  test('allows requests with valid runtime token header', async () => {
    const { app } = await buildApp()
    const res = await app.request('/agent/test', {
      headers: { 'x-runtime-token': 'test-runtime-secret' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  test('allows requests with valid Authorization Bearer', async () => {
    const { app } = await buildApp()
    const res = await app.request('/agent/test', {
      headers: { Authorization: 'Bearer test-runtime-secret' },
    })
    expect(res.status).toBe(200)
  })

  test('rejects requests with no auth at all', async () => {
    fetchResponses = [] // no mock needed — no preview token in URL
    const { app } = await buildApp()
    const res = await app.request('/agent/test')
    expect(res.status).toBe(401)
  })

  test('validates preview token via API callback and allows if projectId matches', async () => {
    fetchResponses = [
      { ok: true, body: { valid: true, projectId: 'test-project-123', exp: Math.floor(Date.now() / 1000) + 3600 } },
    ]

    const { app } = await buildApp()
    const res = await app.request('/agent/test?__preview_token=valid-jwt-token')
    expect(res.status).toBe(200)

    // Verify the API was called
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0].url).toBe('http://api.test.local/api/internal/validate-preview-token')
    const body = JSON.parse(fetchCalls[0].options.body)
    expect(body.token).toBe('valid-jwt-token')
  })

  test('rejects preview token when projectId does not match', async () => {
    fetchResponses = [
      { ok: true, body: { valid: true, projectId: 'different-project', exp: Math.floor(Date.now() / 1000) + 3600 } },
    ]

    const { app } = await buildApp()
    const res = await app.request('/agent/test?__preview_token=wrong-project-token')
    expect(res.status).toBe(401)
  })

  test('rejects preview token when API says invalid', async () => {
    fetchResponses = [
      { ok: true, body: { valid: false } },
    ]

    const { app } = await buildApp()
    const res = await app.request('/agent/test?__preview_token=expired-token')
    expect(res.status).toBe(401)
  })

  test('rejects preview token when API call fails', async () => {
    fetchResponses = [
      { ok: false, status: 500, body: { error: 'Internal error' } },
    ]

    const { app } = await buildApp()
    const res = await app.request('/agent/test?__preview_token=some-token')
    expect(res.status).toBe(401)
  })

  test('caches valid preview token — second request skips API call', async () => {
    fetchResponses = [
      { ok: true, body: { valid: true, projectId: 'test-project-123', exp: Math.floor(Date.now() / 1000) + 3600 } },
    ]

    const { app } = await buildApp()

    // First request — hits API
    const res1 = await app.request('/agent/test?__preview_token=cached-token')
    expect(res1.status).toBe(200)
    expect(fetchCalls.length).toBe(1)

    // Second request — served from cache, no new API call
    const res2 = await app.request('/agent/test?__preview_token=cached-token')
    expect(res2.status).toBe(200)
    expect(fetchCalls.length).toBe(1) // still 1 — no new call
  })

  test('caches invalid preview token — second request skips API call', async () => {
    fetchResponses = [
      { ok: true, body: { valid: false } },
    ]

    const { app } = await buildApp()

    const res1 = await app.request('/agent/test?__preview_token=bad-token')
    expect(res1.status).toBe(401)
    expect(fetchCalls.length).toBe(1)

    const res2 = await app.request('/agent/test?__preview_token=bad-token')
    expect(res2.status).toBe(401)
    expect(fetchCalls.length).toBe(1) // cached
  })

  test('public channel paths bypass auth entirely', async () => {
    const { app } = await buildApp()

    // Webchat paths are public
    app.get('/agent/channels/webchat/health', (c) => c.json({ ok: true }))
    const res = await app.request('/agent/channels/webchat/health')
    expect(res.status).toBe(200)
  })

  test('runtime secret takes priority over preview token', async () => {
    // Even with a preview token in the URL, runtime secret should be checked first
    const { app } = await buildApp()
    const res = await app.request('/agent/test?__preview_token=some-token', {
      headers: { 'x-runtime-token': 'test-runtime-secret' },
    })
    expect(res.status).toBe(200)
    // No API call should have been made — runtime secret matched first
    expect(fetchCalls.length).toBe(0)
  })

  test('skips API callback when no API URL is derivable', async () => {
    delete process.env.SHOGO_API_URL
    delete process.env.API_URL
    delete process.env.AI_PROXY_URL
    // In test environment, deriveApiUrl falls back to K8s service DNS which is
    // unreachable but still returns a URL. Override SYSTEM_NAMESPACE to something
    // that won't resolve. The fetch will fail and we'll get 401.
    process.env.SYSTEM_NAMESPACE = 'nonexistent'

    // Fetch will throw (no mock configured for this, simulating unreachable API)
    fetchResponses = []
    mockFetch.mockImplementationOnce(() => Promise.reject(new Error('Connection refused')))

    const { app } = await buildApp()
    const res = await app.request('/agent/test?__preview_token=some-token')
    expect(res.status).toBe(401)
  })
})
