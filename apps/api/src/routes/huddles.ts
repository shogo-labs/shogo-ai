// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Huddle endpoints (live audio in channels and DMs). Mounted onto the
 * conversations router, so per-conversation writes reach the workspace's home
 * region through the normal session routing.
 */

import type { Hono } from 'hono'
import { CHAT_RATE_LIMITS, takeRateLimit } from '../lib/chat-limits'
import { huddlesEnabled } from '../lib/livekit'
import { declineHuddle, getHuddle, joinHuddle, leaveHuddle, listActiveHuddles } from '../services/huddle.service'

export interface HuddleRouteHelpers {
  requireUser: (c: any) => Promise<string | Response>
  requireWorkspace: (c: any) => Promise<{ userId: string; workspaceId: string } | Response>
  errorResponse: (c: any, err: unknown) => Response
}

export function mountHuddleRoutes(router: Hono, h: HuddleRouteHelpers): void {
  router.get('/workspaces/:workspaceId/huddles', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    if (!huddlesEnabled()) return c.json({ enabled: false, huddles: [] })
    return c.json({ enabled: true, huddles: await listActiveHuddles(auth.workspaceId, auth.userId) })
  })

  router.get('/conversations/:conversationId/huddle', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    if (!huddlesEnabled()) return c.json({ enabled: false, huddle: null })
    try {
      return c.json({ enabled: true, huddle: await getHuddle(c.req.param('conversationId'), userId) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.post('/conversations/:conversationId/huddle/join', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    const limit = CHAT_RATE_LIMITS.huddleJoin
    const result = await takeRateLimit(`huddle-join:${userId}`, limit.max, limit.windowMs)
    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterSeconds))
      return c.json({ error: { code: 'rate_limited', message: 'Slow down a little and try again in a moment.' } }, 429)
    }
    try {
      return c.json(await joinHuddle(c.req.param('conversationId'), userId))
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.post('/conversations/:conversationId/huddle/leave', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json({ huddle: await leaveHuddle(c.req.param('conversationId'), userId) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.post('/conversations/:conversationId/huddle/decline', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json({ huddle: await declineHuddle(c.req.param('conversationId'), userId) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })
}
