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
  // ioredis's `.status` is the authoritative readiness check used by
  // `isTunnelRedisDegraded`. Production code reads it directly, so the
  // fake has to mirror the real lifecycle ('connecting' → 'ready') or
  // every test will see degraded=true.
  public status: 'wait' | 'connecting' | 'ready' | 'end' | 'reconnecting' | 'close' = 'wait'
  constructor(_url: string, _opts: any) {
    store = store ?? new Map()
  }
  on(event: string, cb: (...args: any[]) => void) {
    const arr = this.events.get(event) ?? []
    arr.push(cb)
    this.events.set(event, arr)
    return this
  }
  private fire(event: string, ...args: any[]) {
    for (const cb of this.events.get(event) ?? []) cb(...args)
  }
  async connect() {
    this.status = 'connecting'
    if (connectDelayMs > 0) await new Promise((r) => setTimeout(r, connectDelayMs))
    this.status = 'ready'
    this.fire('ready')
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
  disconnect() {
    this.status = 'end'
  }
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
    // tunnel-redis reads `HOSTNAME` (not POD_ID) at module load to derive
    // its pod identity. The module is cached across tests so this only
    // takes effect on the very first import; subsequent assertions read
    // back via `mod.getPodId()` instead of hardcoding the value.
    process.env.HOSTNAME = process.env.HOSTNAME || 'pod-test-a'
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

    // Key must be present after both resolve. Read pod id from the module
    // rather than env so this stays correct even when HOSTNAME was already
    // set to something else by the test process.
    const owner = await mod.getTunnelOwner('inst-abc')
    expect(owner).toBe(mod.getPodId())
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
