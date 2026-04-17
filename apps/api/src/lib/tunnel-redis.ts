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

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'
const REDIS_URL = process.env.REDIS_URL || 'redis://redis-master:6379'
const POD_ID = process.env.HOSTNAME || crypto.randomUUID()

const TUNNEL_OWNERSHIP_TTL = 600 // 10 min, refreshed by heartbeat
const VIEWER_TTL = 120 // 2 min
const CONTROLLER_TTL = 60 // 1 min
const RELAY_TIMEOUT_MS = 30_000
const STREAM_RELAY_TIMEOUT_MS = 600_000 // 10 min max for streaming
// One bounded re-read in getTunnelOwner to absorb the cold-start gap on
// sibling pods. Keep it small — this delays 503s, not real traffic.
const GET_TUNNEL_OWNER_RETRY_MS = 100

let pub: Redis | null = null
let sub: Redis | null = null
let initialized = false
// `degraded` is true when init completed but the Redis client could not
// be established (non-local mode only). /health uses this to fail the
// readiness probe so misrouted pods drain out of the LB rotation.
let degraded = false
// Memoized init promise. Callers that need Redis to be ready (e.g.
// registerTunnelOwnership when a WS auths) can `await whenReady()` to
// avoid the classic race where ownership is written into a null publisher
// and silently dropped — which made other pods return 503 until the next
// WS reconnect.
let initPromise: Promise<void> | null = null

// ─── Initialization ─────────────────────────────────────────────────────────

export function getPodId(): string {
  return POD_ID
}

export function whenReady(): Promise<void> {
  if (initialized) return Promise.resolve()
  return initPromise ?? initTunnelRedis()
}

export async function initTunnelRedis(): Promise<void> {
  if (initialized) return
  if (initPromise) return initPromise
  initPromise = _doInit()
  try {
    await initPromise
  } catch (err) {
    // Only clear the memo on failure so a later call can retry. On success
    // the `initialized` flag takes over and initPromise can stay in place
    // (cheap, and avoids a retry race if someone calls init twice in
    // quick succession).
    initPromise = null
    throw err
  }
}

/**
 * True when init ran but we have no Redis client (non-local mode),
 * OR we had a client but it has since disconnected and failed to
 * recover. Used by /health to mark the pod not-ready so the LB drains
 * it instead of letting it serve silent 503s on cross-pod relays.
 */
export function isTunnelRedisDegraded(): boolean {
  if (isLocalMode) return false
  if (degraded) return true
  // Post-init disconnect detection. ioredis's `.status` is the authoritative
  // view of whether the connection is usable — a non-ready publisher or
  // subscriber means cross-pod routing is broken on this pod.
  if (initialized) {
    if (!pub || !sub) return true
    if (pub.status !== 'ready' || sub.status !== 'ready') return true
  }
  return false
}

// ─── Connection lifecycle ───────────────────────────────────────────────────
//
// ioredis will reconnect automatically up to the `retryStrategy` ceiling,
// but once it gives up (or mid-retry) every command is rejected while
// `initialized` stays true. Without these listeners the pod would happily
// report /health=200 and serve silent 503s on every relay. The handlers
// flip `degraded` so /health fails readiness until the client reports
// 'ready' again.

function attachLifecycleListeners(client: Redis, label: 'publisher' | 'subscriber'): void {
  client.on('error', (err) => {
    console.error(`[TunnelRedis] ${label} error:`, err.message)
  })
  client.on('end', () => {
    // 'end' fires when the client has given up reconnecting. This is the
    // state we most care about — cross-pod tunnel routing is dead on this
    // pod until we restart or the client manages to reconnect.
    degraded = true
    console.error(
      `[TunnelRedis] ❌ ${label} connection ended — marking pod degraded. ` +
      `/health will return 503 to drain this pod from the LB rotation.`,
    )
  })
  client.on('close', () => {
    degraded = true
    console.warn(`[TunnelRedis] ${label} connection closed — pod degraded until reconnect`)
  })
  client.on('reconnecting', (delay: number) => {
    degraded = true
    console.warn(`[TunnelRedis] ${label} reconnecting in ${delay}ms`)
  })
  client.on('ready', () => {
    // Only clear `degraded` when both clients are actually ready.
    if (pub?.status === 'ready' && sub?.status === 'ready') {
      if (degraded) {
        console.log('[TunnelRedis] ✅ Both pub/sub ready — clearing degraded flag')
      }
      degraded = false
    }
  })
}

async function _doInit(): Promise<void> {
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
    attachLifecycleListeners(pub, 'publisher')

    sub = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      connectTimeout: 5000,
      lazyConnect: true,
      retryStrategy(times) {
        if (times > 5) return null
        return Math.min(times * 500, 3000)
      },
    })
    attachLifecycleListeners(sub, 'subscriber')

    await Promise.all([pub.connect(), sub.connect()])

    await sub.subscribe(`tunnel:pod:${POD_ID}:request`)
    await sub.subscribe(`tunnel:pod:${POD_ID}:stream-request`)

    sub.on('message', handleSubMessage)

    console.log(`[TunnelRedis] Initialized (pod=${POD_ID})`)
  } catch (err) {
    // In multi-pod deployments this is a correctness bug, not a warning:
    // cross-pod tunnel routing is silently disabled. Log loudly so it
    // surfaces in dashboards, and flip `degraded` so /health fails the
    // readiness probe and Knative/K8s drains the pod instead of quietly
    // serving 503s.
    console.error(
      `[TunnelRedis] ❌ CRITICAL: Redis unreachable at ${REDIS_URL} — ` +
      `cross-pod tunnel routing is DISABLED. Remote control will return ` +
      `503 on pods that do not own the desktop WS. ` +
      `Fix: ensure Redis is deployed in this namespace or set ` +
      `SHOGO_LOCAL_MODE=true for single-pod deployments. ` +
      `Underlying error: ${(err as Error).message}`,
    )
    try { pub?.disconnect() } catch {}
    try { sub?.disconnect() } catch {}
    pub = null
    sub = null
    degraded = true
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
  if (isLocalMode) return { healthy: true, latencyMs: 0 }
  const r = getPublisher()
  if (!r) return { healthy: false, error: 'Redis publisher not initialized' }
  // The subscriber connection is what receives cross-pod relay requests,
  // so we must verify it too — a dead subscriber with a live publisher
  // would still silently drop every sibling-pod request while /health
  // reported green.
  if (!sub || sub.status !== 'ready') {
    return { healthy: false, error: `Redis subscriber not ready (status=${sub?.status ?? 'null'})` }
  }
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
  // Wait for Redis init to complete before writing ownership. Without this,
  // a desktop WS that auths during the first ~500ms of pod startup would
  // silently skip registration (pub=null) and other pods would 503 on
  // remote-control requests until the desktop reconnected.
  await whenReady()
  const r = getPublisher()
  if (!r) return
  await r.set(`tunnel:${instanceId}:pod`, POD_ID, 'EX', TUNNEL_OWNERSHIP_TTL)
}

export async function unregisterTunnelOwnership(instanceId: string): Promise<void> {
  await whenReady()
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
  await whenReady()
  const r = getPublisher()
  if (!r) return
  await r.del(`tunnel:${instanceId}:pod`)
}

export async function refreshTunnelOwnership(instanceId: string): Promise<void> {
  await whenReady()
  const r = getPublisher()
  if (!r) return
  await r.expire(`tunnel:${instanceId}:pod`, TUNNEL_OWNERSHIP_TTL)
}

/**
 * Look up the pod currently owning a tunnel, with a single bounded retry.
 *
 * The retry absorbs the narrow window where a desktop has just connected
 * on another pod and its `registerTunnelOwnership` write hasn't yet landed
 * in Redis. Without it, a sibling pod hitting that 5–50ms gap would see
 * null and return 503 even though the tunnel is healthy.
 */
export async function getTunnelOwner(instanceId: string): Promise<string | null> {
  await whenReady()
  const r = getPublisher()
  if (!r) return null

  const read = async (): Promise<string | null> => {
    try {
      return await r.get(`tunnel:${instanceId}:pod`)
    } catch (err) {
      console.warn(`[TunnelRedis] getTunnelOwner failed for ${instanceId}:`, (err as Error).message)
      return null
    }
  }

  const first = await read()
  if (first) return first
  // Bounded retry: one re-read after GET_TUNNEL_OWNER_RETRY_MS to absorb
  // the sub-100ms cold-start gap on a sibling pod.
  await new Promise((r) => setTimeout(r, GET_TUNNEL_OWNER_RETRY_MS))
  return read()
}

/**
 * Verify that a tunnel-owning pod is actually alive by publishing a ping
 * and waiting for a pong response within a short timeout. Returns true if
 * the pod responds, false otherwise.
 */
export async function verifyPodAlive(podId: string, timeoutMs = 3000): Promise<boolean> {
  const r = getPublisher()
  if (!r) return false
  if (podId === POD_ID) return true

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
    r.publish(`tunnel:pod:${podId}:request`, JSON.stringify(msg)).catch(() => {
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
  ownerPod: string,
  instanceId: string,
  request: RelayRequest['request'],
): Promise<RelayResponse['response']> {
  await whenReady()
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
  // Signature is sync for back-compat with callers — but we need init to
  // be done before publishing. Fire the whenReady gate and let the publish
  // happen inside its .then to keep the race closed without changing the
  // return type.
  let cancelled = false
  let activeTimeout: ReturnType<typeof setTimeout> | null = null
  let activeRelayId: string | null = null
  whenReady().then(() => {
    if (cancelled) return
    const r = getPublisher()
    if (!r) {
      onChunk({ type: 'stream-error', requestId: request.requestId, error: 'Redis not initialized' })
      return
    }
    activeRelayId = `relay_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    activeTimeout = setTimeout(() => {
      pendingStreamRelays.delete(activeRelayId!)
      onChunk({ type: 'stream-error', requestId: request.requestId, error: 'Cross-pod stream relay timed out' })
    }, STREAM_RELAY_TIMEOUT_MS)
    pendingStreamRelays.set(activeRelayId, { onChunk, timeout: activeTimeout })
    const msg: StreamRelayRequest = { relayId: activeRelayId, instanceId, replyPod: POD_ID, request }
    r.publish(`tunnel:pod:${ownerPod}:stream-request`, JSON.stringify(msg)).catch(() => {
      if (activeTimeout) clearTimeout(activeTimeout)
      if (activeRelayId) pendingStreamRelays.delete(activeRelayId)
      onChunk({ type: 'stream-error', requestId: request.requestId, error: 'Failed to publish relay request' })
    })
  })
  return {
    cancel: () => {
      cancelled = true
      if (activeTimeout) clearTimeout(activeTimeout)
      if (activeRelayId) pendingStreamRelays.delete(activeRelayId)
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
  try {
    const ts = await r.get(`viewer:${workspaceId}`)
    return ts !== null
  } catch (err) {
    console.warn('[TunnelRedis] isViewerActiveRedis failed:', (err as Error).message)
    return false
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
