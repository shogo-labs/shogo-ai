// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Daily-driver channel endpoints: chat settings and status, the activity
 * inbox, pins, saved items, drafts, scheduled messages, reminders, custom
 * emoji, and user groups. Mounted onto the conversations router.
 */

import type { Hono } from 'hono'
import { getChatSettings, listStatuses, updateChatSettings } from '../services/chat-settings'
import { listInbox, markInboxRead } from '../services/chat-inbox'

export interface ExtrasHelpers {
  requireUser: (c: any) => Promise<string | Response>
  requireWorkspace: (c: any) => Promise<{ userId: string; workspaceId: string } | Response>
  errorResponse: (c: any, err: unknown) => Response
  readJson: (c: any) => Promise<Record<string, any>>
}

export function mountConversationExtras(router: Hono, h: ExtrasHelpers): void {
  // ─── Settings + status ──────────────────────────────────────────────────

  router.get('/workspaces/:workspaceId/chat-settings', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    return c.json({ settings: await getChatSettings(auth.workspaceId, auth.userId) })
  })

  router.patch('/workspaces/:workspaceId/chat-settings', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    try {
      return c.json({ settings: await updateChatSettings(auth.workspaceId, auth.userId, await h.readJson(c)) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/statuses', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    const ids = (c.req.query('userIds') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500)
    return c.json({ statuses: await listStatuses(auth.workspaceId, ids.length ? ids : undefined) })
  })

  // ─── Inbox ──────────────────────────────────────────────────────────────

  router.get('/workspaces/:workspaceId/inbox', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    const limit = Number(c.req.query('limit'))
    return c.json(await listInbox(auth.workspaceId, auth.userId, {
      unreadOnly: c.req.query('filter') === 'unread',
      before: c.req.query('before') ?? null,
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    }))
  })

  router.post('/workspaces/:workspaceId/inbox/read', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    const body = await h.readJson(c)
    const updated = await markInboxRead(auth.workspaceId, auth.userId, {
      ids: Array.isArray(body.ids) ? body.ids : undefined,
      all: body.all === true,
      conversationId: typeof body.conversationId === 'string' ? body.conversationId : undefined,
      threadRootId: typeof body.threadRootId === 'string' ? body.threadRootId : undefined,
      unread: body.unread === true,
    })
    return c.json({ updated })
  })
}
