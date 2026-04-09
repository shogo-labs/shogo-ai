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

// ─── Constants ───────────────────────────────────────────────────────────────

const POLL_INTERVAL_IDLE_S = 60
const POLL_INTERVAL_VIEWER_S = 5
const POLL_INTERVAL_WS_REQUESTED_S = 3
const WS_REQUEST_TTL_MS = 2 * 60 * 1000
const VIEWER_ACTIVE_TTL_MS = 2 * 60 * 1000
const PROXY_TIMEOUT_MS = 30_000
const STREAM_TIMEOUT_MS = 120_000
const HEARTBEAT_INTERVAL_MS = 25_000

// ─── In-memory viewer tracking ──────────────────────────────────────────────
// Tracks which workspaces have active Remote Control viewers.
// This is an optimization: if the flag isn't visible (multi-pod), the instance
// simply stays at the 60s poll and takes up to 60s to pick up a connect request.

const activeViewers = new Map<string, number>()

export function isViewerActive(workspaceId: string): boolean {
  const ts = activeViewers.get(workspaceId)
  if (!ts) return false
  if (Date.now() - ts > VIEWER_ACTIVE_TTL_MS) {
    activeViewers.delete(workspaceId)
    return false
  }
  return true
}

function markViewerActive(workspaceId: string) {
  activeViewers.set(workspaceId, Date.now())
}

// ─── Active controllers (multi-device awareness) ───────────────────────────

interface ActiveController {
  userId: string
  sessionId?: string
  lastSeenAt: number
}

const activeControllers = new Map<string, Map<string, ActiveController>>()
const CONTROLLER_TTL_MS = 60_000

function markControllerActive(instanceId: string, userId: string, sessionId?: string) {
  if (!activeControllers.has(instanceId)) {
    activeControllers.set(instanceId, new Map())
  }
  const key = sessionId || userId
  activeControllers.get(instanceId)!.set(key, { userId, sessionId, lastSeenAt: Date.now() })
}

function getActiveControllers(instanceId: string): ActiveController[] {
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

function computeNextPollIn(instanceId: string, workspaceId: string, wsRequestedAt: Date | null): number {
  if (wsRequestedAt && Date.now() - wsRequestedAt.getTime() < WS_REQUEST_TTL_MS) {
    return POLL_INTERVAL_WS_REQUESTED_S
  }
  if (isViewerActive(workspaceId)) {
    return POLL_INTERVAL_VIEWER_S
  }
  return POLL_INTERVAL_IDLE_S
}

function isWsRequested(wsRequestedAt: Date | null): boolean {
  return !!wsRequestedAt && Date.now() - wsRequestedAt.getTime() < WS_REQUEST_TTL_MS
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

  prisma.instance.update({
    where: { id: instanceId },
    data: { status: 'online', lastSeenAt: new Date(), wsRequestedAt: null },
  }).catch(() => {})

  console.log(`[RemoteControl] Instance ${instanceId} connected (workspace ${workspaceId})`)
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

function sendTunnelRequest(instanceId: string, req: TunnelRequest): Promise<TunnelResponse> {
  const conn = tunnels.get(instanceId)
  if (!conn) return Promise.reject(new Error('Instance is offline'))

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      conn.pendingRequests.delete(req.requestId)
      reject(new Error('Proxy request timed out'))
    }, PROXY_TIMEOUT_MS)

    conn.pendingRequests.set(req.requestId, { resolve, reject, timeout })
    conn.ws.send(JSON.stringify(req))
  })
}

function sendTunnelStreamRequest(
  instanceId: string,
  req: TunnelRequest,
  onChunk: (chunk: TunnelStreamChunk) => void,
): { cancel: () => void } {
  const conn = tunnels.get(instanceId)
  if (!conn) {
    onChunk({ type: 'stream-error', requestId: req.requestId, error: 'Instance is offline' })
    return { cancel: () => {} }
  }

  const timeout = setTimeout(() => {
    conn.streamHandlers.delete(req.requestId)
    onChunk({ type: 'stream-error', requestId: req.requestId, error: 'Stream timed out' })
  }, STREAM_TIMEOUT_MS)

  conn.streamHandlers.set(req.requestId, (chunk) => {
    if (chunk.type === 'stream-end' || chunk.type === 'stream-error') {
      clearTimeout(timeout)
    }
    onChunk(chunk)
  })

  conn.ws.send(JSON.stringify({ ...req, stream: true }))

  return {
    cancel: () => {
      clearTimeout(timeout)
      conn.streamHandlers.delete(req.requestId)
      conn.ws.send(JSON.stringify({ type: 'cancel', requestId: req.requestId }))
    },
  }
}

// ─── REST routes ────────────────────────────────────────────────────────────

export function instanceRoutes() {
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
    const nextPollIn = computeNextPollIn(instance.id, resolved.workspaceId, instance.wsRequestedAt)
    const hasTunnel = tunnels.has(instance.id)

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

    markViewerActive(body.workspaceId)
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

    if (tunnels.has(instance.id)) {
      return c.json({ ok: true, status: 'already_connected' })
    }

    await prisma.instance.update({
      where: { id: instance.id },
      data: { wsRequestedAt: new Date() },
    })

    markViewerActive(instance.workspaceId)

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

    const withLiveStatus = instances.map((inst) => ({
      ...inst,
      status: tunnels.has(inst.id) ? 'online' : (isRecentlySeenViaHeartbeat(inst.lastSeenAt) ? 'heartbeat' : 'offline'),
    }))

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

    return c.json({
      ...instance,
      status: tunnels.has(instance.id) ? 'online' : (isRecentlySeenViaHeartbeat(instance.lastSeenAt) ? 'heartbeat' : 'offline'),
      controllers: getActiveControllers(instance.id).map((c) => ({
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

    if (!tunnels.has(instance.id)) {
      return c.json({ error: { code: 'offline', message: 'Instance is offline' } }, 503)
    }

    markControllerActive(instance.id, auth.userId)

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

    if (!tunnels.has(instance.id)) {
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

    if (!tunnels.has(instance.id)) {
      return c.json({ error: { code: 'offline', message: 'Instance is offline' } }, 503)
    }

    markControllerActive(instance.id, auth.userId, auth.sessionId || 'stream')

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

        c.req.raw.signal?.addEventListener('abort', () => cancel())
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

  const STREAMING_POST_PATTERNS = ['/agent/chat', '/agent/logs/stream', '/agent/chat/']
  const STREAMING_GET_PATTERNS = ['/agent/canvas/stream', '/agent/logs/stream']

  router.all('/instances/:id/p/*', async (c) => {
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

    if (!tunnels.has(instanceId)) {
      return c.json({ error: { code: 'offline', message: 'Instance is offline' } }, 503)
    }

    markControllerActive(instanceId, auth.userId)

    const wildcardParam = c.req.param('*')
    const incomingUrl = new URL(c.req.url)
    const qs = incomingUrl.search
    const agentPath = '/' + (wildcardParam || '') + qs
    const method = c.req.method
    const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH'
    const body = hasBody ? await c.req.text() : undefined
    const requestId = generateRequestId()

    const forwardHeaders: Record<string, string> = {}
    const contentType = c.req.header('content-type')
    if (contentType) forwardHeaders['content-type'] = contentType
    const accept = c.req.header('accept')
    if (accept) forwardHeaders['accept'] = accept

    const pathWithoutQuery = agentPath.split('?')[0]
    const isStreaming =
      (method === 'POST' && STREAMING_POST_PATTERNS.some((p) => pathWithoutQuery === p || pathWithoutQuery.startsWith(p + '/'))) ||
      (method === 'GET' && STREAMING_GET_PATTERNS.some((p) => pathWithoutQuery === p || pathWithoutQuery.startsWith(p + '/')))

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
          c.req.raw.signal?.addEventListener('abort', () => cancel())
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

    if (!tunnels.has(instance.id)) {
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
      } catch {
        tunnels.delete(instanceId)
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
  POLL_INTERVAL_IDLE_S,
  POLL_INTERVAL_VIEWER_S,
  POLL_INTERVAL_WS_REQUESTED_S,
  WS_REQUEST_TTL_MS,
  VIEWER_ACTIVE_TTL_MS,
}
