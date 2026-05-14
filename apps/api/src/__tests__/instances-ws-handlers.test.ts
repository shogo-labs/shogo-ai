// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const instanceUpdates: any[] = []
const instanceUpserts: any[] = []
let resolveApiKeyResult: any = { workspaceId: 'ws-1', userId: 'user-1' }
let upsertError: Error | null = null
let registerError: Error | null = null
let unregisterError: Error | null = null
const registered: string[] = []
const unregistered: string[] = []

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    instance: {
      update: mock(async (args: any) => {
        instanceUpdates.push(args)
        return { id: args.where.id, ...args.data }
      }),
      upsert: mock(async (args: any) => {
        instanceUpserts.push(args)
        if (upsertError) throw upsertError
        return { id: 'inst-upserted', workspaceId: args.create.workspaceId }
      }),
    },
  },
}))

mock.module('../routes/api-keys', () => ({
  resolveApiKey: mock(async () => resolveApiKeyResult),
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
  verifyPodAlive: async () => true,
}))

mock.module('../lib/push-notifications', () => ({
  sendPushToInstance: async () => ({ sent: false }),
}))

mock.module('../lib/proxy-billing-session', () => ({
  openSession: () => null,
  closeSession: async () => null,
  hasSession: () => false,
}))

mock.module('../lib/chat-usage-tracker', () => ({
  trackChatStreamForBilling: () => {},
}))

mock.module('../routes/remote-audit', () => ({
  logRemoteAction: async () => {},
  classifyAction: () => 'other',
}))

const {
  _testing,
  authenticateInstanceWs,
  handleInstanceWsClose,
  handleInstanceWsMessage,
  handleInstanceWsOpen,
} = await import('../routes/instances')

beforeEach(() => {
  _testing.tunnels.clear()
  instanceUpdates.length = 0
  instanceUpserts.length = 0
  registered.length = 0
  unregistered.length = 0
  resolveApiKeyResult = { workspaceId: 'ws-1', userId: 'user-1' }
  upsertError = null
  registerError = null
  unregisterError = null
})

function fakeWs(data: Record<string, unknown> = {}) {
  return {
    data,
    close: mock(() => {}),
    send: mock(() => {}),
  } as any
}

describe('instance WebSocket handlers', () => {
  test('open closes sockets missing context and registers valid sockets before marking online', async () => {
    const missing = fakeWs()
    await handleInstanceWsOpen(missing)
    expect(missing.close).toHaveBeenCalledWith(4001, 'Missing instance context')

    const ws = fakeWs({ instanceId: 'inst-1', workspaceId: 'ws-1' })
    await handleInstanceWsOpen(ws)

    expect(registered).toEqual(['inst-1'])
    expect(_testing.tunnels.has('inst-1')).toBe(true)
    expect(instanceUpdates[0]).toMatchObject({
      where: { id: 'inst-1' },
      data: { status: 'online', wsRequestedAt: null },
    })
  })

  test('open skips online write if socket closes while ownership registration is pending', async () => {
    registerError = new Error('redis unavailable')
    const ws = fakeWs({ instanceId: 'inst-1', workspaceId: 'ws-1' })
    const openPromise = handleInstanceWsOpen(ws)
    _testing.tunnels.delete('inst-1')
    await openPromise

    expect(instanceUpdates).toEqual([])
  })

  test('message handles pong, heartbeat, responses, malformed JSON, and stream lifecycle events', () => {
    const ws = fakeWs({ instanceId: 'inst-1' })
    const resolved: any[] = []
    const rejected: any[] = []
    const chunks: any[] = []
    _testing.tunnels.set('inst-1', {
      ws,
      instanceId: 'inst-1',
      workspaceId: 'ws-1',
      pendingRequests: new Map([
        ['req-1', {
          resolve: (value: any) => resolved.push(value),
          reject: (err: Error) => rejected.push(err),
          timeout: setTimeout(() => {}, 10_000),
        }],
      ]),
      streamHandlers: new Map([
        ['stream-1', (chunk: any) => chunks.push(chunk)],
      ]),
    })

    handleInstanceWsMessage(ws, 'not json')
    handleInstanceWsMessage(ws, JSON.stringify({ type: 'pong' }))
    expect(ws.data._lastPong).toBeGreaterThan(0)

    handleInstanceWsMessage(ws, JSON.stringify({ type: 'heartbeat', metadata: { cpu: 1 } }))
    expect(instanceUpdates[0].data.metadata).toEqual({ cpu: 1 })

    handleInstanceWsMessage(ws, JSON.stringify({ type: 'response', requestId: 'req-1', status: 201, body: 'ok' }))
    expect(resolved[0]).toMatchObject({ requestId: 'req-1', status: 201 })
    expect(rejected).toEqual([])

    handleInstanceWsMessage(ws, JSON.stringify({ type: 'stream-chunk', requestId: 'stream-1', data: 'a' }))
    handleInstanceWsMessage(ws, JSON.stringify({ type: 'stream-end', requestId: 'stream-1' }))
    expect(chunks.map((chunk) => chunk.type)).toEqual(['stream-chunk', 'stream-end'])
    expect(_testing.tunnels.get('inst-1')!.streamHandlers.has('stream-1')).toBe(false)
  })

  test('close rejects pending requests, notifies stream handlers, unregisters ownership, and marks offline', async () => {
    const ws = fakeWs({ instanceId: 'inst-1' })
    const rejected: string[] = []
    const chunks: any[] = []
    _testing.tunnels.set('inst-1', {
      ws,
      instanceId: 'inst-1',
      workspaceId: 'ws-1',
      pendingRequests: new Map([
        ['req-1', {
          resolve: () => {},
          reject: (err: Error) => rejected.push(err.message),
          timeout: setTimeout(() => {}, 10_000),
        }],
      ]),
      streamHandlers: new Map([
        ['stream-1', (chunk: any) => chunks.push(chunk)],
      ]),
    })

    handleInstanceWsClose(ws)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(rejected).toEqual(['Tunnel disconnected'])
    expect(chunks[0]).toMatchObject({ type: 'stream-error', error: 'Tunnel disconnected' })
    expect(_testing.tunnels.has('inst-1')).toBe(false)
    expect(unregistered).toEqual(['inst-1'])
    expect(instanceUpdates[0]).toMatchObject({ where: { id: 'inst-1' }, data: { status: 'offline' } })
  })
})

describe('authenticateInstanceWs', () => {
  test('accepts bearer, x-api-key, and legacy query credentials', async () => {
    const bearer = await authenticateInstanceWs(new Request('http://x/api/instances/ws', {
      headers: {
        Authorization: 'Bearer shogo_key',
        'x-shogo-hostname': 'host-a',
        'x-shogo-name': 'Desktop A',
        'x-shogo-os': 'darwin',
        'x-shogo-arch': 'arm64',
      },
    }))
    expect(bearer).toEqual({ instanceId: 'inst-upserted', workspaceId: 'ws-1' })
    expect(instanceUpserts[0].create).toMatchObject({ hostname: 'host-a', name: 'Desktop A', os: 'darwin', arch: 'arm64' })

    const xKey = await authenticateInstanceWs(new Request('http://x/api/instances/ws', {
      headers: { 'x-api-key': 'shogo_key_2', 'x-shogo-hostname': 'host-b' },
    }))
    expect(xKey?.instanceId).toBe('inst-upserted')

    const legacy = await authenticateInstanceWs(new Request('http://x/api/instances/ws?key=legacy&hostname=host-c&name=Desktop%20C'))
    expect(legacy?.workspaceId).toBe('ws-1')
  })

  test('returns null for missing keys, unresolved keys, and upsert errors', async () => {
    expect(await authenticateInstanceWs(new Request('http://x/api/instances/ws'))).toBeNull()

    resolveApiKeyResult = null
    expect(await authenticateInstanceWs(new Request('http://x/api/instances/ws', {
      headers: { 'x-api-key': 'bad' },
    }))).toBeNull()

    resolveApiKeyResult = { workspaceId: 'ws-1', userId: 'user-1' }
    upsertError = new Error('db down')
    expect(await authenticateInstanceWs(new Request('http://x/api/instances/ws', {
      headers: { 'x-api-key': 'good' },
    }))).toBeNull()
  })
})
