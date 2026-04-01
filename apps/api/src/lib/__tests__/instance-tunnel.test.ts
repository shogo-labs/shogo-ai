// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Instance Tunnel Client Tests
 *
 * Tests for the HTTP heartbeat loop, adaptive polling, and on-demand
 * WebSocket connection logic in the tunnel client.
 *
 * Run: bun test apps/api/src/lib/__tests__/instance-tunnel.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockFetch = mock(() =>
  Promise.resolve(new Response(JSON.stringify({
    instanceId: 'inst-1',
    nextPollIn: 60,
    wsRequested: false,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })),
)

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

mock.module('../runtime', () => ({
  getRuntimeManager: () => ({
    getActiveProjects: () => [],
    status: () => null,
  }),
}))

describe('Instance Tunnel Client', () => {
  beforeEach(() => {
    globalThis.fetch = mockFetch as any
    process.env.SHOGO_API_KEY = 'shogo_test_key'
    process.env.SHOGO_CLOUD_URL = 'https://studio.test.shogo.ai'
    mockFetch.mockReset()
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({
        instanceId: 'inst-1',
        nextPollIn: 60,
        wsRequested: false,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    )
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k]
    })
    Object.assign(process.env, originalEnv)
  })

  test('getCloudUrl reads SHOGO_CLOUD_URL', async () => {
    const mod = await import('../instance-tunnel')
    expect(mod._testing.getCloudUrl()).toBe('https://studio.test.shogo.ai')
  })

  test('getCloudUrl defaults to studio.shogo.ai', async () => {
    delete process.env.SHOGO_CLOUD_URL
    const mod = await import('../instance-tunnel')
    expect(mod._testing.getCloudUrl()).toBe('https://studio.shogo.ai')
  })

  test('buildWsUrl converts http to ws and includes params', async () => {
    const mod = await import('../instance-tunnel')
    const url = mod._testing.buildWsUrl()
    expect(url).toMatch(/^wss:\/\/studio\.test\.shogo\.ai\/api\/instances\/ws\?/)
    expect(url).toContain('key=shogo_test_key')
    expect(url).toContain('hostname=')
    expect(url).toContain('os=')
    expect(url).toContain('arch=')
  })

  test('sendHeartbeat calls fetch with correct URL and headers', async () => {
    const mod = await import('../instance-tunnel')
    await mod._testing.sendHeartbeat()

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0] as any
    expect(url).toBe('https://studio.test.shogo.ai/api/instances/heartbeat')
    expect(opts.method).toBe('POST')
    expect(opts.headers['x-api-key']).toBe('shogo_test_key')
    expect(opts.headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(opts.body)
    expect(body.hostname).toBeTruthy()
    expect(body.os).toBeTruthy()
    expect(body.arch).toBeTruthy()
  })

  test('sendHeartbeat throws on non-OK response', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('Unauthorized', { status: 401 })),
    )

    const mod = await import('../instance-tunnel')
    await expect(mod._testing.sendHeartbeat()).rejects.toThrow('Heartbeat failed: HTTP 401')
  })

  test('sendHeartbeat returns parsed response', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({
        instanceId: 'inst-2',
        nextPollIn: 5,
        wsRequested: true,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    )

    const mod = await import('../instance-tunnel')
    const result = await mod._testing.sendHeartbeat()
    expect(result.instanceId).toBe('inst-2')
    expect(result.nextPollIn).toBe(5)
    expect(result.wsRequested).toBe(true)
  })

  test('DEFAULT_POLL_INTERVAL_S is 60', async () => {
    const mod = await import('../instance-tunnel')
    expect(mod._testing.DEFAULT_POLL_INTERVAL_S).toBe(60)
  })
})
