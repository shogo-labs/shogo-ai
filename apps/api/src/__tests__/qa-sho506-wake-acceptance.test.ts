// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-506 acceptance — the wake decision, and the answer after it.
 *
 * `device_connecting` is retryable and `device_offline` is not, so which one a
 * host gets has to follow the heartbeat *the wake was planned from*. Re-deriving
 * freshness after the wait flips a host that was online into "away" whenever its
 * own wait pushes the same heartbeat past the freshness line, and the agent is
 * told not to retry that (SHO-506 AC2).
 *
 *   SHOGO_LOCAL_MODE=false bun --no-env-file test apps/api/src/__tests__/qa-sho506-wake-acceptance.test.ts
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

const { wakeHostTunnel, isRecentlySeenViaHeartbeat, _testing } = await import('../routes/instances')
const { wakeRefusal } = await import('../lib/host-wake')

const ID = 'inst-qa-wake'
const { POLL_INTERVAL_IDLE_S } = _testing
const FRESH_LINE_MS = POLL_INTERVAL_IDLE_S * 2 * 1000

beforeEach(() => {
  _testing.tunnels.clear()
  instanceRows.clear()
})

describe('connecting vs offline follows the heartbeat the wake was planned from (SHO-506 AC2)', () => {
  test('a host that was fresh when the wake began answers connecting even if the wait crosses the freshness line', async () => {
    // 116s old at wake time: still fresh (the line is 120s), so this machine is
    // up and its tunnel is merely still opening. The 5s probe spends that budget,
    // and the answer must not turn into the non-retryable "offline" because of it.
    const wake = await wakeHostTunnel(ID, {
      maxWaitMs: 5_000,
      staleProbeMs: 5_000,
      _tunnelUp: async () => false,
      _lastSeenAt: new Date(Date.now() - (FRESH_LINE_MS - 4_000)),
    })
    expect(wake.state).toBe('connecting')
    const refusal = wakeRefusal(wake, 'device')!
    expect(refusal.code).toBe('device_connecting')
    expect(refusal.retryable).toBe(true)
    expect(refusal.retryAfterSeconds).toBeGreaterThan(0)
  }, 20_000)

  test('a host that was stale when the wake began still answers offline after the short probe', async () => {
    const wake = await wakeHostTunnel(ID, {
      maxWaitMs: 200,
      staleProbeMs: 200,
      _tunnelUp: async () => false,
      _lastSeenAt: new Date(Date.now() - FRESH_LINE_MS - 20_000),
    })
    expect(wake.state).toBe('offline')
    const refusal = wakeRefusal(wake, 'device')!
    expect(refusal.code).toBe('device_offline')
    expect(refusal.retryable).toBe(false)
  })

  test('the freshness rule itself is two idle polls', () => {
    const now = 1_000_000
    expect(isRecentlySeenViaHeartbeat(new Date(now - FRESH_LINE_MS + 1), now)).toBe(true)
    expect(isRecentlySeenViaHeartbeat(new Date(now - FRESH_LINE_MS), now)).toBe(false)
  })
})
