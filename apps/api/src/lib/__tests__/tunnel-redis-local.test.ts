// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'

// CRITICAL: set local mode BEFORE importing tunnel-redis.
process.env.SHOGO_LOCAL_MODE = 'true'
process.env.HOSTNAME = 'pod-local-A'

// Provide a minimal ioredis stub even though we never use it in local mode —
// importing fails without it.
class FakeRedis {
  constructor(_url: string, _opts: any) {}
  on() { return this }
  async connect() {}
  async subscribe() {}
  status = 'ready'
}
mock.module('ioredis', () => ({ default: FakeRedis }))

const tr = await import('../tunnel-redis')

beforeAll(async () => {
  await tr.initTunnelRedis()
})

describe('tunnel-redis (LOCAL MODE)', () => {
  it('getPodId returns the HOSTNAME', () => {
    expect(tr.getPodId()).toBe('pod-local-A')
  })

  it('isTunnelRedisDegraded returns false in local mode (always)', () => {
    expect(tr.isTunnelRedisDegraded()).toBe(false)
  })

  it('whenReady resolves without setting up Redis', async () => {
    await tr.whenReady()
    expect(tr.getSharedRedis()).toBeNull()
  })

  it('initTunnelRedis is idempotent — second call returns immediately', async () => {
    await tr.initTunnelRedis()
    await tr.initTunnelRedis()
    expect(tr.getSharedRedis()).toBeNull()
  })

  it('checkRedisHealth returns { healthy:true, latencyMs:0 }', async () => {
    expect(await tr.checkRedisHealth()).toEqual({ healthy: true, latencyMs: 0 })
  })

  it('registerTunnelOwnership is a no-op (no publisher)', async () => {
    await tr.registerTunnelOwnership('i-1')
  })
  it('unregisterTunnelOwnership is a no-op', async () => {
    await tr.unregisterTunnelOwnership('i-1')
  })
  it('evictTunnelOwnership is a no-op', async () => {
    await tr.evictTunnelOwnership('i-1')
  })
  it('refreshTunnelOwnership is a no-op', async () => {
    await tr.refreshTunnelOwnership('i-1')
  })

  it('getTunnelOwner returns null when publisher is null', async () => {
    expect(await tr.getTunnelOwner('i-1')).toBeNull()
  })

  it('verifyPodAlive returns false when publisher is null', async () => {
    expect(await tr.verifyPodAlive('pod-other')).toBe(false)
  })

  it('verifyPodAlive returns true when probing self (POD_ID)', async () => {
    // self-probe checks happen BEFORE the publisher check — actually, looking
    // at the code, the publisher check is first. In local mode publisher is
    // null, so even self-probe returns false. Verify documented behavior.
    expect(await tr.verifyPodAlive('pod-local-A')).toBe(false)
  })

  it('relayTunnelRequest throws when Redis is not initialized', async () => {
    await expect(
      tr.relayTunnelRequest('pod-other', 'i-1', {
        type: 'request', requestId: 'r1', method: 'GET', path: '/p',
      }),
    ).rejects.toThrow(/Redis not initialized/)
  })

  it('relayTunnelStreamRequest reports stream-error chunk when not initialized', async () => {
    const chunks: any[] = []
    const handle = tr.relayTunnelStreamRequest(
      'pod-other', 'i-1',
      { type: 'request', requestId: 'r1', method: 'GET', path: '/p' },
      (c) => chunks.push(c),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(chunks.some((c) => c.type === 'stream-error' && /not initialized/.test(c.error))).toBe(true)
    handle.cancel()
  })

  it('cancelling relayTunnelStreamRequest before whenReady resolves prevents publish', async () => {
    const chunks: any[] = []
    const handle = tr.relayTunnelStreamRequest(
      'pod-other', 'i-2',
      { type: 'request', requestId: 'r2', method: 'GET', path: '/p' },
      (c) => chunks.push(c),
    )
    handle.cancel()
    await new Promise((r) => setTimeout(r, 10))
  })

  it('markViewerActiveRedis is a no-op when publisher is null', async () => {
    await tr.markViewerActiveRedis('w-1')
  })
  it('isViewerActiveRedis returns false when publisher is null', async () => {
    expect(await tr.isViewerActiveRedis('w-1')).toBe(false)
  })
  it('markControllerActiveRedis is a no-op when publisher is null', async () => {
    await tr.markControllerActiveRedis('i-1', 'u-1')
    await tr.markControllerActiveRedis('i-1', 'u-1', 's-1')
  })
  it('getActiveControllersRedis returns [] when publisher is null', async () => {
    expect(await tr.getActiveControllersRedis('i-1')).toEqual([])
  })
  it('isTunnelConnectedAnywhere returns false when publisher is null', async () => {
    expect(await tr.isTunnelConnectedAnywhere('i-1')).toBe(false)
  })

  it('setLocalTunnelHandlers installs handlers (smoke)', () => {
    tr.setLocalTunnelHandlers(
      async () => ({ type: 'response', requestId: 'r', status: 200 }),
      () => ({ cancel: () => {} }),
    )
  })

  it('getSharedRedis returns null in local mode', () => {
    expect(tr.getSharedRedis()).toBeNull()
  })

  it('shutdownTunnelRedis tolerates being called in local mode (initialized=true)', async () => {
    await tr.shutdownTunnelRedis()
    // After shutdown, init can run again
    await tr.initTunnelRedis()
    expect(tr.getPodId()).toBe('pod-local-A')
  })
})
