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
let hashStore: Map<string, Record<string, string>>
let pingError: Error | null = null

class FakeRedis {
  public events = new Map<string, Array<(...args: any[]) => void>>()
  // ioredis's `.status` is the authoritative readiness check used by
  // `isTunnelRedisDegraded`. Production code reads it directly, so the
  // fake has to mirror the real lifecycle ('connecting' → 'ready') or
  // every test will see degraded=true.
  public status: 'wait' | 'connecting' | 'ready' | 'end' | 'reconnecting' | 'close' = 'wait'
  constructor(_url: string, _opts: any) {
    store = store ?? new Map()
    hashStore = hashStore ?? new Map()
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
  async ping() {
    if (pingError) throw pingError
    return 'PONG'
  }
  async hset(k: string, field: string, value: string) {
    const hash = hashStore.get(k) ?? {}
    hash[field] = value
    hashStore.set(k, hash)
    return 1
  }
  async hgetall(k: string) {
    return hashStore.get(k) ?? {}
  }
  async unsubscribe() {}
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
    hashStore = new Map()
    pingError = null
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

  test('checkRedisHealth reports ping latency and ping failures', async () => {
    delete process.env.SHOGO_LOCAL_MODE
    const mod = await freshImport()
    await mod.initTunnelRedis()

    const healthy = await mod.checkRedisHealth()
    expect(healthy.healthy).toBe(true)
    expect(typeof healthy.latencyMs).toBe('number')

    pingError = new Error('redis down')
    const unhealthy = await mod.checkRedisHealth()
    expect(unhealthy.healthy).toBe(false)
    expect(unhealthy.error).toBe('redis down')
  })

  test('ownership helpers register, refresh, unregister, and force-evict keys', async () => {
    delete process.env.SHOGO_LOCAL_MODE
    const mod = await freshImport()
    await mod.initTunnelRedis()

    await mod.registerTunnelOwnership('inst-owned')
    expect(await mod.getTunnelOwner('inst-owned')).toBe(mod.getPodId())

    await mod.refreshTunnelOwnership('inst-owned')
    await mod.unregisterTunnelOwnership('inst-owned')
    expect(await mod.getTunnelOwner('inst-owned')).toBeNull()

    store.set('tunnel:inst-evict:pod', 'other-pod')
    await mod.evictTunnelOwnership('inst-evict')
    expect(await mod.getTunnelOwner('inst-evict')).toBeNull()
  })

  test('viewer and controller tracking round-trips through Redis', async () => {
    delete process.env.SHOGO_LOCAL_MODE
    const mod = await freshImport()
    await mod.initTunnelRedis()

    expect(await mod.isViewerActiveRedis('ws-1')).toBe(false)
    await mod.markViewerActiveRedis('ws-1')
    expect(await mod.isViewerActiveRedis('ws-1')).toBe(true)

    await mod.markControllerActiveRedis('inst-1', 'user-1', 'session-1')
    await mod.markControllerActiveRedis('inst-1', 'user-2')
    hashStore.get('ctrl:inst-1')!.stale = JSON.stringify({
      userId: 'stale',
      lastSeenAt: Date.now() - 120_000,
    })
    hashStore.get('ctrl:inst-1')!.bad = 'not-json'

    expect(await mod.getActiveControllersRedis('inst-1')).toEqual([
      { userId: 'user-1', sessionId: 'session-1', lastSeenAt: expect.any(Number) },
      { userId: 'user-2', sessionId: undefined, lastSeenAt: expect.any(Number) },
    ])
  })

  test('isTunnelConnectedAnywhere reflects owner lookup result', async () => {
    delete process.env.SHOGO_LOCAL_MODE
    const mod = await freshImport()
    await mod.initTunnelRedis()

    expect(await mod.isTunnelConnectedAnywhere('inst-none')).toBe(false)
    store.set('tunnel:inst-yes:pod', 'pod-owner')
    expect(await mod.isTunnelConnectedAnywhere('inst-yes')).toBe(true)
  })

  test('verifyPodAlive returns true immediately for this pod', async () => {
    delete process.env.SHOGO_LOCAL_MODE
    const mod = await freshImport()
    await mod.initTunnelRedis()

    expect(await mod.verifyPodAlive(mod.getPodId())).toBe(true)
  })

  test('local mode short-circuits without connecting to Redis', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    const mod = await freshImport()
    await mod.initTunnelRedis()
    expect(mod.isTunnelRedisDegraded()).toBe(false)
  })
})
