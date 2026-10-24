// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat mentions for the composer (SHO-52).
 *
 *   GET /chat-mentionables  chats the caller can open, in every workspace they
 *                           belong to (the "@" menu's Chats section, chip
 *                           titles, and `ids=` lookups for reloaded messages).
 *   GET /chat-mention-status  per-chat delivery state for a source chip:
 *                           queued, delivered, working, or replied since a
 *                           timestamp. `delivered` is durable — it comes from
 *                           the target's persisted handoff message, so it
 *                           survives dispatch even when the target's turn
 *                           fails and no reply is ever written. Only a chat
 *                           that actually took a handoff in the window is
 *                           reported: a tag in the workspace chat is context,
 *                           not a send (SHO-191), so it has no delivery state.
 *
 * Both are access-checked per chat here, on the server, so a chat the caller
 * cannot open is never offered or described.
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { listChatMentionables, resolveChatForUser } from '../lib/chat-mentionables'

export interface ChatMentionRoutesConfig {
  resolveUserId: (c: any) => Promise<string | null>
}

const ACTIVE_TURN_STALE_AFTER_MS = 10 * 60 * 1000

/**
 * Whether a stored message is a chat handoff. `handOffToChat` puts the origin on
 * the text part because the queue row that carries it is deleted on dispatch and
 * `ChatMessage` has no column for it; every other consumer filters on
 * `type === 'text'` and reads `.text`, so the key is inert there.
 */
function isPersistedHandoff(parts: unknown): boolean {
  let parsed: any = parts
  if (typeof parts === 'string') {
    try {
      parsed = JSON.parse(parts)
    } catch {
      return false
    }
  }
  if (!Array.isArray(parsed)) return false
  return parsed.some((part: any) => {
    const from = part?.handoff?.handoffFromChatId
    return typeof from === 'string' && from.length > 0
  })
}

export function chatMentionRoutes(config: ChatMentionRoutesConfig): Hono {
  const router = new Hono()

  router.get('/chat-mentionables', async (c) => {
    const userId = await config.resolveUserId(c)
    if (!userId) return c.json({ error: 'Authentication required' }, 401)
    const idsParam = c.req.query('ids')
    const ids = idsParam
      ? idsParam.split(',').map((id) => id.trim()).filter(Boolean)
      : undefined
    const chats = await listChatMentionables({
      userId,
      query: c.req.query('q') || c.req.query('query') || '',
      limit: Number(c.req.query('limit') || 12),
      excludeSessionId: c.req.query('exclude') || undefined,
      ids,
    })
    return c.json({ chats })
  })

  router.get('/chat-mention-status', async (c) => {
    const userId = await config.resolveUserId(c)
    if (!userId) return c.json({ error: 'Authentication required' }, 401)
    const ids = (c.req.query('ids') || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 50)
    if (!ids.length) return c.json({ statuses: {} })
    const since = new Date(c.req.query('since') || 0)
    const sinceDate = Number.isNaN(since.getTime()) ? new Date(0) : since

    const accessible: string[] = []
    for (const id of ids) {
      if (await resolveChatForUser(userId, id)) accessible.push(id)
    }
    if (!accessible.length) return c.json({ statuses: {} })

    const [sessions, pending, replies, delivered] = await Promise.all([
      (prisma as any).chatSession.findMany({
        where: { id: { in: accessible } },
        select: { id: true, activeTurnId: true, activeTurnHeartbeatAt: true },
      }),
      (prisma as any).chatQueuedMessage.findMany({
        where: { sessionId: { in: accessible }, status: 'pending' },
        select: { sessionId: true, parts: true },
      }),
      (prisma as any).chatMessage.findMany({
        where: {
          sessionId: { in: accessible },
          role: 'assistant',
          createdAt: { gte: sinceDate },
        },
        orderBy: { createdAt: 'desc' },
        select: { sessionId: true, createdAt: true },
      }),
      (prisma as any).chatMessage.findMany({
        where: {
          sessionId: { in: accessible },
          role: 'user',
          createdAt: { gte: sinceDate },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { sessionId: true, createdAt: true, parts: true },
      }),
    ])

    // A tag is a delivery only where the surface delivers: the workspace chat
    // tags a chat as context and sends nothing to it (SHO-191). So a status is
    // reported only for a chat that actually took a handoff in this window —
    // a queued handoff row, or the persisted handoff message. Anything derived
    // from the chat's own activity (a turn of its own, a reply to someone
    // else) would otherwise read as a delivery that never happened.
    const queued = new Map<string, number>()
    for (const row of pending) {
      if (!isPersistedHandoff(row.parts)) continue
      queued.set(row.sessionId, (queued.get(row.sessionId) ?? 0) + 1)
    }
    const repliedAt = new Map<string, string>()
    for (const row of replies) {
      const id = row.sessionId as string
      if (!repliedAt.has(id)) repliedAt.set(id, new Date(row.createdAt).toISOString())
    }
    // Newest first, so the first handoff row seen per chat is the one that counts.
    const deliveredAt = new Map<string, string>()
    for (const row of delivered) {
      const id = row.sessionId as string
      if (deliveredAt.has(id) || !isPersistedHandoff(row.parts)) continue
      deliveredAt.set(id, new Date(row.createdAt).toISOString())
    }
    const handoffChatIds = new Set<string>([...queued.keys(), ...deliveredAt.keys()])

    const statuses: Record<
      string,
      { queued: number; working: boolean; deliveredAt: string | null; repliedAt: string | null }
    > = {}
    const now = Date.now()
    for (const session of sessions) {
      if (!handoffChatIds.has(session.id)) continue
      const heartbeat = session.activeTurnHeartbeatAt
        ? new Date(session.activeTurnHeartbeatAt).getTime()
        : 0
      const working = Boolean(session.activeTurnId) && heartbeat > now - ACTIVE_TURN_STALE_AFTER_MS
      statuses[session.id] = {
        queued: queued.get(session.id) ?? 0,
        working,
        deliveredAt: deliveredAt.get(session.id) ?? null,
        repliedAt: repliedAt.get(session.id) ?? null,
      }
    }
    return c.json({ statuses })
  })

  return router
}
