// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sync Routes — Phase 2 Real-Time Synchronization
 *
 * REST endpoints for the sync system:
 * - GET  /api/sync          — Catch-up sync (get events since timestamp)
 * - POST /api/sync/events   — Publish a sync event
 *
 * WebSocket endpoint (handled in server.ts):
 * - /ws/sync                — Real-time bidirectional event stream
 *
 * These endpoints complement the existing transparent proxy tunnel.
 * Phase 1 routes all API requests through the tunnel; Phase 2 adds
 * event-based sync for real-time reactivity and offline support.
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import {
  getSyncEngine,
  type SyncEvent,
  type SyncEventSource,
  type SyncEventType,
} from '../lib/sync-engine'

export function syncRoutes() {
  const router = new Hono()

  /**
   * GET /sync — Catch-up sync
   *
   * Returns events since the given timestamp for the workspace.
   * Used after reconnection to get missed events.
   *
   * Query params:
   *   workspaceId (required) — workspace to sync
   *   since       (required) — timestamp in ms (events after this)
   *   limit       (optional) — max events to return (default 500)
   */
  router.get('/sync', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json(
        { error: { code: 'unauthorized', message: 'Authentication required' } },
        401,
      )
    }

    const workspaceId = c.req.query('workspaceId')
    const sinceStr = c.req.query('since')
    const limitStr = c.req.query('limit')

    if (!workspaceId || !sinceStr) {
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: 'workspaceId and since query params required',
          },
        },
        400,
      )
    }

    // Verify workspace membership
    const member = await prisma.member.findFirst({
      where: { userId: auth.userId, workspaceId },
    })
    if (!member) {
      return c.json(
        { error: { code: 'forbidden', message: 'Not a member of this workspace' } },
        403,
      )
    }

    const since = parseInt(sinceStr, 10)
    if (isNaN(since)) {
      return c.json(
        { error: { code: 'invalid_request', message: 'since must be a valid timestamp' } },
        400,
      )
    }

    const limit = limitStr ? parseInt(limitStr, 10) : 500

    const engine = getSyncEngine()
    const result = engine.replayEvents({ workspaceId, since, limit })

    return c.json({
      ok: true,
      events: result.events,
      cursor: result.cursor,
      hasMore: result.hasMore,
    })
  })

  /**
   * POST /sync/events — Publish a sync event
   *
   * Accepts a sync event from any client and broadcasts it to all
   * other connected clients in the same workspace.
   *
   * Body:
   *   type       (required) — event type (e.g. PROJECT_CREATED)
   *   entityId   (required) — ID of the affected entity
   *   payload    (required) — change data
   *   source     (required) — "desktop" | "web" | "mobile"
   *   workspaceId (required) — workspace scope
   *   version    (optional) — entity version number
   *   instanceId (optional) — desktop instance ID
   */
  router.post('/sync/events', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json(
        { error: { code: 'unauthorized', message: 'Authentication required' } },
        401,
      )
    }

    const body = await c.req.json<{
      type: SyncEventType
      entityId: string
      payload: Record<string, unknown>
      source: SyncEventSource
      workspaceId: string
      version?: number
      instanceId?: string
    }>()

    if (!body.type || !body.entityId || !body.payload || !body.source || !body.workspaceId) {
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: 'type, entityId, payload, source, and workspaceId are required',
          },
        },
        400,
      )
    }

    // Verify workspace membership
    const member = await prisma.member.findFirst({
      where: { userId: auth.userId, workspaceId: body.workspaceId },
    })
    if (!member) {
      return c.json(
        { error: { code: 'forbidden', message: 'Not a member of this workspace' } },
        403,
      )
    }

    const event: SyncEvent = {
      id: crypto.randomUUID(),
      type: body.type,
      entityId: body.entityId,
      payload: body.payload,
      timestamp: Date.now(),
      source: body.source,
      version: body.version ?? 1,
      workspaceId: body.workspaceId,
      instanceId: body.instanceId,
      userId: auth.userId,
    }

    const engine = getSyncEngine()
    engine.publish(event)

    return c.json({ ok: true, eventId: event.id, serverTimestamp: event.serverTimestamp })
  })

  return router
}
