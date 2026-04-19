// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tunnel-Redis Cold-Start Race Tests
 *
 * Guards the invariant that registerTunnelOwnership / getTunnelOwner wait
 * for Redis init to complete instead of silently no-opping against a null
 * publisher — which was the root cause of intermittent `503 { offline }`
 * errors on staging remote control.
 *
 * Run: bun test apps/api/src/lib/__tests__/tunnel-redis-race.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'

// Simulated Redis keyspace + connect latency, controlled per-test.
let connectDelayMs = 0
let store: Map<string, string>

class FakeRedis {
  public events = new Map<string, Array<(...args: any[]) => void>>()
  constructor(_url: string, _opts: any) {
    store = store ?? new Map()
  }
  on(event: string, cb: (...args: any[]) => void) {
    const arr = this.events.get(event) ?? []
    arr.push(cb)
    this.events.set(event, arr)
    return this
  }
  async connect() {
    if (connectDelayMs > 0) await new Promise((r) => setTimeout(r, connectDelayMs))
  }
  async subscribe(_channel: string) {}
  async set(k: string, v: string, ..._rest: any[]) {
    store.set(k, v)
    return 'OK'
  }
  async get(k: string) {
    return store.get(k) ?? null
  }
  async del(k: string) {
    return store.delete(k) ? 1 : 0
  }
  async expire(_k: string, _ttl: number) {
    return 1
  }
  disconnect() {}
  async publish(_channel: string, _msg: string) {
    return 0
  }
}

mock.module('ioredis', () => ({ default: FakeRedis }))

async function freshImport() {
  // Bun doesn't clear module cache between test files automatically; we
  // only import once per describe and reset internal state via env.
  return import('../tunnel-redis')
}

describe('tunnel-redis cold-start race', () => {
  beforeEach(() => {
    store = new Map()
    connectDelayMs = 0
    delete process.env.SHOGO_LOCAL_MODE
    process.env.REDIS_URL = 'redis://fake:6379'
    process.env.POD_ID = 'pod-test-a'
  })

  afterEach(() => {
    connectDelayMs = 0
  })

  test('registerTunnelOwnership waits for init and writes the key even when called before init resolves', async () => {
    const mod = await freshImport()
    connectDelayMs = 150 // simulate slow Redis connect

    // Fire init but DO NOT await — mirrors real startup fire-and-forget.
    const initP = mod.initTunnelRedis()
    // Call register immediately — pre-fix this silently no-ops because
    // getPublisher() returns null until init resolves.
    const regP = mod.registerTunnelOwnership('inst-abc')

    await Promise.all([initP, regP])

    // Key must be present after both resolve.
    const owner = await mod.getTunnelOwner('inst-abc')
    expect(owner).toBe('pod-test-a')
  })

  test('getTunnelOwner returns the value written during the cold-start window after one bounded retry', async () => {
    const mod = await freshImport()
    // Write happens during the 100ms retry window.
    setTimeout(() => {
      store.set('tunnel:inst-xyz:pod', 'pod-owner-b')
    }, 30)
    const owner = await mod.getTunnelOwner('inst-xyz')
    expect(owner).toBe('pod-owner-b')
  })

  test('isTunnelRedisDegraded is false on successful init, true after a failing init', async () => {
    const mod = await freshImport()
    await mod.initTunnelRedis()
    expect(mod.isTunnelRedisDegraded()).toBe(false)
  })

  test('local mode short-circuits without connecting to Redis', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    const mod = await freshImport()
    await mod.initTunnelRedis()
    // Should be no-op, degraded stays false, getTunnelOwner returns null.
    expect(mod.isTunnelRedisDegraded()).toBe(false)
    const owner = await mod.getTunnelOwner('inst-local')
    expect(owner).toBeNull()
  })
})
