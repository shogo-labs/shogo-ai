// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Remote Control — Audit Trail & Push Subscriptions
 *
 * Endpoints:
 * - GET  /api/instances/:id/audit          — List remote actions for an instance
 * - POST /api/instances/:id/subscribe-push — Register a push notification token
 * - DELETE /api/instances/:id/subscribe-push — Unregister a push token
 * - GET  /api/instances/:id/push-subscriptions — List push subscriptions
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'

// ─── Audit logging helper (used by proxy routes) ───────────────────────────

export async function logRemoteAction(params: {
  instanceId: string
  userId: string
  action: string
  path?: string
  method?: string
  summary?: string
  result?: string
}) {
  try {
    await prisma.remoteAction.create({ data: params })
  } catch {
    // Non-fatal: don't break the proxy if audit logging fails
  }
}

/**
 * Classify a proxy path into a human-readable action name.
 */
export function classifyAction(method: string, path: string): string {
  if (path === '/agent/stop') return 'stop_agent'
  if (path === '/agent/session/reset') return 'reset_session'
  if (path === '/agent/heartbeat/trigger') return 'trigger_heartbeat'
  if (path === '/agent/mode') return method === 'GET' ? 'get_mode' : 'set_mode'
  if (path === '/agent/chat') return 'remote_chat'
  if (path === '/agent/status') return 'get_status'
  if (path.startsWith('/agent/workspace/tree')) return 'browse_files'
  if (path.startsWith('/agent/workspace/files')) return method === 'GET' ? 'view_file' : 'edit_file'
  if (path === '/health') return 'health_check'
  return `proxy_${method.toLowerCase()}`
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export function remoteAuditRoutes() {
  const router = new Hono()

  // GET /instances/:id/audit — List recent remote actions
  router.get('/instances/:id/audit', async (c) => {
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

    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200)
    const actions = await prisma.remoteAction.findMany({
      where: { instanceId: instance.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    return c.json({ actions })
  })

  // POST /instances/:id/subscribe-push — Register Expo push token
  router.post('/instances/:id/subscribe-push', async (c) => {
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

    const body = await c.req.json<{ pushToken: string; platform: string }>()
    if (!body.pushToken || !body.platform) {
      return c.json({ error: { code: 'invalid_request', message: 'pushToken and platform required' } }, 400)
    }

    const sub = await prisma.pushSubscription.upsert({
      where: {
        instanceId_pushToken: { instanceId: instance.id, pushToken: body.pushToken },
      },
      update: { platform: body.platform, userId: auth.userId },
      create: {
        instanceId: instance.id,
        userId: auth.userId,
        pushToken: body.pushToken,
        platform: body.platform,
      },
    })

    return c.json({ ok: true, id: sub.id })
  })

  // DELETE /instances/:id/subscribe-push — Unregister push token
  router.delete('/instances/:id/subscribe-push', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const body = await c.req.json<{ pushToken: string }>()
    if (!body.pushToken) {
      return c.json({ error: { code: 'invalid_request', message: 'pushToken required' } }, 400)
    }

    const instanceId = c.req.param('id')
    try {
      await prisma.pushSubscription.delete({
        where: { instanceId_pushToken: { instanceId, pushToken: body.pushToken } },
      })
    } catch {
      // Already deleted or doesn't exist — fine
    }

    return c.json({ ok: true })
  })

  return router
}
