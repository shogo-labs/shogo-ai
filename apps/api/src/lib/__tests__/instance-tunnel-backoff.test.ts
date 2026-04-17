// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tunnel Client — Exponential Backoff & Version Tests
 *
 * Run: bun test apps/api/src/lib/__tests__/instance-tunnel-backoff.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'

const originalEnv = { ...process.env }

mock.module('../runtime', () => ({
  getRuntimeManager: () => ({
    getActiveProjects: () => [],
    status: () => null,
  }),
}))

describe('Exponential Backoff', () => {
  beforeEach(() => {
    process.env.SHOGO_API_KEY = 'shogo_test_key'
    process.env.SHOGO_CLOUD_URL = 'https://studio.test.shogo.ai'
  })

  afterEach(() => {
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k]
    })
    Object.assign(process.env, originalEnv)
  })

  test('reconnect delay starts at ~1s (base)', async () => {
    const mod = await import('../instance-tunnel')
    mod._testing.wsReconnectAttempt = 0
    const delay = mod._testing.getReconnectDelay()
    expect(delay).toBeGreaterThanOrEqual(mod._testing.BACKOFF_BASE_MS)
    expect(delay).toBeLessThanOrEqual(mod._testing.BACKOFF_BASE_MS * 1.3)
  })

  test('reconnect delay doubles with each attempt', async () => {
    const mod = await import('../instance-tunnel')
    const delays: number[] = []
    for (let i = 0; i < 6; i++) {
      mod._testing.wsReconnectAttempt = i
      delays.push(mod._testing.getReconnectDelay())
    }
    // Each should be roughly 2x the previous (with jitter)
    for (let i = 1; i < delays.length; i++) {
      const ratio = delays[i] / delays[i - 1]
      expect(ratio).toBeGreaterThan(1.2)
      expect(ratio).toBeLessThan(3.0)
    }
  })

  test('reconnect delay caps at BACKOFF_MAX_MS', async () => {
    const mod = await import('../instance-tunnel')
    mod._testing.wsReconnectAttempt = 100
    const delay = mod._testing.getReconnectDelay()
    expect(delay).toBeLessThanOrEqual(mod._testing.BACKOFF_MAX_MS * 1.3)
  })

  test('TUNNEL_PROTOCOL_VERSION is exported and >= 2', async () => {
    const mod = await import('../instance-tunnel')
    expect(mod._testing.TUNNEL_PROTOCOL_VERSION).toBeGreaterThanOrEqual(2)
  })
})
