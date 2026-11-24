// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tunnel rotation on the api side (SHO-565).
 *
 * The desktop replaces its socket before a pod can take it away, so the api has
 * to answer two questions: "does this new socket own the machine now?" (`ready`,
 * sent only after the Redis write) and "is this close a rotation or a goodbye?"
 * (`unregisterTunnelOwnership` says whether we still owned it). Getting the
 * second one wrong marks a live machine offline and 503s everything until its
 * next heartbeat.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const instanceUpdates: any[] = []
let registerError: Error | null = null
let unregisterError: Error | null = null
let unregisterWasOwner = true
const registered: string[] = []
const unregistered: string[] = []

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    instance: {
      update: mock(async (args: any) => {
        instanceUpdates.push(args)
        return { id: args.where.id, ...args.data }
      }),
      findFirst: mock(async () => null),
      findUnique: mock(async () => null),
      create: mock(async (args: any) => ({ id: 'inst-created', ...args.data })),
    },
  },
}))

mock.module('../routes/api-keys', () => ({
  resolveApiKey: mock(async () => ({ workspaceId: 'ws-1', userId: 'user-1' })),
}))

mock.module('../lib/tunnel-redis', () => ({
  initTunnelRedis: async () => {},
  registerTunnelOwnership: async (instanceId: string) => {
    registered.push(instanceId)
    if (registerError) throw registerError
  },
  unregisterTunnelOwnership: async (instanceId: string) => {
    unregistered.push(instanceId)
    if (unregisterError) throw unregisterError
    return unregisterWasOwner
  },
  evictTunnelOwnership: async () => {},
  refreshTunnelOwnership: async () => true,
  getTunnelOwner: async () => null,
  relayTunnelRequest: async () => null,
  relayTunnelStreamRequest: async () => null,
  setLocalTunnelHandlers: () => {},
  markViewerActiveRedis: async () => {},
  isViewerActiveRedis: async () => false,
  markControllerActiveRedis: async () => {},
  getActiveControllersRedis: async () => [],
  isTunnelConnectedAnywhere: async () => false,
  getPodId: () => 'pod-test',
  getSharedRedis: () => null,
  whenReady: async () => {},
  verifyPodAlive: async () => true,
}))

mock.module('../lib/push-notifications', () => ({
  sendPushToInstance: async () => ({ sent: false }),
  sendPushToUser: async () => ({ sent: false }),
}))

mock.module('../lib/proxy-billing-session', () => ({
  openSession: () => null,
  closeSession: async () => null,
  hasSession: () => false,
  hasActiveSession: () => false,
  setQualitySignals: () => false,
  accumulateUsage: () => {},
  accumulateImageUsage: () => {},
}))

mock.module('../lib/chat-usage-tracker', () => ({
  trackChatStreamForBilling: async () => {},
}))

mock.module('../routes/remote-audit', () => ({
  logRemoteAction: async () => {},
  classifyAction: () => 'other',
}))

const { _testing, drainInstanceTunnels, handleInstanceWsClose, handleInstanceWsOpen } =
  await import('../routes/instances')

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function fakeWs(data: Record<string, unknown> = {}) {
  return {
    data,
    close: mock(() => {}),
    send: mock(() => {}),
  } as any
}

function framesSent(ws: any): any[] {
  return ws.send.mock.calls.map((call: any[]) => JSON.parse(call[0]))
}

beforeEach(() => {
  _testing.tunnels.clear()
  instanceUpdates.length = 0
  registered.length = 0
  unregistered.length = 0
  registerError = null
  unregisterError = null
  unregisterWasOwner = true
  _testing.resetTunnelDrain()
})

describe('tunnel rotation handshake', () => {
  test('ready is sent only after the ownership write lands', async () => {
    const ws = fakeWs({ instanceId: 'inst-1', workspaceId: 'ws-1' })
    await handleInstanceWsOpen(ws)

    // The desktop promotes a replacement on this frame, so it must not arrive
    // before the Redis key names this pod — otherwise a request routed here
    // finds no socket and 503s.
    expect(registered).toEqual(['inst-1'])
    expect(framesSent(ws)).toEqual([{ type: 'ready', podId: 'pod-test' }])
  })

  test('a socket opened on a draining pod is told to rotate immediately', async () => {
    const first = fakeWs({ instanceId: 'inst-1', workspaceId: 'ws-1' })
    await handleInstanceWsOpen(first)

    drainInstanceTunnels()

    // A pod stays in its Service's endpoints for a moment, so a rotation can
    // land right back here after the broadcast.
    const late = fakeWs({ instanceId: 'inst-2', workspaceId: 'ws-1' })
    await handleInstanceWsOpen(late)

    expect(framesSent(late).map((f) => f.type)).toEqual(['ready', 'drain'])
  })

  test('drainInstanceTunnels frames every open socket and reports how many', async () => {
    const a = fakeWs({ instanceId: 'inst-1', workspaceId: 'ws-1' })
    const b = fakeWs({ instanceId: 'inst-2', workspaceId: 'ws-1' })
    await handleInstanceWsOpen(a)
    await handleInstanceWsOpen(b)
    a.send.mockClear()
    b.send.mockClear()

    expect(drainInstanceTunnels()).toBe(2)
    expect(framesSent(a)[0]).toMatchObject({ type: 'drain' })
    expect(framesSent(b)[0]).toMatchObject({ type: 'drain' })
  })

  test('a socket that cannot be written to does not stop the drain for the others', async () => {
    const dead = fakeWs({ instanceId: 'inst-1', workspaceId: 'ws-1' })
    const live = fakeWs({ instanceId: 'inst-2', workspaceId: 'ws-1' })
    await handleInstanceWsOpen(dead)
    await handleInstanceWsOpen(live)
    dead.send = mock(() => { throw new Error('socket closed') })
    live.send.mockClear()

    expect(drainInstanceTunnels()).toBe(1)
    expect(framesSent(live)[0]).toMatchObject({ type: 'drain' })
  })
})

describe('close after a rotation', () => {
  test('keeps the machine online when another pod owns the tunnel now', async () => {
    const ws = fakeWs({ instanceId: 'inst-1', workspaceId: 'ws-1' })
    await handleInstanceWsOpen(ws)
    instanceUpdates.length = 0
    unregisterWasOwner = false

    handleInstanceWsClose(ws, 1000, 'Rotated')
    await settle()

    expect(unregistered).toEqual(['inst-1'])
    // Marking it offline would 503 every request until the next heartbeat, even
    // though the desktop is streaming happily on another pod.
    expect(instanceUpdates).toEqual([])
  })

  test('still marks the machine offline when this pod was the owner', async () => {
    const ws = fakeWs({ instanceId: 'inst-1', workspaceId: 'ws-1' })
    await handleInstanceWsOpen(ws)
    instanceUpdates.length = 0

    handleInstanceWsClose(ws, 1000, 'client closed')
    await settle()

    expect(instanceUpdates[0]).toMatchObject({ where: { id: 'inst-1' }, data: { status: 'offline' } })
  })

  test('an unregister failure does not leave the machine looking online forever', async () => {
    const ws = fakeWs({ instanceId: 'inst-1', workspaceId: 'ws-1' })
    await handleInstanceWsOpen(ws)
    instanceUpdates.length = 0
    unregisterError = new Error('redis down')

    handleInstanceWsClose(ws, 1006, 'gone')
    await settle()

    // The ownership answer is unknown, so nothing is written: the heartbeat's
    // stale-instance sweep owns that case. Silence is the safe half of the
    // trade — the alternative is 503ing a live machine.
    expect(instanceUpdates).toEqual([])
  })
})
