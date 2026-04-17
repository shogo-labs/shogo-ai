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
import {
  markViewerActiveDb,
  isViewerActiveDb,
  registerTunnelOwnershipDb,
  unregisterTunnelOwnershipDb,
  evictTunnelOwnershipDb,
  refreshTunnelOwnershipDb,
  getTunnelOwnerDb,
  verifyPodAliveDb,
  relayTunnelRequestDb,
  relayTunnelStreamRequestDb,
  type TunnelOwnerRef,
} from './tunnel-db'

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'
const REDIS_URL = process.env.REDIS_URL || 'redis://redis-master:6379'
const POD_ID = process.env.HOSTNAME || crypto.randomUUID()

/**
 * When Redis is available we use it for low-latency pub/sub relays and
 * TTL-backed tracking. When it's not (e.g. staging deployment with no
 * Redis), we transparently fall back to the Postgres + HTTP implementation
 * in `tunnel-db.ts`. Routers call the same helpers either way.
 */
function redisAvailable(): boolean {
  return pub !== null
}

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

  if (isLocalMode) {
    initialized = true
    console.log('[TunnelRedis] Skipped — local mode (single process, no cross-pod relay needed)')
    return
  }

  try {
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

    console.log(`[TunnelRedis] Initialized (pod=${POD_ID})`)
  } catch (err) {
    console.error('[TunnelRedis] Failed to connect — falling back to in-memory only:', (err as Error).message)
    try { pub?.disconnect() } catch {}
    try { sub?.disconnect() } catch {}
    pub = null
    sub = null
  }

  initialized = true
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

// ─── Health Check ────────────────────────────────────────────────────────────

export async function checkRedisHealth(): Promise<{ healthy: boolean; latencyMs?: number; error?: string }> {
  const r = getPublisher()
  if (!r) return { healthy: false, error: 'Redis not initialized' }
  const start = Date.now()
  try {
    const pong = await r.ping()
    return { healthy: pong === 'PONG', latencyMs: Date.now() - start }
  } catch (err) {
    return { healthy: false, latencyMs: Date.now() - start, error: (err as Error).message }
  }
}

// ─── Tunnel Ownership ───────────────────────────────────────────────────────

export async function registerTunnelOwnership(instanceId: string): Promise<void> {
  // Always write to Postgres — it's the durable/cross-pod source of truth
  // used for HTTP relay (it carries the pod IP) and survives a Redis outage.
  await registerTunnelOwnershipDb(instanceId)

  const r = getPublisher()
  if (!r) return
  await r.set(`tunnel:${instanceId}:pod`, POD_ID, 'EX', TUNNEL_OWNERSHIP_TTL)
}

export async function unregisterTunnelOwnership(instanceId: string): Promise<void> {
  await unregisterTunnelOwnershipDb(instanceId)

  const r = getPublisher()
  if (!r) return
  const owner = await r.get(`tunnel:${instanceId}:pod`)
  if (owner === POD_ID) {
    await r.del(`tunnel:${instanceId}:pod`)
  }
}

/**
 * Force-evict tunnel ownership regardless of which pod owns it.
 * Used when a relay to the owning pod times out, indicating the owner is dead.
 */
export async function evictTunnelOwnership(instanceId: string): Promise<void> {
  await evictTunnelOwnershipDb(instanceId)

  const r = getPublisher()
  if (!r) return
  await r.del(`tunnel:${instanceId}:pod`)
}

export async function refreshTunnelOwnership(instanceId: string): Promise<void> {
  await refreshTunnelOwnershipDb(instanceId)

  const r = getPublisher()
  if (!r) return
  await r.expire(`tunnel:${instanceId}:pod`, TUNNEL_OWNERSHIP_TTL)
}

export interface TunnelOwnerInfo {
  podId: string
  podIp: string
}

/**
 * Returns the pod currently owning the tunnel for `instanceId`, or null.
 * We always read from Postgres because that's what carries the pod IP we
 * need for HTTP relay. The Redis `tunnel:*:pod` key is kept only as a
 * warm cache / cross-check when Redis is available.
 */
export async function getTunnelOwner(instanceId: string): Promise<TunnelOwnerInfo | null> {
  return await getTunnelOwnerDb(instanceId)
}

/**
 * Verify that a tunnel-owning pod is actually alive.
 *
 * Redis mode → pub/sub ping/pong (same pod used for relay).
 * DB mode   → HTTP GET to the pod's `/api/internal/tunnel-alive` endpoint.
 */
export async function verifyPodAlive(owner: TunnelOwnerInfo, timeoutMs = 3000): Promise<boolean> {
  if (owner.podId === POD_ID) return true

  if (!redisAvailable()) {
    return await verifyPodAliveDb(owner.podIp)
  }

  const r = getPublisher()
  if (!r) return false

  const probeId = `probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingRelayResponses.delete(probeId)
      resolve(false)
    }, timeoutMs)

    pendingRelayResponses.set(probeId, {
      resolve: () => {
        clearTimeout(timer)
        pendingRelayResponses.delete(probeId)
        resolve(true)
      },
      reject: () => {
        clearTimeout(timer)
        pendingRelayResponses.delete(probeId)
        resolve(false)
      },
      timeout: timer,
    })

    const msg: RelayRequest = {
      relayId: probeId,
      instanceId: '__probe__',
      replyPod: POD_ID,
      request: { type: 'request', requestId: probeId, method: 'GET', path: '/__probe__' },
    }
    r.publish(`tunnel:pod:${owner.podId}:request`, JSON.stringify(msg)).catch(() => {
      clearTimeout(timer)
      pendingRelayResponses.delete(probeId)
      resolve(false)
    })
  })
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

/**
 * Expose the local (this-pod) tunnel handlers to the internal HTTP relay
 * route so another pod can forward proxy traffic to us.
 */
export function getLocalTunnelHandlers(): {
  send: LocalTunnelSendFn | null
  stream: LocalTunnelStreamFn | null
} {
  return { send: localSendFn, stream: localStreamFn }
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
  // Respond to liveness probes immediately without needing a local tunnel handler
  if (msg.instanceId === '__probe__') {
    const r = getPublisher()
    if (r) {
      const reply: RelayResponse = { relayId: msg.relayId, response: { type: 'response', requestId: msg.request.requestId, status: 200 } }
      await r.publish(`tunnel:pod:${msg.replyPod}:request`, JSON.stringify(reply))
    }
    return
  }

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
  owner: TunnelOwnerInfo,
  instanceId: string,
  request: RelayRequest['request'],
): Promise<RelayResponse['response']> {
  if (!redisAvailable()) {
    return await relayTunnelRequestDb(owner as TunnelOwnerRef, instanceId, request)
  }

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
    r.publish(`tunnel:pod:${owner.podId}:request`, JSON.stringify(msg)).catch((err) => {
      clearTimeout(timeout)
      pendingRelayResponses.delete(relayId)
      reject(err)
    })
  }).then((resp) => (resp as RelayResponse).response)
}

export function relayTunnelStreamRequest(
  owner: TunnelOwnerInfo,
  instanceId: string,
  request: StreamRelayRequest['request'],
  onChunk: (chunk: StreamRelayChunk['chunk']) => void,
): { cancel: () => void } {
  if (!redisAvailable()) {
    return relayTunnelStreamRequestDb(owner as TunnelOwnerRef, instanceId, request, onChunk)
  }

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
  r.publish(`tunnel:pod:${owner.podId}:stream-request`, JSON.stringify(msg)).catch(() => {
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

// ─── Viewer Tracking (Redis-preferred, DB fallback) ─────────────────────────

export async function markViewerActiveRedis(workspaceId: string): Promise<void> {
  const r = getPublisher()
  if (!r) {
    await markViewerActiveDb(workspaceId)
    return
  }
  await r.set(`viewer:${workspaceId}`, Date.now().toString(), 'EX', VIEWER_TTL)
  // Also mirror to Postgres so an out-of-order heartbeat hitting a pod that
  // briefly lost Redis still sees the viewer as active.
  markViewerActiveDb(workspaceId).catch(() => {})
}

export async function isViewerActiveRedis(workspaceId: string): Promise<boolean> {
  const r = getPublisher()
  if (!r) return await isViewerActiveDb(workspaceId)
  try {
    const ts = await r.get(`viewer:${workspaceId}`)
    if (ts !== null) return true
    // Redis may have expired but DB still has a fresh viewer (e.g. keepalive
    // landed on a different pod that wrote Postgres only).
    return await isViewerActiveDb(workspaceId)
  } catch (err) {
    console.warn('[TunnelRedis] isViewerActiveRedis failed:', (err as Error).message)
    return await isViewerActiveDb(workspaceId)
  }
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
  try {
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
  } catch (err) {
    console.warn('[TunnelRedis] getActiveControllersRedis failed:', (err as Error).message)
    return []
  }
}

// ─── Tunnel existence check (cross-pod) ─────────────────────────────────────

export async function isTunnelConnectedAnywhere(instanceId: string): Promise<boolean> {
  try {
    const owner = await getTunnelOwner(instanceId)
    return owner !== null
  } catch (err) {
    console.warn('[TunnelRedis] isTunnelConnectedAnywhere failed:', (err as Error).message)
    return false
  }
}
