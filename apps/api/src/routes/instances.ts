// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Remote Control — Instance Registry & Tunnel Proxy
 *
 * Enables cloud users to see and control their local Shogo instances.
 * Local instances connect outward via WebSocket; the cloud proxies
 * dashboard commands back through the tunnel.
 *
 * Endpoints:
 * - GET  /api/instances/ws          — WebSocket upgrade (API key auth from local instance)
 * - GET  /api/instances             — List instances for workspace (session auth)
 * - GET  /api/instances/:id         — Instance details (session auth)
 * - PUT  /api/instances/:id         — Update instance name (session auth)
 * - DELETE /api/instances/:id       — Remove instance from registry (session auth)
 * - POST /api/instances/:id/proxy   — Proxy a request to local instance via tunnel
 * - POST /api/instances/:id/proxy/stream — Proxy a streaming request via tunnel
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { resolveApiKey } from './api-keys'

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

const PROXY_TIMEOUT_MS = 30_000
const STREAM_TIMEOUT_MS = 120_000

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
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
    data: { status: 'online', lastSeenAt: new Date() },
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
    update: { name, os, arch, status: 'online', lastSeenAt: new Date() },
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
      status: tunnels.has(inst.id) ? 'online' : 'offline',
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
      status: tunnels.has(instance.id) ? 'online' : 'offline',
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

    const body = await c.req.json<{
      method: string
      path: string
      headers?: Record<string, string>
      body?: string
    }>()

    const requestId = generateRequestId()
    try {
      const resp = await sendTunnelRequest(instance.id, {
        type: 'request',
        requestId,
        method: body.method || 'GET',
        path: body.path,
        headers: body.headers,
        body: body.body,
      })

      return c.json({
        status: resp.status,
        headers: resp.headers,
        body: resp.body,
      })
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

    const body = await c.req.json<{
      method: string
      path: string
      headers?: Record<string, string>
      body?: string
    }>()

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

  return router
}

// ─── Heartbeat ping for all connected tunnels ───────────────────────────────

const HEARTBEAT_INTERVAL_MS = 25_000

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
