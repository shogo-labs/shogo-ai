// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.SHOGO_LOCAL_MODE = 'false'
process.env.REDIS_URL = 'redis://test-redis:6379'
process.env.HOSTNAME = 'pod-a'

import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

type Handler = (...args: any[]) => void

const redisInstances: FakeRedis[] = []
const kv = new Map<string, string>()
const hashes = new Map<string, Record<string, string>>()
const subscriptions = new Map<string, Set<FakeRedis>>()
const publishCalls: Array<{ channel: string; message: string }> = []

class FakeRedis {
  status = 'wait'
  handlers = new Map<string, Handler[]>()
  connect = mock(async () => {
    this.status = 'ready'
    this.emit('ready')
  })
  disconnect = mock(() => {
    this.status = 'end'
    this.emit('end')
  })
  subscribe = mock(async (channel: string) => {
    if (!subscriptions.has(channel)) subscriptions.set(channel, new Set())
    subscriptions.get(channel)!.add(this)
  })
  unsubscribe = mock(async () => {})
  ping = mock(async () => 'PONG')
  set = mock(async (key: string, value: string) => {
    kv.set(key, value)
  })
  get = mock(async (key: string) => kv.get(key) ?? null)
  del = mock(async (key: string) => {
    kv.delete(key)
  })
  expire = mock(async () => 1)
  hset = mock(async (key: string, field: string, value: string) => {
    const existing = hashes.get(key) ?? {}
    existing[field] = value
    hashes.set(key, existing)
  })
  hgetall = mock(async (key: string) => hashes.get(key) ?? {})
  publish = mock(async (channel: string, message: string) => {
    publishCalls.push({ channel, message })
    const parsed = JSON.parse(message)

    if (channel === 'tunnel:pod:other-pod:request' && parsed.request) {
      queueMicrotask(() => {
        this.publish(`tunnel:pod:${parsed.replyPod}:request`, JSON.stringify({
          relayId: parsed.relayId,
          response: { type: 'response', requestId: parsed.request.requestId, status: 202, body: 'remote-ok' },
        }))
      })
    }

    if (channel === 'tunnel:pod:other-pod:stream-request' && parsed.request) {
      queueMicrotask(() => {
        this.publish(`tunnel:pod:${parsed.replyPod}:stream-request`, JSON.stringify({
          relayId: parsed.relayId,
          chunk: { type: 'stream-chunk', requestId: parsed.request.requestId, data: 'remote-chunk' },
        }))
        this.publish(`tunnel:pod:${parsed.replyPod}:stream-request`, JSON.stringify({
          relayId: parsed.relayId,
          chunk: { type: 'stream-end', requestId: parsed.request.requestId },
        }))
      })
    }

    for (const subscriber of subscriptions.get(channel) ?? []) {
      for (const handler of subscriber.handlers.get('message') ?? []) {
        queueMicrotask(() => handler(channel, message))
      }
    }
    return 1
  })

  constructor(public url: string, public options: any) {
    redisInstances.push(this)
  }

  on(event: string, handler: Handler) {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return this
  }

  emit(event: string, ...args: any[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args)
  }
}

mock.module('ioredis', () => ({
  default: FakeRedis,
}))

const tunnelRedis = await import('../lib/tunnel-redis')

beforeAll(async () => {
  await tunnelRedis.initTunnelRedis()
})

beforeEach(() => {
  kv.clear()
  hashes.clear()
  publishCalls.length = 0
  for (const client of redisInstances) {
    client.status = 'ready'
    client.expire.mockClear()
    client.publish.mockClear()
  }
})

describe('tunnel redis cross-pod helpers', () => {
  test('initializes pub/sub clients, reports health, and tracks degraded lifecycle state', async () => {
    expect(redisInstances).toHaveLength(2)
    expect(redisInstances[1].subscribe).toHaveBeenCalledWith('tunnel:pod:pod-a:request')
    expect(redisInstances[1].subscribe).toHaveBeenCalledWith('tunnel:pod:pod-a:stream-request')

    await expect(tunnelRedis.checkRedisHealth()).resolves.toMatchObject({ healthy: true })
    expect(tunnelRedis.isTunnelRedisDegraded()).toBe(false)

    redisInstances[0].status = 'close'
    redisInstances[0].emit('close')
    expect(tunnelRedis.isTunnelRedisDegraded()).toBe(true)

    redisInstances[0].status = 'ready'
    redisInstances[1].status = 'ready'
    redisInstances[1].emit('ready')
    expect(tunnelRedis.isTunnelRedisDegraded()).toBe(false)
  })

  test('registers, refreshes, reads, evicts, and unregisters tunnel ownership', async () => {
    await tunnelRedis.registerTunnelOwnership('inst-1')
    expect(kv.get('tunnel:inst-1:pod')).toBe('pod-a')

    await tunnelRedis.refreshTunnelOwnership('inst-1')
    expect(redisInstances[0].expire).toHaveBeenCalledWith('tunnel:inst-1:pod', 600)
    await expect(tunnelRedis.getTunnelOwner('inst-1')).resolves.toBe('pod-a')
    await expect(tunnelRedis.isTunnelConnectedAnywhere('inst-1')).resolves.toBe(true)

    await tunnelRedis.unregisterTunnelOwnership('inst-1')
    expect(kv.has('tunnel:inst-1:pod')).toBe(false)

    kv.set('tunnel:inst-2:pod', 'other-pod')
    await tunnelRedis.unregisterTunnelOwnership('inst-2')
    expect(kv.get('tunnel:inst-2:pod')).toBe('other-pod')

    await tunnelRedis.evictTunnelOwnership('inst-2')
    expect(kv.has('tunnel:inst-2:pod')).toBe(false)
  })

  test('relays normal requests to remote pods and handles incoming local relay requests', async () => {
    const remote = await tunnelRedis.relayTunnelRequest('other-pod', 'inst-1', {
      type: 'request',
      requestId: 'req-1',
      method: 'POST',
      path: '/api/test',
      body: 'body',
    })
    expect(remote).toMatchObject({ status: 202, body: 'remote-ok' })

    tunnelRedis.setLocalTunnelHandlers(
      async (_instanceId, req) => ({ type: 'response', requestId: req.requestId, status: 204, body: 'local-ok' }),
      () => ({ cancel: () => {} }),
    )
    await redisInstances[0].publish('tunnel:pod:pod-a:request', JSON.stringify({
      relayId: 'local-relay',
      instanceId: 'inst-local',
      replyPod: 'other-pod',
      request: { type: 'request', requestId: 'local-req', method: 'GET', path: '/' },
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const reply = publishCalls.find((call) => call.channel === 'tunnel:pod:other-pod:request' && call.message.includes('local-ok'))
    expect(reply).toBeDefined()
  })

  test('verifies pod liveness locally, via remote relay response, timeout, and incoming probe replies', async () => {
    await expect(tunnelRedis.verifyPodAlive('pod-a')).resolves.toBe(true)
    await expect(tunnelRedis.verifyPodAlive('other-pod', 50)).resolves.toBe(true)
    await expect(tunnelRedis.verifyPodAlive('missing-pod', 1)).resolves.toBe(false)

    await redisInstances[0].publish('tunnel:pod:pod-a:request', JSON.stringify({
      relayId: 'probe-local',
      instanceId: '__probe__',
      replyPod: 'other-pod',
      request: { type: 'request', requestId: 'probe-local', method: 'GET', path: '/__probe__' },
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const probeReply = publishCalls.find((call) => call.channel === 'tunnel:pod:other-pod:request' && call.message.includes('probe-local'))
    expect(probeReply).toBeDefined()
    expect(JSON.parse(probeReply!.message).response.status).toBe(200)
  })

  test('publishes local relay errors and local stream relay chunks', async () => {
    tunnelRedis.setLocalTunnelHandlers(
      async () => { throw new Error('local failed') },
      (_instanceId, req, onChunk) => {
        onChunk({ type: 'stream-chunk', requestId: req.requestId, data: 'local-stream' })
        onChunk({ type: 'stream-end', requestId: req.requestId })
        return { cancel: () => {} }
      },
    )

    await redisInstances[0].publish('tunnel:pod:pod-a:request', JSON.stringify({
      relayId: 'local-error',
      instanceId: 'inst-local',
      replyPod: 'other-pod',
      request: { type: 'request', requestId: 'local-error-req', method: 'GET', path: '/' },
    }))

    await redisInstances[0].publish('tunnel:pod:pod-a:stream-request', JSON.stringify({
      relayId: 'local-stream',
      instanceId: 'inst-local',
      replyPod: 'other-pod',
      request: { type: 'request', requestId: 'local-stream-req', method: 'GET', path: '/stream' },
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const errorReply = publishCalls.find((call) => call.channel === 'tunnel:pod:other-pod:request' && call.message.includes('local failed'))
    expect(errorReply).toBeDefined()

    const streamReplies = publishCalls.filter((call) => call.channel === 'tunnel:pod:other-pod:stream-request' && call.message.includes('local-stream'))
    expect(streamReplies).toHaveLength(2)
    expect(JSON.parse(streamReplies[0].message).chunk).toEqual({
      type: 'stream-chunk',
      requestId: 'local-stream-req',
      data: 'local-stream',
    })
    expect(JSON.parse(streamReplies[1].message).chunk).toEqual({
      type: 'stream-end',
      requestId: 'local-stream-req',
    })
  })

  test('relays stream chunks and supports cancellation before publish', async () => {
    const chunks: any[] = []
    tunnelRedis.relayTunnelStreamRequest('other-pod', 'inst-1', {
      type: 'request',
      requestId: 'stream-1',
      method: 'GET',
      path: '/stream',
    }, (chunk) => chunks.push(chunk))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(chunks).toEqual([
      { type: 'stream-chunk', requestId: 'stream-1', data: 'remote-chunk' },
      { type: 'stream-end', requestId: 'stream-1' },
    ])

    const cancelled = tunnelRedis.relayTunnelStreamRequest('other-pod', 'inst-1', {
      type: 'request',
      requestId: 'stream-cancel',
      method: 'GET',
      path: '/stream',
    }, (chunk) => chunks.push(chunk))
    cancelled.cancel()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(publishCalls.some((call) => call.message.includes('stream-cancel'))).toBe(false)
  })

  test('tracks viewers and filters active controllers', async () => {
    await tunnelRedis.markViewerActiveRedis('ws-1')
    await expect(tunnelRedis.isViewerActiveRedis('ws-1')).resolves.toBe(true)

    await tunnelRedis.markControllerActiveRedis('inst-1', 'user-1', 'session-1')
    hashes.set('ctrl:inst-1', {
      ...hashes.get('ctrl:inst-1'),
      stale: JSON.stringify({ userId: 'old', lastSeenAt: Date.now() - 120_000 }),
      invalid: 'not json',
    })

    await expect(tunnelRedis.getActiveControllersRedis('inst-1')).resolves.toEqual([
      expect.objectContaining({ userId: 'user-1', sessionId: 'session-1' }),
    ])
  })

  test('shutdown disconnects clients and allows later health checks to fail closed', async () => {
    await tunnelRedis.shutdownTunnelRedis()

    expect(redisInstances[1].unsubscribe).toHaveBeenCalled()
    expect(redisInstances[0].disconnect).toHaveBeenCalled()
    await expect(tunnelRedis.checkRedisHealth()).resolves.toMatchObject({
      healthy: false,
      error: 'Redis subscriber not ready (status=end)',
    })

    await tunnelRedis.initTunnelRedis()
  })
})
