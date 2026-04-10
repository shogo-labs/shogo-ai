// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tunnel Redis Layer
 *
 * Provides cross-pod tunnel routing using Redis. In a multi-pod K8s
 * deployment, the WebSocket for a given instance lands on one pod but
 * HTTP proxy requests can arrive at any pod. This module:
 *
 * 1. Registers tunnel ownership (instanceId → podId) in Redis
 * 2. Relays proxy requests to the owning pod via Redis pub/sub
 * 3. Stores activeViewers and activeControllers in Redis for cross-pod visibility
 */

import Redis from 'ioredis'

const REDIS_URL = process.env.REDIS_URL || 'redis://redis-master:6379'
const POD_ID = process.env.HOSTNAME || crypto.randomUUID()

const TUNNEL_OWNERSHIP_TTL = 600 // 10 min, refreshed by heartbeat
const VIEWER_TTL = 120 // 2 min
const CONTROLLER_TTL = 60 // 1 min
const RELAY_TIMEOUT_MS = 30_000
const STREAM_RELAY_TIMEOUT_MS = 600_000 // 10 min max for streaming

let pub: Redis | null = null
let sub: Redis | null = null
let initialized = false

// ─── Initialization ─────────────────────────────────────────────────────────

export function getPodId(): string {
  return POD_ID
}

export async function initTunnelRedis(): Promise<void> {
  if (initialized) return

  pub = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    connectTimeout: 5000,
    lazyConnect: true,
    retryStrategy(times) {
      if (times > 5) return null
      return Math.min(times * 500, 3000)
    },
  })
  pub.on('error', (err) => {
    console.error('[TunnelRedis] Publisher error:', err.message)
  })

  sub = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    connectTimeout: 5000,
    lazyConnect: true,
    retryStrategy(times) {
      if (times > 5) return null
      return Math.min(times * 500, 3000)
    },
  })
  sub.on('error', (err) => {
    console.error('[TunnelRedis] Subscriber error:', err.message)
  })

  await Promise.all([pub.connect(), sub.connect()])

  await sub.subscribe(`tunnel:pod:${POD_ID}:request`)
  await sub.subscribe(`tunnel:pod:${POD_ID}:stream-request`)

  sub.on('message', handleSubMessage)

  initialized = true
  console.log(`[TunnelRedis] Initialized (pod=${POD_ID})`)
}

export async function shutdownTunnelRedis(): Promise<void> {
  if (!initialized) return
  try {
    if (sub) {
      await sub.unsubscribe()
      sub.disconnect()
    }
    if (pub) {
      pub.disconnect()
    }
  } catch {}
  initialized = false
}

function getPublisher(): Redis | null {
  return pub
}

// ─── Tunnel Ownership ───────────────────────────────────────────────────────

export async function registerTunnelOwnership(instanceId: string): Promise<void> {
  const r = getPublisher()
  if (!r) return
  await r.set(`tunnel:${instanceId}:pod`, POD_ID, 'EX', TUNNEL_OWNERSHIP_TTL)
}

export async function unregisterTunnelOwnership(instanceId: string): Promise<void> {
  const r = getPublisher()
  if (!r) return
  const owner = await r.get(`tunnel:${instanceId}:pod`)
  if (owner === POD_ID) {
    await r.del(`tunnel:${instanceId}:pod`)
  }
}

export async function refreshTunnelOwnership(instanceId: string): Promise<void> {
  const r = getPublisher()
  if (!r) return
  await r.expire(`tunnel:${instanceId}:pod`, TUNNEL_OWNERSHIP_TTL)
}

export async function getTunnelOwner(instanceId: string): Promise<string | null> {
  const r = getPublisher()
  if (!r) return null
  return r.get(`tunnel:${instanceId}:pod`)
}

// ─── Cross-Pod Request Relay ────────────────────────────────────────────────

interface RelayRequest {
  relayId: string
  instanceId: string
  replyPod: string
  request: {
    type: 'request'
    requestId: string
    method: string
    path: string
    headers?: Record<string, string>
    body?: string
  }
}

interface RelayResponse {
  relayId: string
  response?: {
    type: 'response'
    requestId: string
    status: number
    headers?: Record<string, string>
    body?: string
  }
  error?: string
}

interface StreamRelayRequest {
  relayId: string
  instanceId: string
  replyPod: string
  request: {
    type: 'request'
    requestId: string
    method: string
    path: string
    headers?: Record<string, string>
    body?: string
  }
}

interface StreamRelayChunk {
  relayId: string
  chunk: {
    type: 'stream-chunk' | 'stream-end' | 'stream-error'
    requestId: string
    data?: string
    error?: string
  }
}

type LocalTunnelSendFn = (
  instanceId: string,
  req: RelayRequest['request'],
) => Promise<RelayResponse['response']>

type LocalTunnelStreamFn = (
  instanceId: string,
  req: StreamRelayRequest['request'],
  onChunk: (chunk: StreamRelayChunk['chunk']) => void,
) => { cancel: () => void }

let localSendFn: LocalTunnelSendFn | null = null
let localStreamFn: LocalTunnelStreamFn | null = null

export function setLocalTunnelHandlers(
  send: LocalTunnelSendFn,
  stream: LocalTunnelStreamFn,
): void {
  localSendFn = send
  localStreamFn = stream
}

const pendingRelayResponses = new Map<string, {
  resolve: (value: RelayResponse) => void
  reject: (reason: Error) => void
  timeout: ReturnType<typeof setTimeout>
}>()

const pendingStreamRelays = new Map<string, {
  onChunk: (chunk: StreamRelayChunk['chunk']) => void
  timeout: ReturnType<typeof setTimeout>
}>()

function handleSubMessage(channel: string, message: string) {
  try {
    if (channel === `tunnel:pod:${POD_ID}:request`) {
      const msg = JSON.parse(message) as RelayRequest | RelayResponse

      if ('request' in msg && 'replyPod' in msg) {
        handleIncomingRelayRequest(msg as RelayRequest)
      } else if ('relayId' in msg && ('response' in msg || 'error' in msg)) {
        handleIncomingRelayResponse(msg as RelayResponse)
      }
    } else if (channel === `tunnel:pod:${POD_ID}:stream-request`) {
      const msg = JSON.parse(message) as StreamRelayRequest | StreamRelayChunk

      if ('request' in msg && 'replyPod' in msg) {
        handleIncomingStreamRelayRequest(msg as StreamRelayRequest)
      } else if ('chunk' in msg) {
        handleIncomingStreamRelayChunk(msg as StreamRelayChunk)
      }
    }
  } catch (err) {
    console.error('[TunnelRedis] Error handling message:', (err as Error).message)
  }
}

async function handleIncomingRelayRequest(msg: RelayRequest) {
  if (!localSendFn) return

  try {
    const response = await localSendFn(msg.instanceId, msg.request)
    const reply: RelayResponse = { relayId: msg.relayId, response: response ?? undefined }
    const r = getPublisher()
    if (r) {
      await r.publish(`tunnel:pod:${msg.replyPod}:request`, JSON.stringify(reply))
    }
  } catch (err) {
    const reply: RelayResponse = { relayId: msg.relayId, error: (err as Error).message }
    const r = getPublisher()
    if (r) {
      await r.publish(`tunnel:pod:${msg.replyPod}:request`, JSON.stringify(reply))
    }
  }
}

function handleIncomingRelayResponse(msg: RelayResponse) {
  const pending = pendingRelayResponses.get(msg.relayId)
  if (!pending) return

  clearTimeout(pending.timeout)
  pendingRelayResponses.delete(msg.relayId)

  if (msg.error) {
    pending.reject(new Error(msg.error))
  } else {
    pending.resolve(msg)
  }
}

async function handleIncomingStreamRelayRequest(msg: StreamRelayRequest) {
  if (!localStreamFn) return

  localStreamFn(msg.instanceId, msg.request, (chunk) => {
    const reply: StreamRelayChunk = { relayId: msg.relayId, chunk }
    const r = getPublisher()
    if (r) {
      r.publish(`tunnel:pod:${msg.replyPod}:stream-request`, JSON.stringify(reply)).catch(() => {})
    }
  })
}

function handleIncomingStreamRelayChunk(msg: StreamRelayChunk) {
  const pending = pendingStreamRelays.get(msg.relayId)
  if (!pending) return

  if (msg.chunk.type === 'stream-end' || msg.chunk.type === 'stream-error') {
    clearTimeout(pending.timeout)
    pendingStreamRelays.delete(msg.relayId)
  }

  pending.onChunk(msg.chunk)
}

export async function relayTunnelRequest(
  ownerPod: string,
  instanceId: string,
  request: RelayRequest['request'],
): Promise<RelayResponse['response']> {
  const r = getPublisher()
  if (!r) throw new Error('Redis not initialized')

  const relayId = `relay_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRelayResponses.delete(relayId)
      reject(new Error('Cross-pod relay timed out'))
    }, RELAY_TIMEOUT_MS)

    pendingRelayResponses.set(relayId, { resolve, reject, timeout })

    const msg: RelayRequest = { relayId, instanceId, replyPod: POD_ID, request }
    r.publish(`tunnel:pod:${ownerPod}:request`, JSON.stringify(msg)).catch((err) => {
      clearTimeout(timeout)
      pendingRelayResponses.delete(relayId)
      reject(err)
    })
  }).then((resp) => (resp as RelayResponse).response)
}

export function relayTunnelStreamRequest(
  ownerPod: string,
  instanceId: string,
  request: StreamRelayRequest['request'],
  onChunk: (chunk: StreamRelayChunk['chunk']) => void,
): { cancel: () => void } {
  const r = getPublisher()
  if (!r) {
    onChunk({ type: 'stream-error', requestId: request.requestId, error: 'Redis not initialized' })
    return { cancel: () => {} }
  }

  const relayId = `relay_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`

  const timeout = setTimeout(() => {
    pendingStreamRelays.delete(relayId)
    onChunk({ type: 'stream-error', requestId: request.requestId, error: 'Cross-pod stream relay timed out' })
  }, STREAM_RELAY_TIMEOUT_MS)

  pendingStreamRelays.set(relayId, { onChunk, timeout })

  const msg: StreamRelayRequest = { relayId, instanceId, replyPod: POD_ID, request }
  r.publish(`tunnel:pod:${ownerPod}:stream-request`, JSON.stringify(msg)).catch(() => {
    clearTimeout(timeout)
    pendingStreamRelays.delete(relayId)
    onChunk({ type: 'stream-error', requestId: request.requestId, error: 'Failed to publish relay request' })
  })

  return {
    cancel: () => {
      clearTimeout(timeout)
      pendingStreamRelays.delete(relayId)
    },
  }
}

// ─── Viewer Tracking (Redis-backed) ─────────────────────────────────────────

export async function markViewerActiveRedis(workspaceId: string): Promise<void> {
  const r = getPublisher()
  if (!r) return
  await r.set(`viewer:${workspaceId}`, Date.now().toString(), 'EX', VIEWER_TTL)
}

export async function isViewerActiveRedis(workspaceId: string): Promise<boolean> {
  const r = getPublisher()
  if (!r) return false
  const ts = await r.get(`viewer:${workspaceId}`)
  return ts !== null
}

// ─── Controller Tracking (Redis-backed) ─────────────────────────────────────

interface ActiveControllerData {
  userId: string
  sessionId?: string
  lastSeenAt: number
}

export async function markControllerActiveRedis(
  instanceId: string,
  userId: string,
  sessionId?: string,
): Promise<void> {
  const r = getPublisher()
  if (!r) return
  const key = sessionId || userId
  const data: ActiveControllerData = { userId, sessionId, lastSeenAt: Date.now() }
  await r.hset(`ctrl:${instanceId}`, key, JSON.stringify(data))
  await r.expire(`ctrl:${instanceId}`, CONTROLLER_TTL)
}

export async function getActiveControllersRedis(
  instanceId: string,
): Promise<ActiveControllerData[]> {
  const r = getPublisher()
  if (!r) return []
  const all = await r.hgetall(`ctrl:${instanceId}`)
  const now = Date.now()
  const result: ActiveControllerData[] = []
  for (const val of Object.values(all)) {
    try {
      const ctrl: ActiveControllerData = JSON.parse(val)
      if (now - ctrl.lastSeenAt < CONTROLLER_TTL * 1000) {
        result.push(ctrl)
      }
    } catch {}
  }
  return result
}

// ─── Tunnel existence check (cross-pod) ─────────────────────────────────────

export async function isTunnelConnectedAnywhere(instanceId: string): Promise<boolean> {
  const owner = await getTunnelOwner(instanceId)
  return owner !== null
}
