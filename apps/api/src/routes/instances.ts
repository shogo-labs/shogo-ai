// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Remote Control — Instance Registry & Tunnel Proxy
 *
 * Enables cloud users to see and control their local Shogo instances.
 * Local instances poll via HTTP heartbeat; the cloud signals them to
 * open an on-demand WebSocket when a user needs interactive control.
 *
 * Endpoints:
 * - POST /api/instances/heartbeat         — Heartbeat from local instance (API key auth)
 * - POST /api/instances/viewer-active     — Signal that a user is viewing Remote Control
 * - POST /api/instances/:id/request-connect — Request an instance to open its WebSocket tunnel
 * - GET  /api/instances/ws                — WebSocket upgrade (API key auth from local instance)
 * - GET  /api/instances                   — List instances for workspace (session auth)
 * - GET  /api/instances/:id               — Instance details (session auth)
 * - PUT  /api/instances/:id               — Update instance name (session auth)
 * - DELETE /api/instances/:id             — Remove instance from registry (session auth)
 * - POST /api/instances/:id/proxy         — Proxy a request to local instance via tunnel
 * - POST /api/instances/:id/proxy/stream  — Proxy a streaming request via tunnel
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { resolveApiKey } from './api-keys'
import { logRemoteAction, classifyAction } from './remote-audit'
import {
  initTunnelRedis,
  registerTunnelOwnership,
  unregisterTunnelOwnership,
  evictTunnelOwnership,
  refreshTunnelOwnership,
  getTunnelOwner,
  relayTunnelRequest,
  relayTunnelStreamRequest,
  setLocalTunnelHandlers,
  markViewerActiveRedis,
  isViewerActiveRedis,
  markControllerActiveRedis,
  getActiveControllersRedis,
  isTunnelConnectedAnywhere,
  getPodId,
  verifyPodAlive,
} from '../lib/tunnel-redis'
import { sendPushToInstance } from '../lib/push-notifications'

// ─── Constants ───────────────────────────────────────────────────────────────

const POLL_INTERVAL_IDLE_S = 60
const POLL_INTERVAL_VIEWER_S = 5
const POLL_INTERVAL_WS_REQUESTED_S = 3
const WS_REQUEST_TTL_MS = 2 * 60 * 1000
const VIEWER_ACTIVE_TTL_MS = 2 * 60 * 1000
const PROXY_TIMEOUT_MS = 30_000
const STREAM_FIRST_CHUNK_TIMEOUT_MS = 90_000
const STREAM_IDLE_TIMEOUT_MS = 30_000
const STREAM_MAX_TIMEOUT_MS = 600_000
const HEARTBEAT_INTERVAL_MS = 25_000
const TUNNEL_WAIT_TIMEOUT_MS = 10_000
const TUNNEL_WAIT_POLL_MS = 500
const STREAMING_POST_PATTERNS = ['/agent/chat', '/agent/logs/stream']
const STREAMING_GET_PATTERNS = ['/agent/canvas/stream', '/agent/logs/stream']
const CHAT_RESUME_STREAM_RE = /^\/agent\/chat\/[^/]+\/stream$/

// ─── Viewer tracking (Redis-primary, in-memory fallback) ────────────────────

const activeViewers = new Map<string, number>()

export async function isViewerActive(workspaceId: string): Promise<boolean> {
  const redisResult = await isViewerActiveRedis(workspaceId)
  if (redisResult) return true

  const ts = activeViewers.get(workspaceId)
  if (!ts) return false
  if (Date.now() - ts > VIEWER_ACTIVE_TTL_MS) {
    activeViewers.delete(workspaceId)
    return false
  }
  return true
}

async function markViewerActive(workspaceId: string) {
  activeViewers.set(workspaceId, Date.now())
  await markViewerActiveRedis(workspaceId).catch((err) => {
    console.warn('[RemoteControl] markViewerActiveRedis failed:', (err as Error).message)
  })
}

// ─── Active controllers (Redis-primary, in-memory fallback) ─────────────────

interface ActiveController {
  userId: string
  sessionId?: string
  lastSeenAt: number
}

const activeControllers = new Map<string, Map<string, ActiveController>>()
const CONTROLLER_TTL_MS = 60_000

async function markControllerActive(instanceId: string, userId: string, sessionId?: string) {
  if (!activeControllers.has(instanceId)) {
    activeControllers.set(instanceId, new Map())
  }
  const key = sessionId || userId
  activeControllers.get(instanceId)!.set(key, { userId, sessionId, lastSeenAt: Date.now() })
  await markControllerActiveRedis(instanceId, userId, sessionId).catch((err) => {
    console.warn('[RemoteControl] markControllerActiveRedis failed:', (err as Error).message)
  })
}

async function getActiveControllers(instanceId: string): Promise<ActiveController[]> {
  const redisControllers = await getActiveControllersRedis(instanceId).catch(() => [])
  if (redisControllers.length > 0) return redisControllers

  const map = activeControllers.get(instanceId)
  if (!map) return []
  const now = Date.now()
  const result: ActiveController[] = []
  for (const [key, ctrl] of map) {
    if (now - ctrl.lastSeenAt > CONTROLLER_TTL_MS) {
      map.delete(key)
    } else {
      result.push(ctrl)
    }
  }
  return result
}

// ─── In-memory tunnel registry ──────────────────────────────────────────────

interface TunnelConnection {
  ws: WebSocket
  instanceId: string
  workspaceId: string
  pendingRequests: Map<string, {
    resolve: (value: TunnelResponse) => void
    reject: (reason: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }>
  streamHandlers: Map<string, (chunk: TunnelStreamChunk) => void>
}

interface TunnelRequest {
  type: 'request'
  requestId: string
  method: string
  path: string
  headers?: Record<string, string>
  body?: string
  /** From /api/projects/:id/agent-proxy/... before path normalization; desktop uses this to start the right runtime. */
  projectId?: string
}

interface TunnelResponse {
  type: 'response'
  requestId: string
  status: number
  headers?: Record<string, string>
  body?: string
}

interface TunnelStreamChunk {
  type: 'stream-chunk' | 'stream-end' | 'stream-error'
  requestId: string
  data?: string
  error?: string
}

interface TunnelHeartbeat {
  type: 'heartbeat'
  metadata?: Record<string, unknown>
}

type TunnelMessage = TunnelResponse | TunnelStreamChunk | TunnelHeartbeat | { type: 'pong' }

const tunnels = new Map<string, TunnelConnection>()

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

// ─── Adaptive poll interval ─────────────────────────────────────────────────

async function computeNextPollIn(instanceId: string, workspaceId: string, wsRequestedAt: Date | null): Promise<number> {
  if (wsRequestedAt && Date.now() - wsRequestedAt.getTime() < WS_REQUEST_TTL_MS) {
    return POLL_INTERVAL_WS_REQUESTED_S
  }
  if (await isViewerActive(workspaceId)) {
    return POLL_INTERVAL_VIEWER_S
  }
  return POLL_INTERVAL_IDLE_S
}

function isWsRequested(wsRequestedAt: Date | null): boolean {
  return !!wsRequestedAt && Date.now() - wsRequestedAt.getTime() < WS_REQUEST_TTL_MS
}

/**
 * Strip the /api/projects/:pid/agent-proxy wrapper from a tunneled path,
 * returning the clean agent path (e.g. "/agent/quick-actions").
 *
 * IMPORTANT: only strips query-free path segments. Callers must handle
 * query strings separately (append after normalization).
 */
function normalizeTransparentProxyPath(path: string): string {
  const pathWithoutQuery = path.split('?')[0] || path
  const wrappedProjectPath = pathWithoutQuery.match(/^\/api\/projects\/[^/]+\/agent-proxy(\/.*)?$/)
  if (wrappedProjectPath) {
    // group 1 is undefined when the path ends exactly at /agent-proxy —
    // forward to /agent (the runtime's root) rather than "/" which 404s.
    return wrappedProjectPath[1] || '/agent'
  }
  return pathWithoutQuery
}

/**
 * Decide whether a request should use the streaming tunnel pipeline.
 *
 * `cleanPath` must already be normalized (no project-proxy wrapper, no
 * query string).  We intentionally do NOT call normalizeTransparentProxyPath
 * again here to avoid double-normalization bugs.
 */
function isStreamingRequest(method: string, cleanPath: string): boolean {
  // Strip query string defensively in case a caller still passes one.
  const pathOnly = cleanPath.split('?')[0] || cleanPath

  if (method === 'POST') {
    return STREAMING_POST_PATTERNS.some((pattern) =>
      pathOnly === pattern || pathOnly.startsWith(`${pattern}/`),
    )
  }

  if (method === 'GET') {
    return STREAMING_GET_PATTERNS.some((pattern) =>
      pathOnly === pattern || pathOnly.startsWith(`${pattern}/`),
    ) || CHAT_RESUME_STREAM_RE.test(pathOnly)
  }

  return false
}

// ─── WebSocket handler (called from Bun.serve websocket config) ─────────────

export function handleInstanceWsOpen(ws: WebSocket & { data?: any }) {
  const { instanceId, workspaceId } = ws.data || {}
  if (!instanceId || !workspaceId) {
    ws.close(4001, 'Missing instance context')
    return
  }

  const conn: TunnelConnection = {
    ws,
    instanceId,
    workspaceId,
    pendingRequests: new Map(),
    streamHandlers: new Map(),
  }
  tunnels.set(instanceId, conn)

  registerTunnelOwnership(instanceId).catch((err) => {
    console.warn('[RemoteControl] registerTunnelOwnership failed:', (err as Error).message)
  })

  prisma.instance.update({
    where: { id: instanceId },
    data: { status: 'online', lastSeenAt: new Date(), wsRequestedAt: null },
  }).catch(() => {})

  console.log(`[RemoteControl] Instance ${instanceId} connected (workspace ${workspaceId}, pod ${getPodId()})`)
}

export function handleInstanceWsMessage(ws: WebSocket & { data?: any }, raw: string | Buffer) {
  const { instanceId } = ws.data || {}
  const conn = instanceId ? tunnels.get(instanceId) : null
  if (!conn) return

  let msg: TunnelMessage
  try {
    msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
  } catch {
    return
  }

  if (msg.type === 'pong') {
    conn.ws.data._lastPong = Date.now()
    return
  }

  if (msg.type === 'heartbeat') {
    const hb = msg as TunnelHeartbeat
    prisma.instance.update({
      where: { id: instanceId },
      data: { lastSeenAt: new Date(), metadata: (hb.metadata ?? undefined) as any },
    }).catch(() => {})
    return
  }

  if (msg.type === 'response') {
    const resp = msg as TunnelResponse
    const pending = conn.pendingRequests.get(resp.requestId)
    if (pending) {
      clearTimeout(pending.timeout)
      conn.pendingRequests.delete(resp.requestId)
      pending.resolve(resp)
    }
    return
  }

  if (msg.type === 'stream-chunk' || msg.type === 'stream-end' || msg.type === 'stream-error') {
    const chunk = msg as TunnelStreamChunk
    const handler = conn.streamHandlers.get(chunk.requestId)
    if (handler) {
      handler(chunk)
      if (chunk.type === 'stream-end' || chunk.type === 'stream-error') {
        conn.streamHandlers.delete(chunk.requestId)
      }
    }
    return
  }
}

export function handleInstanceWsClose(ws: WebSocket & { data?: any }) {
  const { instanceId } = ws.data || {}
  if (!instanceId) return

  const conn = tunnels.get(instanceId)
  if (conn) {
    for (const [, pending] of conn.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Tunnel disconnected'))
    }
    conn.pendingRequests.clear()
    for (const [reqId, handler] of conn.streamHandlers) {
      handler({ type: 'stream-error', requestId: reqId, error: 'Tunnel disconnected' })
    }
    conn.streamHandlers.clear()
    tunnels.delete(instanceId)
  }

  unregisterTunnelOwnership(instanceId).catch((err) => {
    console.warn('[RemoteControl] unregisterTunnelOwnership failed:', (err as Error).message)
  })

  prisma.instance.update({
    where: { id: instanceId },
    data: { status: 'offline' },
  }).catch(() => {})

  console.log(`[RemoteControl] Instance ${instanceId} disconnected`)
}

/**
 * Authenticate a WebSocket upgrade request.
 * Returns { instanceId, workspaceId } or null.
 */
export async function authenticateInstanceWs(
  req: Request,
): Promise<{ instanceId: string; workspaceId: string } | null> {
  try {
    const url = new URL(req.url)
    const key = url.searchParams.get('key') || req.headers.get('x-api-key') || ''
    if (!key) return null

    const resolved = await resolveApiKey(key)
    if (!resolved) return null

  const hostname = url.searchParams.get('hostname') || 'unknown'
  const name = url.searchParams.get('name') || hostname
  const os = url.searchParams.get('os') || null
  const arch = url.searchParams.get('arch') || null

  const instance = await prisma.instance.upsert({
    where: { workspaceId_hostname: { workspaceId: resolved.workspaceId, hostname } },
    update: { name, os, arch, status: 'online', lastSeenAt: new Date(), wsRequestedAt: null },
    create: {
      workspaceId: resolved.workspaceId,
      name,
      hostname,
      os,
      arch,
      status: 'online',
      lastSeenAt: new Date(),
    },
  })

    return { instanceId: instance.id, workspaceId: resolved.workspaceId }
  } catch (err) {
    console.error('[RemoteControl] WS auth error:', (err as Error).message)
    return null
  }
}

// ─── Proxy helpers ──────────────────────────────────────────────────────────

function sendLocalTunnelRequest(instanceId: string, req: TunnelRequest): Promise<TunnelResponse> {
  const conn = tunnels.get(instanceId)
  if (!conn) return Promise.reject(new Error('Instance is offline (local)'))

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      conn.pendingRequests.delete(req.requestId)
      reject(new Error('Proxy request timed out'))
    }, PROXY_TIMEOUT_MS)

    conn.pendingRequests.set(req.requestId, { resolve, reject, timeout })
    conn.ws.send(JSON.stringify(req))
  })
}

async function sendTunnelRequest(instanceId: string, req: TunnelRequest): Promise<TunnelResponse> {
  const conn = tunnels.get(instanceId)
  if (conn) return sendLocalTunnelRequest(instanceId, req)

  const ownerPod = await getTunnelOwner(instanceId)
  if (!ownerPod) throw new Error('Instance is offline')

  if (ownerPod === getPodId()) {
    await evictTunnelOwnership(instanceId).catch(() => {})
    throw new Error('Instance is offline')
  }

  const alive = await verifyPodAlive(ownerPod)
  if (!alive) {
    await evictTunnelOwnership(instanceId).catch(() => {})
    console.warn(`[RemoteControl] Proactively evicted dead pod ${ownerPod} for instance ${instanceId} (sendTunnelRequest)`)
    throw new Error('Instance is offline')
  }

  try {
    const response = await relayTunnelRequest(ownerPod, instanceId, req)
    if (!response) throw new Error('Empty relay response')
    return response as TunnelResponse
  } catch (err: any) {
    if (err.message === 'Cross-pod relay timed out') {
      await evictTunnelOwnership(instanceId).catch(() => {})
      console.warn(`[RemoteControl] Evicted stale tunnel owner ${ownerPod} for instance ${instanceId} after relay timeout`)
    }
    throw err
  }
}

function sendLocalTunnelStreamRequest(
  instanceId: string,
  req: TunnelRequest,
  onChunk: (chunk: TunnelStreamChunk) => void,
): { cancel: () => void } {
  const conn = tunnels.get(instanceId)
  if (!conn) {
    onChunk({ type: 'stream-error', requestId: req.requestId, error: 'Instance is offline (local)' })
    return { cancel: () => {} }
  }

  const c = conn
  let gotFirstChunk = false
  // Use a generous timeout for the first chunk — the local agent may need
  // to cold-start the runtime AND wait for the first LLM token.
  let idleTimer = setTimeout(() => kill('idle'), STREAM_FIRST_CHUNK_TIMEOUT_MS)
  const maxTimer = setTimeout(() => kill('max'), STREAM_MAX_TIMEOUT_MS)

  function kill(reason: string) {
    clearTimeout(idleTimer)
    clearTimeout(maxTimer)
    c.streamHandlers.delete(req.requestId)
    onChunk({ type: 'stream-error', requestId: req.requestId, error: `Stream timed out (${reason})` })
  }

  c.streamHandlers.set(req.requestId, (chunk) => {
    clearTimeout(idleTimer)
    if (chunk.type === 'stream-chunk') {
      gotFirstChunk = true
      // After the first chunk, switch to the tighter inter-chunk timeout.
      idleTimer = setTimeout(() => kill('idle'), STREAM_IDLE_TIMEOUT_MS)
    }
    if (chunk.type === 'stream-end' || chunk.type === 'stream-error') {
      clearTimeout(idleTimer)
      clearTimeout(maxTimer)
    }
    onChunk(chunk)
  })

  c.ws.send(JSON.stringify({ ...req, stream: true }))

  return {
    cancel: () => {
      clearTimeout(idleTimer)
      clearTimeout(maxTimer)
      c.streamHandlers.delete(req.requestId)
      try {
        c.ws.send(JSON.stringify({ type: 'cancel', requestId: req.requestId }))
      } catch {}
    },
  }
}

function sendTunnelStreamRequest(
  instanceId: string,
  req: TunnelRequest,
  onChunk: (chunk: TunnelStreamChunk) => void,
): { cancel: () => void } {
  const conn = tunnels.get(instanceId)
  if (conn) return sendLocalTunnelStreamRequest(instanceId, req, onChunk)

  let cancelled = false
  const cancelRef = { cancel: () => { cancelled = true } }

  getTunnelOwner(instanceId).then(async (ownerPod) => {
    if (cancelled) return
    if (!ownerPod) {
      onChunk({ type: 'stream-error', requestId: req.requestId, error: 'Instance is offline' })
      return
    }
    if (ownerPod === getPodId()) {
      evictTunnelOwnership(instanceId).catch(() => {})
      onChunk({ type: 'stream-error', requestId: req.requestId, error: 'Instance is offline' })
      return
    }
    const alive = await verifyPodAlive(ownerPod)
    if (!alive) {
      await evictTunnelOwnership(instanceId).catch(() => {})
      console.warn(`[RemoteControl] Proactively evicted dead pod ${ownerPod} for instance ${instanceId} (sendTunnelStreamRequest)`)
      onChunk({ type: 'stream-error', requestId: req.requestId, error: 'Instance is offline' })
      return
    }
    const relay = relayTunnelStreamRequest(ownerPod, instanceId, req, onChunk)
    cancelRef.cancel = relay.cancel
  }).catch((err) => {
    onChunk({ type: 'stream-error', requestId: req.requestId, error: (err as Error).message })
  })

  return { cancel: () => cancelRef.cancel() }
}

// ─── REST routes ────────────────────────────────────────────────────────────

export function instanceRoutes() {
  initTunnelRedis().catch((err) => {
    console.error('[RemoteControl] Failed to initialize tunnel Redis:', err.message)
  })

  setLocalTunnelHandlers(
    (instanceId, req) => sendLocalTunnelRequest(instanceId, req as TunnelRequest),
    (instanceId, req, onChunk) => sendLocalTunnelStreamRequest(instanceId, req as TunnelRequest, onChunk),
  )

  const router = new Hono()

  // POST /instances/heartbeat — HTTP heartbeat from local instance (replaces always-on WS)
  router.post('/instances/heartbeat', async (c) => {
    const key = c.req.header('x-api-key') || ''
    if (!key) {
      return c.json({ error: { code: 'unauthorized', message: 'API key required' } }, 401)
    }

    const resolved = await resolveApiKey(key)
    if (!resolved) {
      return c.json({ error: { code: 'unauthorized', message: 'Invalid API key' } }, 401)
    }

    const body = await c.req.json<{
      hostname: string
      name?: string
      os?: string
      arch?: string
      metadata?: Record<string, unknown>
    }>()

    if (!body.hostname) {
      return c.json({ error: { code: 'invalid_request', message: 'hostname required' } }, 400)
    }

    const instance = await prisma.instance.upsert({
      where: {
        workspaceId_hostname: { workspaceId: resolved.workspaceId, hostname: body.hostname },
      },
      update: {
        name: body.name || body.hostname,
        os: body.os || null,
        arch: body.arch || null,
        lastSeenAt: new Date(),
        metadata: (body.metadata ?? undefined) as any,
      },
      create: {
        workspaceId: resolved.workspaceId,
        name: body.name || body.hostname,
        hostname: body.hostname,
        os: body.os || null,
        arch: body.arch || null,
        lastSeenAt: new Date(),
        metadata: (body.metadata ?? undefined) as any,
      },
    })

    const wsRequested = isWsRequested(instance.wsRequestedAt)
    const nextPollIn = await computeNextPollIn(instance.id, resolved.workspaceId, instance.wsRequestedAt)
    const hasTunnel = tunnels.has(instance.id) || await isTunnelConnectedAnywhere(instance.id)

    return c.json({
      instanceId: instance.id,
      nextPollIn,
      wsRequested,
      tunnelStatus: hasTunnel ? 'connected' : 'polling',
    })
  })

  // POST /instances/viewer-active — Signal that a user is viewing Remote Control
  router.post('/instances/viewer-active', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const body = await c.req.json<{ workspaceId: string }>()
    if (!body.workspaceId) {
      return c.json({ error: { code: 'invalid_request', message: 'workspaceId required' } }, 400)
    }

    const member = await prisma.member.findFirst({
      where: { userId: auth.userId, workspaceId: body.workspaceId },
    })
    if (!member) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    await markViewerActive(body.workspaceId)
    return c.json({ ok: true })
  })

  // POST /instances/:id/request-connect — Ask an instance to open its WebSocket tunnel
  router.post('/instances/:id/request-connect', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const instance = await prisma.instance.findUnique({ where: { id: c.req.param('id') } })
    if (!instance) {
      return c.json({ error: { code: 'not_found', message: 'Instance not found' } }, 404)
    }

    const member = await prisma.member.findFirst({
      where: { userId: auth.userId, workspaceId: instance.workspaceId },
    })
    if (!member) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    if (tunnels.has(instance.id) || await isTunnelConnectedAnywhere(instance.id)) {
      return c.json({ ok: true, status: 'already_connected' })
    }

    await prisma.instance.update({
      where: { id: instance.id },
      data: { wsRequestedAt: new Date() },
    })

    await markViewerActive(instance.workspaceId)

    void sendPushToInstance(instance.id, { type: 'ws-requested', priority: 'high' })

    return c.json({ ok: true, status: 'requested' })
  })

  // GET /instances — List all instances for the authenticated user's workspace
  router.get('/instances', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const workspaceId = c.req.query('workspaceId')
    if (!workspaceId) {
      return c.json({ error: { code: 'invalid_request', message: 'workspaceId query param required' } }, 400)
    }

    const member = await prisma.member.findFirst({
      where: { userId: auth.userId, workspaceId },
    })
    if (!member) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    const instances = await prisma.instance.findMany({
      where: { workspaceId },
      orderBy: { lastSeenAt: 'desc' },
    })

    const withLiveStatus = await Promise.all(instances.map(async (inst) => ({
      ...inst,
      status: tunnels.has(inst.id) || await isTunnelConnectedAnywhere(inst.id)
        ? 'online'
        : (isRecentlySeenViaHeartbeat(inst.lastSeenAt) ? 'heartbeat' : 'offline'),
    })))

    return c.json({ instances: withLiveStatus })
  })

  // GET /instances/:id — Instance details
  router.get('/instances/:id', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const instance = await prisma.instance.findUnique({ where: { id: c.req.param('id') } })
    if (!instance) {
      return c.json({ error: { code: 'not_found', message: 'Instance not found' } }, 404)
    }

    const member = await prisma.member.findFirst({
      where: { userId: auth.userId, workspaceId: instance.workspaceId },
    })
    if (!member) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    const controllers = await getActiveControllers(instance.id)
    return c.json({
      ...instance,
      status: tunnels.has(instance.id) || await isTunnelConnectedAnywhere(instance.id)
        ? 'online'
        : (isRecentlySeenViaHeartbeat(instance.lastSeenAt) ? 'heartbeat' : 'offline'),
      controllers: controllers.map((c) => ({
        userId: c.userId,
        lastSeenAt: c.lastSeenAt,
      })),
    })
  })

  // PUT /instances/:id — Rename instance
  router.put('/instances/:id', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const instance = await prisma.instance.findUnique({ where: { id: c.req.param('id') } })
    if (!instance) {
      return c.json({ error: { code: 'not_found', message: 'Instance not found' } }, 404)
    }

    const member = await prisma.member.findFirst({
      where: { userId: auth.userId, workspaceId: instance.workspaceId },
    })
    if (!member) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    const body = await c.req.json<{ name?: string }>()
    const updated = await prisma.instance.update({
      where: { id: instance.id },
      data: { name: body.name ?? instance.name },
    })

    return c.json(updated)
  })

  // DELETE /instances/:id — Remove instance from registry
  router.delete('/instances/:id', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const instance = await prisma.instance.findUnique({ where: { id: c.req.param('id') } })
    if (!instance) {
      return c.json({ error: { code: 'not_found', message: 'Instance not found' } }, 404)
    }

    const member = await prisma.member.findFirst({
      where: { userId: auth.userId, workspaceId: instance.workspaceId },
    })
    if (!member) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    const conn = tunnels.get(instance.id)
    if (conn) {
      conn.ws.close(4000, 'Instance removed')
    }

    await prisma.instance.delete({ where: { id: instance.id } })
    return c.json({ ok: true })
  })

  // POST /instances/:id/proxy — Proxy a single request to the local instance
  router.post('/instances/:id/proxy', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const instance = await prisma.instance.findUnique({ where: { id: c.req.param('id') } })
    if (!instance) {
      return c.json({ error: { code: 'not_found', message: 'Instance not found' } }, 404)
    }

    const member = await prisma.member.findFirst({
      where: { userId: auth.userId, workspaceId: instance.workspaceId },
    })
    if (!member) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    if (!tunnels.has(instance.id) && !await isTunnelConnectedAnywhere(instance.id)) {
      return c.json({ error: { code: 'offline', message: 'Instance is offline' } }, 503)
    }

    await markControllerActive(instance.id, auth.userId)

    const body = await c.req.json<{
      method: string
      path: string
      headers?: Record<string, string>
      body?: string
    }>()

    const requestId = generateRequestId()
    const action = classifyAction(body.method || 'GET', body.path)

    try {
      const resp = await sendTunnelRequest(instance.id, {
        type: 'request',
        requestId,
        method: body.method || 'GET',
        path: body.path,
        headers: body.headers,
        body: body.body,
      })

      logRemoteAction({
        instanceId: instance.id,
        userId: auth.userId,
        action,
        path: body.path,
        method: body.method || 'GET',
        result: `HTTP ${resp.status}`,
      })

      return c.json({
        status: resp.status,
        headers: resp.headers,
        body: resp.body,
      })
    } catch (err: any) {
      logRemoteAction({
        instanceId: instance.id,
        userId: auth.userId,
        action,
        path: body.path,
        method: body.method || 'GET',
        result: `error: ${err.message}`,
      })
      return c.json({ error: { code: 'proxy_error', message: err.message } }, 502)
    }
  })

  // POST /instances/:id/ping — Lightweight latency check through the tunnel
  router.post('/instances/:id/ping', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const instance = await prisma.instance.findUnique({ where: { id: c.req.param('id') } })
    if (!instance) {
      return c.json({ error: { code: 'not_found', message: 'Instance not found' } }, 404)
    }

    if (!tunnels.has(instance.id) && !await isTunnelConnectedAnywhere(instance.id)) {
      return c.json({ error: { code: 'offline', message: 'Instance is offline' } }, 503)
    }

    const requestId = generateRequestId()
    const start = Date.now()
    try {
      await sendTunnelRequest(instance.id, {
        type: 'request',
        requestId,
        method: 'GET',
        path: '/health',
      })
      return c.json({ ok: true, rttMs: Date.now() - start })
    } catch (err: any) {
      return c.json({ error: { code: 'proxy_error', message: err.message } }, 502)
    }
  })

  // POST /instances/:id/proxy/stream — Proxy a streaming request (e.g. /agent/chat)
  router.post('/instances/:id/proxy/stream', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const instance = await prisma.instance.findUnique({ where: { id: c.req.param('id') } })
    if (!instance) {
      return c.json({ error: { code: 'not_found', message: 'Instance not found' } }, 404)
    }

    const member = await prisma.member.findFirst({
      where: { userId: auth.userId, workspaceId: instance.workspaceId },
    })
    if (!member) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    if (!tunnels.has(instance.id) && !await isTunnelConnectedAnywhere(instance.id)) {
      return c.json({ error: { code: 'offline', message: 'Instance is offline' } }, 503)
    }

    await markControllerActive(instance.id, auth.userId, auth.sessionId || 'stream')

    const body = await c.req.json<{
      method: string
      path: string
      headers?: Record<string, string>
      body?: string
    }>()

    void logRemoteAction({
      instanceId: instance.id,
      userId: auth.userId,
      action: classifyAction(body.method || 'POST', body.path),
      path: body.path,
      method: body.method || 'POST',
      summary: 'streaming',
    })

    const requestId = generateRequestId()

    const stream = new ReadableStream({
      start(controller) {
        const { cancel } = sendTunnelStreamRequest(
          instance.id,
          {
            type: 'request',
            requestId,
            method: body.method || 'POST',
            path: body.path,
            headers: body.headers,
            body: body.body,
          },
          (chunk) => {
            if (chunk.type === 'stream-chunk' && chunk.data) {
              controller.enqueue(new TextEncoder().encode(chunk.data))
            } else if (chunk.type === 'stream-end') {
              controller.close()
            } else if (chunk.type === 'stream-error') {
              controller.error(new Error(chunk.error || 'Stream error'))
            }
          },
        )

        const signal = c.req.raw.signal
        if (signal) {
          signal.addEventListener('abort', () => {
            cancel()
            try { controller.close() } catch {}
          }, { once: true })
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  })

  // ─── Transparent proxy ──────────────────────────────────────────────────
  // ALL /instances/:id/p/* — Transparent HTTP proxy
  //
  // Forwards any HTTP request through the tunnel to the remote agent as-is.
  // The client uses agentUrl = "${API_URL}/api/instances/${id}/p" and all
  // existing fetch calls (GET /agent/status, POST /agent/chat, etc.) work
  // without a special fetch wrapper or envelope format.
  //
  // Streaming is auto-detected for POST requests to known streaming paths
  // (e.g. /agent/chat, /agent/logs/stream).

  // Use :rest{.+} so the full suffix after /p/ is always captured. A trailing /*
  // alone does not populate c.req.param('*') reliably under app.route('/api', …),
  // and manual pathname slicing can miss edge cases — leaving afterPrefix empty
  // normalizes to "/" and breaks tunnel forwarding.
  router.all('/instances/:id/p/:rest{.+}', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const instanceId = c.req.param('id')
    const instance = await prisma.instance.findUnique({ where: { id: instanceId } })
    if (!instance) {
      return c.json({ error: { code: 'not_found', message: 'Instance not found' } }, 404)
    }

    const member = await prisma.member.findFirst({
      where: { userId: auth.userId, workspaceId: instance.workspaceId },
    })
    if (!member) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    const localTunnel = tunnels.has(instanceId)
    let remoteTunnelPod = localTunnel ? null : await getTunnelOwner(instanceId)

    // If Redis says a remote pod owns this tunnel but that pod is actually us
    // and we don't have a local connection, the ownership is stale. Evict it.
    if (!localTunnel && remoteTunnelPod === getPodId()) {
      await evictTunnelOwnership(instanceId).catch(() => {})
      remoteTunnelPod = null
    }

    // If Redis points to a different pod, verify it's actually alive before
    // committing to a 30s relay timeout. Dead pods (e.g. from a dev server
    // restart) will never respond. Evict and fall through to the wake-up path.
    if (!localTunnel && remoteTunnelPod && remoteTunnelPod !== getPodId()) {
      const alive = await verifyPodAlive(remoteTunnelPod)
      if (!alive) {
        console.warn(`[RemoteControl] Proactively evicting dead pod ${remoteTunnelPod} for instance ${instanceId}`)
        await evictTunnelOwnership(instanceId).catch(() => {})
        remoteTunnelPod = null
      }
    }

    if (!localTunnel && !remoteTunnelPod) {
      await prisma.instance.update({
        where: { id: instanceId },
        data: { wsRequestedAt: new Date() },
      }).catch(() => {})
      void sendPushToInstance(instanceId, { type: 'ws-requested', priority: 'high' })

      const deadline = Date.now() + TUNNEL_WAIT_TIMEOUT_MS
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, TUNNEL_WAIT_POLL_MS))
        if (tunnels.has(instanceId)) break
        remoteTunnelPod = await getTunnelOwner(instanceId)
        if (remoteTunnelPod) break
      }

      if (!tunnels.has(instanceId) && !remoteTunnelPod) {
        return c.json({ error: { code: 'offline', message: 'Instance is offline' } }, 503)
      }
    }

    await markControllerActive(instanceId, auth.userId)

    const incomingUrl = new URL(c.req.url)
    const qs = incomingUrl.search
    const afterPrefix = c.req.param('rest') || ''
    const rawPath = '/' + afterPrefix

    // Extract projectId from wrapped agent-proxy paths before stripping
    const tunnelProjectId = rawPath.match(
      /^\/api\/projects\/([^/]+)\/agent-proxy(?:\/|$)/,
    )?.[1]

    // ── Path normalization ─────────────────────────────────────────────
    // Strip the /api/projects/:pid/agent-proxy prefix so the desktop
    // tunnel receives the clean path (e.g. "/agent/quick-actions")
    // instead of the full cloud gateway path which would 404 on the
    // local agent.  Query string is appended AFTER normalization.
    const cleanPath = normalizeTransparentProxyPath(rawPath)
    const agentPath = cleanPath + qs

    const method = c.req.method
    const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH'
    const body = hasBody ? await c.req.text() : undefined
    const requestId = generateRequestId()

    const forwardHeaders: Record<string, string> = {}
    const contentType = c.req.header('content-type')
    if (contentType) forwardHeaders['content-type'] = contentType
    const accept = c.req.header('accept')
    if (accept) forwardHeaders['accept'] = accept

    // Use the pre-normalized path (no query string) for streaming detection
    // to avoid double-normalization bugs.
    const isStreaming = isStreamingRequest(method, cleanPath)

    if (isStreaming) {
      void logRemoteAction({
        instanceId,
        userId: auth.userId,
        action: classifyAction(method, agentPath),
        path: agentPath,
        method,
        summary: 'streaming',
      })

      const stream = new ReadableStream({
        start(controller) {
          const { cancel } = sendTunnelStreamRequest(
            instanceId,
            {
              type: 'request',
              requestId,
              method,
              path: agentPath,
              projectId: tunnelProjectId,
              headers: forwardHeaders,
              body,
            },
            (chunk) => {
              if (chunk.type === 'stream-chunk' && chunk.data) {
                controller.enqueue(new TextEncoder().encode(chunk.data))
              } else if (chunk.type === 'stream-end') {
                controller.close()
              } else if (chunk.type === 'stream-error') {
                controller.error(new Error(chunk.error || 'Stream error'))
              }
            },
          )

          const signal = c.req.raw.signal
          if (signal) {
            signal.addEventListener('abort', () => {
              cancel()
              try { controller.close() } catch {}
            }, { once: true })
          }
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      })
    }

    // Non-streaming: forward and return the response directly
    try {
      const resp = await sendTunnelRequest(instanceId, {
        type: 'request',
        requestId,
        method,
        path: agentPath,
        projectId: tunnelProjectId,
        headers: forwardHeaders,
        body,
      })

      logRemoteAction({
        instanceId,
        userId: auth.userId,
        action: classifyAction(method, agentPath),
        path: agentPath,
        method,
        result: `HTTP ${resp.status}`,
      })

      const responseHeaders: Record<string, string> = {}
      if (resp.headers) {
        for (const [k, v] of Object.entries(resp.headers)) {
          if (v) responseHeaders[k.toLowerCase()] = v
        }
      }
      if (!responseHeaders['content-type']) {
        responseHeaders['content-type'] = 'application/json'
      }

      return new Response(resp.body || '', {
        status: resp.status,
        headers: responseHeaders,
      })
    } catch (err: any) {
      logRemoteAction({
        instanceId,
        userId: auth.userId,
        action: classifyAction(method, agentPath),
        path: agentPath,
        method,
        result: `error: ${err.message}`,
      })
      return c.json({ error: { code: 'proxy_error', message: err.message } }, 502)
    }
  })

  // GET /instances/:id/echo — End-to-end tunnel integration test endpoint
  router.all('/instances/:id/echo', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const instance = await prisma.instance.findUnique({ where: { id: c.req.param('id') } })
    if (!instance) {
      return c.json({ error: { code: 'not_found', message: 'Instance not found' } }, 404)
    }

    if (!tunnels.has(instance.id) && !await isTunnelConnectedAnywhere(instance.id)) {
      return c.json({ error: { code: 'offline', message: 'Instance is offline' } }, 503)
    }

    const body = c.req.method !== 'GET' ? await c.req.text() : undefined
    const requestId = generateRequestId()
    const start = Date.now()

    try {
      const resp = await sendTunnelRequest(instance.id, {
        type: 'request',
        requestId,
        method: c.req.method,
        path: '/__test/echo',
        body,
      })
      return c.json({
        tunnelRttMs: Date.now() - start,
        echoStatus: resp.status,
        echoBody: resp.body,
      })
    } catch (err: any) {
      return c.json({ error: { code: 'proxy_error', message: err.message } }, 502)
    }
  })

  return router
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isRecentlySeenViaHeartbeat(lastSeenAt: Date | null): boolean {
  if (!lastSeenAt) return false
  return Date.now() - lastSeenAt.getTime() < POLL_INTERVAL_IDLE_S * 2 * 1000
}

// ─── Heartbeat ping for all connected tunnels ───────────────────────────────

let heartbeatTimer: ReturnType<typeof setInterval> | null = null

export function startTunnelHeartbeat() {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    for (const [instanceId, conn] of tunnels) {
      try {
        conn.ws.send(JSON.stringify({ type: 'ping' }))
        refreshTunnelOwnership(instanceId).catch((err) => {
          console.warn('[RemoteControl] refreshTunnelOwnership failed:', (err as Error).message)
        })
      } catch {
        tunnels.delete(instanceId)
        unregisterTunnelOwnership(instanceId).catch((err) => {
          console.warn('[RemoteControl] unregisterTunnelOwnership failed:', (err as Error).message)
        })
      }
    }
  }, HEARTBEAT_INTERVAL_MS)
}

export function stopTunnelHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

// ─── Exported for testing ────────────────────────────────────────────────────

export const _testing = {
  tunnels,
  activeViewers,
  activeControllers,
  computeNextPollIn,
  isWsRequested,
  isViewerActive,
  markViewerActive,
  markControllerActive,
  getActiveControllers,
  sendLocalTunnelRequest,
  sendLocalTunnelStreamRequest,
  POLL_INTERVAL_IDLE_S,
  POLL_INTERVAL_VIEWER_S,
  POLL_INTERVAL_WS_REQUESTED_S,
  WS_REQUEST_TTL_MS,
  VIEWER_ACTIVE_TTL_MS,
  STREAM_FIRST_CHUNK_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
  STREAM_MAX_TIMEOUT_MS,
}
