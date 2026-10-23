// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Machine status reads must not pay `getTunnelOwner`'s 100 ms cold-start retry
 * (SHO-158 / PERF-3), and `getMachineGroupStatus` checks a machine's rows
 * concurrently. Routing paths keep the retry.
 *
 *   bun test apps/api/src/__tests__/instances-machine-status.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const ownerCalls: Array<{ id: string; opts: unknown }> = []
const connectedCalls: Array<{ id: string; opts: unknown }> = []
const onlineIds = new Set<string>()
let inFlight = 0
let maxInFlight = 0

mock.module('../lib/tunnel-redis', () => ({
  initTunnelRedis: async () => {},
  registerTunnelOwnership: async () => {},
  unregisterTunnelOwnership: async () => {},
  evictTunnelOwnership: async () => {},
  refreshTunnelOwnership: async () => {},
  getTunnelOwner: async (id: string, opts?: unknown) => {
    ownerCalls.push({ id, opts })
    return null
  },
  relayTunnelRequest: async () => ({}),
  relayTunnelStreamRequest: () => ({ cancel: () => {} }),
  setLocalTunnelHandlers: () => {},
  markViewerActiveRedis: async () => {},
  isViewerActiveRedis: async () => false,
  markControllerActiveRedis: async () => {},
  getActiveControllersRedis: async () => [],
  isTunnelConnectedAnywhere: async (id: string, opts?: unknown) => {
    connectedCalls.push({ id, opts })
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 20))
    inFlight--
    return onlineIds.has(id)
  },
  getPodId: () => 'pod-test',
  getSharedRedis: () => null,
  verifyPodAlive: async () => false,
}))
mock.module('../lib/prisma', () =>
  withPrismaExports({ prisma: { instance: { update: async () => ({}) } } }),
)
mock.module('../routes/api-keys', () => ({ resolveApiKey: async () => null }))
mock.module('../lib/push-notifications', () => ({
  sendPushToInstance: async () => ({ sent: false }),
  sendPushToUser: async () => ({ sent: false }),
}))

const { getMachineGroupStatus, getMachineLiveStatus, ensureTunnelConnected } = await import('../routes/instances')

const RECENT = () => new Date()
const STALE = new Date(0)

beforeEach(() => {
  ownerCalls.length = 0
  connectedCalls.length = 0
  onlineIds.clear()
  inFlight = 0
  maxInFlight = 0
})

describe('getMachineLiveStatus', () => {
  test('reads tunnel status without the cold-start retry', async () => {
    expect(await getMachineLiveStatus('m-1', STALE)).toBe('offline')
    expect(connectedCalls).toEqual([{ id: 'm-1', opts: { retry: false } }])
  })
})

describe('getMachineGroupStatus', () => {
  test('all rows offline → offline', async () => {
    const rows = [
      { id: 'a', lastSeenAt: STALE },
      { id: 'b', lastSeenAt: null },
    ]
    expect(await getMachineGroupStatus(rows)).toBe('offline')
  })

  test('one heartbeat row among offline rows → heartbeat', async () => {
    const rows = [
      { id: 'a', lastSeenAt: STALE },
      { id: 'b', lastSeenAt: RECENT() },
    ]
    expect(await getMachineGroupStatus(rows)).toBe('heartbeat')
  })

  test('one online row among offline/heartbeat rows → online', async () => {
    onlineIds.add('c')
    const rows = [
      { id: 'a', lastSeenAt: STALE },
      { id: 'b', lastSeenAt: RECENT() },
      { id: 'c', lastSeenAt: STALE },
    ]
    expect(await getMachineGroupStatus(rows)).toBe('online')
  })

  test('checks every row concurrently, with no retry', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, lastSeenAt: STALE }))
    await getMachineGroupStatus(rows)
    expect(maxInFlight).toBe(5)
    expect(connectedCalls.every((c) => (c.opts as { retry?: boolean })?.retry === false)).toBe(true)
  })
})

describe('ensureTunnelConnected', () => {
  test('first owner read keeps the routing retry; the poll loop does not', async () => {
    expect(await ensureTunnelConnected('w-1', 1)).toBe(false)
    expect(ownerCalls[0]).toEqual({ id: 'w-1', opts: undefined })
    expect(ownerCalls.length).toBeGreaterThan(1)
    for (const call of ownerCalls.slice(1)) expect(call.opts).toEqual({ retry: false })
  })
})
