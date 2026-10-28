// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The queue of team-chat wakes waiting behind a live reply.
 *
 * One queue, two views: the thread's queued note and the session's queue dock
 * both read `AgentWake` and both press the same buttons. Nothing here mirrors a
 * wake into `ChatQueuedMessage` — the drain would then have to learn to skip
 * them, and a send-now would have two owners.
 *
 * Mounted under `/api` for both the cloud and desktop composers.
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { loadAccess } from '../services/conversation.service'
import { listPendingAgentWakes, removeAgentWake, sendAgentWakeNow, type AgentWakeResult } from '../services/conversation-agent-dispatcher'
import { loadNamesForTexts, renderMentionsAsText } from '../services/conversation-mentions'

export interface AgentWakeRoutesConfig {
  resolveUserId: (c: any) => Promise<string | null> | string | null
}

const db = prisma as any

export function agentWakeRoutes(config: AgentWakeRoutesConfig): Hono {
  const router = new Hono()

  /** The person behind the call, or the response that says why not. */
  async function requireUser(c: any): Promise<string | Response> {
    const userId = await config.resolveUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    return userId
  }

  /**
   * A wake the caller may act on, with the same rule as the Stop route: the
   * wake must be in a channel they are a member of, and a viewer only reads.
   */
  async function wakeFor(c: any, userId: string): Promise<{ wake: any; role: string } | Response> {
    const wake = await db.agentWake.findUnique({ where: { id: c.req.param('id') } })
    if (!wake) return c.json({ error: { code: 'not_found', message: 'Queued message not found' } }, 404)
    const access = await loadAccess(wake.conversationId, userId).catch(() => null)
    if (!access) return c.json({ error: { code: 'not_found', message: 'Queued message not found' } }, 404)
    if (access.role === 'viewer') {
      return c.json({ error: { code: 'forbidden', message: 'Viewers cannot change a queued message' } }, 403)
    }
    return { wake, role: access.role }
  }

  function answer(c: any, result: AgentWakeResult): Response {
    if (!result.ok) return c.json({ error: { code: result.code, message: result.message } }, result.status)
    return c.json({ ok: true, data: result.wake })
  }

  /**
   * The wakes waiting behind a chat session, for the session's queue dock. Only
   * channels the caller can read are listed, so the dock never shows a message
   * from a channel they are not in.
   */
  router.get('/agent-wakes', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const sessionId = c.req.query('sessionId')
    if (!sessionId) return c.json({ error: { code: 'invalid_input', message: 'Pass sessionId' } }, 400)

    const wakes = await listPendingAgentWakes(sessionId).catch(() => [])
    const out = []
    for (const wake of wakes) {
      const access = await loadAccess(wake.conversationId, userId).catch(() => null)
      if (!access) continue
      const trigger = await db.conversationMessage.findUnique({
        where: { id: wake.triggerMessageId },
        select: { text: true, authorUserId: true },
      })
      const text = trigger?.text ?? ''
      const author = trigger?.authorUserId
        ? await db.user.findUnique({ where: { id: trigger.authorUserId }, select: { name: true } }).catch(() => null)
        : null
      const names = await loadNamesForTexts(db, access.conversation.workspaceId, [text]).catch(() => ({}))
      out.push({
        id: wake.id,
        status: wake.status,
        sendNowAt: wake.sendNowAt,
        createdAt: wake.createdAt,
        conversationId: wake.conversationId,
        threadRootId: wake.threadRootId,
        channelName: access.conversation.name ?? null,
        author: { name: author?.name ?? null },
        text: renderMentionsAsText(text, names),
      })
    }
    return c.json({ wakes: out })
  })

  router.post('/agent-wakes/:id/send-now', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const target = await wakeFor(c, userId)
    if (target instanceof Response) return target
    return answer(c, await sendAgentWakeNow(target.wake.id, userId))
  })

  router.delete('/agent-wakes/:id', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const target = await wakeFor(c, userId)
    if (target instanceof Response) return target
    return answer(c, await removeAgentWake(target.wake.id))
  })

  return router
}
