// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-506: waking a desktop's tunnel.
 *
 * A desktop only learns that the cloud wants its tunnel from its next heartbeat
 * poll (an idle one polls every 60s), so a 5s wake window missed almost every
 * time and every caller answered `device_offline` for a machine that was up. The
 * wait now comes from the host's own heartbeat, and a host that is up but whose
 * tunnel missed the window answers a retryable `device_connecting`.
 *
 *   bun test apps/api/src/__tests__/sho-506-host-wake.test.ts
 */

import { beforeEach, describe, expect, test, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

mock.module('../lib/tunnel-redis', () => ({
  initTunnelRedis: async () => {},
  registerTunnelOwnership: async () => {},
  unregisterTunnelOwnership: async () => {},
  evictTunnelOwnership: async () => {},
  refreshTunnelOwnership: async () => {},
  getTunnelOwner: async () => null,
  relayTunnelRequest: async () => ({}),
  relayTunnelStreamRequest: () => ({ cancel: () => {} }),
  setLocalTunnelHandlers: () => {},
  markViewerActiveRedis: async () => {},
  isViewerActiveRedis: async () => false,
  markControllerActiveRedis: async () => {},
  getActiveControllersRedis: async () => [],
  isTunnelConnectedAnywhere: async () => false,
  getPodId: () => 'pod-test',
  getSharedRedis: () => null,
  whenReady: async () => {},
  verifyPodAlive: async () => false,
}))

const instanceRows = new Map<string, { name: string; lastSeenAt: Date | null }>()

mock.module('../lib/prisma', () =>
  withPrismaExports({
    prisma: {
      instance: {
        findUnique: async ({ where }: any) => instanceRows.get(where.id) ?? null,
        update: async () => ({}),
      },
    },
  }),
)
mock.module('../routes/api-keys', () => ({ resolveApiKey: async () => null }))
mock.module('../lib/push-notifications', () => ({
  sendPushToInstance: async () => ({ sent: false }),
  sendPushToUser: async () => ({ sent: false }),
}))

const { planHostWake, wakeHostTunnel, _testing } = await import('../routes/instances')

const ID = 'inst-wake'
const { POLL_INTERVAL_IDLE_S, WAKE_HEARTBEAT_MARGIN_MS, WAKE_MAX_WAIT_MS, WAKE_MIN_WAIT_MS, WAKE_RETRY_AFTER_S } =
  _testing

beforeEach(() => {
  _testing.tunnels.clear()
  instanceRows.clear()
})

describe('planHostWake — the wait comes from the heartbeat', () => {
  test('a live tunnel is connected, with no wait at all', () => {
    expect(planHostWake({ tunnelUp: true, lastSeenAt: new Date(), now: 1_000 })).toEqual({
      state: 'connected',
      waitMs: 0,
    })
  })

  test('a host that polled 40s ago is waited for until its next poll, not 5s', () => {
    const now = 1_000_000
    const lastSeenAt = new Date(now - 40_000)
    const { state, waitMs } = planHostWake({ tunnelUp: false, lastSeenAt, now })
    expect(state).toBe('wait')
    // 60s poll + 15s margin − 40s already elapsed.
    expect(waitMs).toBe(35_000)
  })

  test('a host that polled a moment ago waits until its next poll — nearly the whole window', () => {
    const now = 1_000_000
    const lastSeenAt = new Date(now - 1_000)
    const { waitMs } = planHostWake({ tunnelUp: false, lastSeenAt, now })
    expect(waitMs).toBe(WAKE_MAX_WAIT_MS - 1_000)
  })

  test('never shorter than the minimum, so a just-polled host is not written off at once', () => {
    const now = 1_000_000
    // The poll + margin + min-wait arithmetic would go below the minimum here.
    const { waitMs } = planHostWake({ tunnelUp: false, lastSeenAt: new Date(now - 74_000), now })
    expect(waitMs).toBe(WAKE_MIN_WAIT_MS)
  })

  test('a stale heartbeat gets the short probe — nothing is polling to answer the wake', () => {
    const now = 1_000_000
    const { state, waitMs } = planHostWake({
      tunnelUp: false,
      lastSeenAt: new Date(now - POLL_INTERVAL_IDLE_S * 2 * 1000 - 1),
      now,
      staleProbeMs: 5_000,
    })
    expect(state).toBe('wait')
    expect(waitMs).toBe(5_000)
  })

  test('the caller’s cap wins over the heartbeat window', () => {
    expect(
      planHostWake({ tunnelUp: false, lastSeenAt: new Date(999_999_000), now: 1_000_000, maxWaitMs: 1_500 }),
    ).toEqual({ state: 'wait', waitMs: 1_500 })
  })

  test('a host with no heartbeat at all is a stale host', () => {
    expect(planHostWake({ tunnelUp: false, lastSeenAt: null, now: 1_000_000, staleProbeMs: 2_000 })).toEqual({
      state: 'wait',
      waitMs: 2_000,
    })
  })
})

describe('wakeHostTunnel — connected, connecting, offline', () => {
  test('an already-connected host answers immediately and never asks for a wake', async () => {
    instanceRows.set(ID, { name: 'samasra', lastSeenAt: new Date() })
    _testing.tunnels.set(ID, {} as any)
    const started = Date.now()
    const wake = await wakeHostTunnel(ID)
    expect(wake.state).toBe('connected')
    expect(Date.now() - started).toBeLessThan(500)
  })

  test('a fresh host whose tunnel opens mid-wait is connected, not offline', async () => {
    instanceRows.set(ID, { name: 'samasra', lastSeenAt: new Date() })
    // The desktop answers the wake at 0.7s, inside the window.
    setTimeout(() => _testing.tunnels.set(ID, {} as any), 700)
    const wake = await wakeHostTunnel(ID, { maxWaitMs: 4_000, _tunnelUp: async () => false })
    expect(wake.state).toBe('connected')
  })

  test('a fresh host that never connects answers connecting, with a retry', async () => {
    instanceRows.set(ID, { name: 'samasra', lastSeenAt: new Date() })
    const wake = await wakeHostTunnel(ID, { maxWaitMs: 300, _tunnelUp: async () => false })
    expect(wake.state).toBe('connecting')
    expect(wake.retryAfterSeconds).toBe(WAKE_RETRY_AFTER_S)
    expect(wake.name).toBe('samasra')
  })

  test('a host whose heartbeat is stale answers offline after the short probe', async () => {
    instanceRows.set(ID, { name: 'samasra', lastSeenAt: new Date(Date.now() - 10 * 60_000) })
    const started = Date.now()
    const wake = await wakeHostTunnel(ID, { staleProbeMs: 300, _tunnelUp: async () => false })
    expect(wake.state).toBe('offline')
    expect(wake.retryAfterSeconds).toBe(0)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('the boundary between connecting and offline is the heartbeat freshness rule', async () => {
    const fresh = new Date(Date.now() - 40_000)
    const stale = new Date(Date.now() - POLL_INTERVAL_IDLE_S * 2 * 1000 - 1_000)
    const near = await wakeHostTunnel(ID, { maxWaitMs: 150, staleProbeMs: 150, _tunnelUp: async () => false, _lastSeenAt: fresh })
    const far = await wakeHostTunnel(ID, { maxWaitMs: 150, staleProbeMs: 150, _tunnelUp: async () => false, _lastSeenAt: stale })
    expect(near.state).toBe('connecting')
    expect(far.state).toBe('offline')
    expect(WAKE_HEARTBEAT_MARGIN_MS).toBeGreaterThan(0)
  })
})
