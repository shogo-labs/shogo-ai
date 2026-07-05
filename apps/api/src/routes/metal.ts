// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Internal metal-substrate routes (mounted at /api/internal/metal).
 *
 * The bare-metal Firecracker node-agents (apps/metal-agent) heartbeat here over
 * the WireGuard mesh so the control plane's MetalWarmPoolController knows which
 * hosts are live and can route eligible projects to them. See register.ts on the
 * node-agent side and lib/metal-warm-pool-controller.ts here.
 *
 * Auth: a shared bearer token (METAL_REGISTER_TOKEN, falling back to
 * SHOGO_INTERNAL_SECRET). /api/internal/* skips the session auth middleware
 * (server.ts), so this in-route check is the only gate — it MUST reject when no
 * token is configured. Reachable only over the private mesh in production.
 */

import { Hono } from 'hono'
import {
  registerMetalHost,
  getMetalWarmPoolController,
  type MetalHostRegistration,
} from '../lib/metal-warm-pool-controller'

function expectedToken(): string | undefined {
  return process.env.METAL_REGISTER_TOKEN || process.env.SHOGO_INTERNAL_SECRET
}

function authOk(authorization: string | undefined): boolean {
  const expected = expectedToken()
  if (!expected) return false // fail closed when unconfigured
  if (!authorization) return false
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  return token.length > 0 && token === expected
}

export function metalRoutes(): Hono {
  const app = new Hono()

  // POST /api/internal/metal/register — node-agent heartbeat.
  app.post('/register', async (c) => {
    if (!authOk(c.req.header('authorization'))) {
      return c.json({ ok: false, error: 'unauthorized' }, 401)
    }
    let body: Partial<MetalHostRegistration> & { load?: any; capacity?: any }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: 'invalid_json' }, 400)
    }
    if (!body?.hostId || !body?.meshIp || !body?.agentPort) {
      return c.json({ ok: false, error: 'hostId, meshIp and agentPort are required' }, 400)
    }

    registerMetalHost({
      hostId: String(body.hostId),
      meshIp: String(body.meshIp),
      agentPort: Number(body.agentPort),
      region: String(body.region ?? 'unknown'),
      arch: String(body.arch ?? 'unknown'),
      capacity: {
        poolSize: Number(body.capacity?.poolSize ?? 0),
        memMiB: Number(body.capacity?.memMiB ?? 0),
        vcpus: Number(body.capacity?.vcpus ?? 0),
      },
      load: {
        available: Number(body.load?.available ?? 0),
        assigned: Number(body.load?.assigned ?? 0),
        suspended: Number(body.load?.suspended ?? 0),
      },
    })

    return c.json({ ok: true })
  })

  // GET /api/internal/metal/status — fleet + snapshot hit-rate/wake metrics.
  app.get('/status', (c) => {
    if (!authOk(c.req.header('authorization'))) {
      return c.json({ ok: false, error: 'unauthorized' }, 401)
    }
    return c.json({ ok: true, ...getMetalWarmPoolController().getStatus() })
  })

  return app
}

export default metalRoutes
