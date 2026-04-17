// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Internal Tunnel Relay — Pod-to-Pod HTTP bridge
 *
 * Mounted under `/api/internal/*`. Not exposed through the external ingress.
 * Peer API pods hit these endpoints directly via pod IP (Downward API) to
 * relay Remote Control proxy traffic to whichever pod currently owns the
 * desktop WebSocket tunnel — this is the Redis-less replacement for the
 * `tunnel:pod:*:request` pub/sub channel in `tunnel-redis.ts`.
 *
 * Endpoints
 *   GET  /api/internal/tunnel-alive           — liveness probe (pod reachable?)
 *   POST /api/internal/tunnel-relay           — unary request → response
 *   POST /api/internal/tunnel-relay/stream    — NDJSON streaming response
 */
import { Hono } from 'hono'
import { verifyInternalRelaySecret } from '../lib/tunnel-db'
import { getLocalTunnelHandlers } from '../lib/tunnel-redis'

interface RelayBody {
  instanceId: string
  request: {
    type: 'request'
    requestId: string
    method: string
    path: string
    headers?: Record<string, string>
    body?: string
    projectId?: string
  }
}

export function internalTunnelRelayRoutes() {
  const app = new Hono()

  app.use('*', async (c, next) => {
    if (!verifyInternalRelaySecret(c.req.header('x-internal-relay-secret'))) {
      return c.json({ error: 'forbidden' }, 403)
    }
    return next()
  })

  app.get('/tunnel-alive', (c) => c.json({ ok: true, podId: process.env.HOSTNAME || 'unknown' }))

  app.post('/tunnel-relay', async (c) => {
    const { send } = getLocalTunnelHandlers()
    if (!send) {
      return c.json({ error: 'no-local-handler' }, 503)
    }

    let body: RelayBody
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid-json' }, 400)
    }

    try {
      const response = await send(body.instanceId, body.request)
      if (!response) {
        return c.json({ error: 'empty-response' }, 502)
      }
      return c.json(response)
    } catch (err: any) {
      const msg = err?.message ?? 'relay-failed'
      // The owning pod should have held the WebSocket but the in-memory map
      // says otherwise → ownership is stale on this pod. 404 is the signal
      // the caller uses to evict the stale `tunnel_ownership` row.
      if (msg.includes('Instance is offline')) {
        return c.json({ error: msg }, 404)
      }
      return c.json({ error: msg }, 502)
    }
  })

  app.post('/tunnel-relay/stream', async (c) => {
    const { stream } = getLocalTunnelHandlers()
    if (!stream) {
      return c.json({ error: 'no-local-handler' }, 503)
    }

    let body: RelayBody
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid-json' }, 400)
    }

    const encoder = new TextEncoder()

    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false
        function safeClose() {
          if (closed) return
          closed = true
          try { controller.close() } catch {}
        }

        const { cancel } = stream!(body.instanceId, body.request, (chunk) => {
          if (closed) return
          try {
            // NDJSON framing — one JSON object per line.
            controller.enqueue(encoder.encode(JSON.stringify(chunk) + '\n'))
          } catch {
            closed = true
          }
          if (chunk.type === 'stream-end' || chunk.type === 'stream-error') {
            safeClose()
          }
        })

        const signal = c.req.raw.signal
        if (signal) {
          signal.addEventListener(
            'abort',
            () => {
              try { cancel() } catch {}
              safeClose()
            },
            { once: true },
          )
        }
      },
    })

    return new Response(readable, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  })

  return app
}
